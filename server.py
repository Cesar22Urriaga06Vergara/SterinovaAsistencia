from __future__ import annotations

import base64
import calendar
import io
import json
import mimetypes
import os
import secrets
import traceback
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from http.cookies import CookieError, SimpleCookie
from pathlib import Path
from threading import Lock, RLock
from time import monotonic
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

import pandas as pd

from core.asignaciones import fechas_por_patron, resumir_patron
from core.comparador import comparar
from core.exportador import (
    exportar_auditoria_no_programados,
    exportar_comparativo,
    exportar_reporte_novedades,
    generar_hoja_turnos,
    generar_hojas_turnos,
)
from core.festivos import festivos_colombia
from core.metricas import (
    alerta_programacion_requerida,
    calcular_metricas,
    construir_reporte_novedades,
    filtrar_detalle,
    filtrar_por_kpi,
)
from core.normalizador import normalizar_huellero
from core.procesamiento_lotes import normalizar_lote
from core.rutas import directorio_aplicacion, directorio_datos
from db import Database
from models import Asignacion, Turno


BASE_DIR = directorio_aplicacion()
DATA_DIR = directorio_datos()
REPORTS_DIR = DATA_DIR / "reportes_web"
UPLOADS_DIR = DATA_DIR / "uploads_huellero"
PUBLIC_DIR = BASE_DIR / "public"
SESSION_COOKIE = "sterinova_session"
SESSION_SECONDS = 8 * 60 * 60
SESSIONS: dict[str, tuple[float, dict[str, Any]]] = {}
SESSION_LOCK = Lock()
DB_LOCK = RLock()

REPORTS_DIR.mkdir(parents=True, exist_ok=True)
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

DB = Database(DATA_DIR / "asistencia.db")
DB.initialize()


def _cargar_ultimo_detalle() -> pd.DataFrame:
    """Carga el histórico permanente de métricas desde SQLite (nunca se pierde al limpiar Excel)."""
    try:
        filas = DB.listar_historico_metricas()
        if filas:
            df = pd.DataFrame(filas)
            df["fecha"] = pd.to_datetime(df["fecha"], errors="coerce")
            return df
    except Exception:
        pass
    ruta = DATA_DIR / "ultimo_detalle.pkl"
    if ruta.is_file():
        try:
            df = pd.read_pickle(ruta)
            if isinstance(df, pd.DataFrame) and not df.empty:
                return df
        except Exception:
            pass
    return pd.DataFrame()


def _guardar_ultimo_detalle(df: pd.DataFrame) -> None:
    """Persiste los cálculos en historico_metricas (SQLite) para que Admin General y Auditor nunca pierdan datos."""
    if df is None or df.empty:
        return
    try:
        filas_sql = []
        for _, r in df.iterrows():
            f_dt = pd.to_datetime(r.get("fecha"), errors="coerce")
            fecha_str = f_dt.strftime("%Y-%m-%d") if pd.notna(f_dt) else str(r.get("fecha", ""))[:10]
            ent_teo = pd.to_datetime(r.get("hora_entrada_teorica"), errors="coerce")
            sal_teo = pd.to_datetime(r.get("hora_salida_teorica"), errors="coerce")
            ent_real = pd.to_datetime(r.get("hora_entrada_real"), errors="coerce")
            sal_real = pd.to_datetime(r.get("hora_salida_real"), errors="coerce")
            filas_sql.append(
                {
                    "id_empleado": str(r.get("id_empleado", "")).strip(),
                    "fecha": fecha_str,
                    "turno": str(r.get("turno", "") or ""),
                    "hora_entrada_teorica": ent_teo.strftime("%Y-%m-%d %H:%M") if pd.notna(ent_teo) else str(r.get("hora_entrada_teorica", "") or ""),
                    "hora_salida_teorica": sal_teo.strftime("%Y-%m-%d %H:%M") if pd.notna(sal_teo) else str(r.get("hora_salida_teorica", "") or ""),
                    "hora_entrada_real": ent_real.strftime("%Y-%m-%d %H:%M") if pd.notna(ent_real) else str(r.get("hora_entrada_real", "") or ""),
                    "hora_salida_real": sal_real.strftime("%Y-%m-%d %H:%M") if pd.notna(sal_real) else str(r.get("hora_salida_real", "") or ""),
                    "horas_trabajadas": float(r.get("horas_trabajadas", 0) or 0),
                    "horas_extra": float(r.get("horas_extra", 0) or 0),
                    "ED": float(r.get("ED", 0) or 0),
                    "EN": float(r.get("EN", 0) or 0),
                    "EF": float(r.get("EF", 0) or 0),
                    "END": float(r.get("END", 0) or 0),
                    "RN": float(r.get("RN", 0) or 0),
                    "RND": float(r.get("RND", 0) or 0),
                    "RF": float(r.get("RF", 0) or 0),
                    "minutos_tardanza": int(r.get("minutos_tardanza", 0) or 0),
                    "estado": str(r.get("estado", "") or ""),
                    "observaciones": str(r.get("observaciones", "") or ""),
                }
            )
        DB.guardar_historico_metricas(filas_sql)
    except Exception:
        pass
    ruta = DATA_DIR / "ultimo_detalle.pkl"
    try:
        df.to_pickle(ruta)
    except Exception:
        pass


def _resumen_directorio(carpeta: Path) -> tuple[int, float]:
    if not carpeta.is_dir():
        return 0, 0.0
    archivos = [f for f in carpeta.iterdir() if f.is_file()]
    total_bytes = sum(f.stat().st_size for f in archivos)
    return len(archivos), round(total_bytes / (1024 * 1024), 2)


def _combinar_marcaciones_con_moviles(
    marcaciones_excel: pd.DataFrame,
    fecha_inicio: date | None = None,
    fecha_fin: date | None = None,
) -> pd.DataFrame:
    """Combina las marcaciones del archivo Excel del huellero con las marcaciones hechas desde la App Móvil."""
    moviles = DB.listar_marcaciones_moviles(fecha_inicio=fecha_inicio, fecha_fin=fecha_fin)
    nombres_map = dict(DB.listar_empleados())
    registros_moviles = []
    for item in moviles:
        try:
            dt = pd.to_datetime(item["fecha_hora"])
            emp_id = str(item["id_empleado"]).strip()
            registros_moviles.append(
                {
                    "id_empleado": emp_id,
                    "nombre": nombres_map.get(emp_id, item.get("nombre_empleado", emp_id)),
                    "fecha": pd.Timestamp(dt.date()),
                    "hora": dt.time(),
                    "fecha_hora": dt.to_pydatetime(),
                }
            )
        except Exception:
            continue

    df_movil = pd.DataFrame(
        registros_moviles,
        columns=["id_empleado", "nombre", "fecha", "hora", "fecha_hora"],
    )
    if marcaciones_excel is None or marcaciones_excel.empty:
        return df_movil
    if df_movil.empty:
        return marcaciones_excel
    combinado = pd.concat([marcaciones_excel, df_movil], ignore_index=True)
    combinado = combinado.sort_values(["id_empleado", "fecha_hora"]).reset_index(drop=True)
    return combinado


def _serializar_fila_detalle(fila: dict, nombres_por_id: dict[str, str]) -> dict[str, Any]:
    emp_id = str(fila.get("id_empleado", "")).strip()
    fecha_val = pd.to_datetime(fila.get("fecha"), errors="coerce")
    ent_teo = pd.to_datetime(fila.get("hora_entrada_teorica"), errors="coerce")
    sal_teo = pd.to_datetime(fila.get("hora_salida_teorica"), errors="coerce")
    ent_real = pd.to_datetime(fila.get("hora_entrada_real"), errors="coerce")
    sal_real = pd.to_datetime(fila.get("hora_salida_real"), errors="coerce")

    anticipacion = 0
    if pd.notna(ent_real) and pd.notna(ent_teo) and ent_real < ent_teo:
        anticipacion = int((ent_teo - ent_real).total_seconds() // 60)

    def _num(key: str) -> float:
        val = pd.to_numeric(fila.get(key, 0), errors="coerce")
        return round(float(val), 2) if pd.notna(val) else 0.0

    desglose_partes = []
    for k in ("ED", "EN", "EF", "END", "RN", "RND", "RF"):
        v = _num(k)
        if v > 0:
            desglose_partes.append(f"{k}: {v:.2f}")

    return {
        "id_empleado": emp_id,
        "nombre_empleado": nombres_por_id.get(emp_id, str(fila.get("nombre_empleado") or emp_id)),
        "fecha": fecha_val.strftime("%Y-%m-%d") if pd.notna(fecha_val) else "",
        "turno": str(fila.get("turno") or ""),
        "hora_entrada_teorica": ent_teo.strftime("%H:%M") if pd.notna(ent_teo) else "",
        "hora_salida_teorica": sal_teo.strftime("%H:%M") if pd.notna(sal_teo) else "",
        "hora_entrada_real": ent_real.strftime("%H:%M") if pd.notna(ent_real) else "",
        "hora_salida_real": sal_real.strftime("%H:%M") if pd.notna(sal_real) else "",
        "minutos_anticipacion": anticipacion,
        "minutos_tardanza": int(_num("minutos_tardanza")),
        "minutos_salida_anticipada": int(_num("minutos_salida_anticipada")),
        "horas_trabajadas": _num("horas_trabajadas"),
        "horas_normales": _num("horas_normales"),
        "horas_extra": _num("horas_extra"),
        "horas_nocturnas": _num("horas_nocturnas"),
        "ED": _num("ED"),
        "EN": _num("EN"),
        "EF": _num("EF"),
        "END": _num("END"),
        "RN": _num("RN"),
        "RND": _num("RND"),
        "RF": _num("RF"),
        "desglose": " | ".join(desglose_partes) if desglose_partes else "—",
        "estado": str(fila.get("estado") or ""),
        "observaciones": str(fila.get("observaciones") or ""),
    }


def _obtener_detalle_activo(
    fecha_inicio: date | None = None,
    fecha_fin: date | None = None,
) -> pd.DataFrame:
    """Fusiona el histórico permanente de métricas con cualquier marcación móvil reciente sin perder histórico."""
    df = _cargar_ultimo_detalle()
    moviles = DB.listar_marcaciones_moviles(fecha_inicio=fecha_inicio, fecha_fin=fecha_fin)
    if df.empty or moviles:
        try:
            marcas = _combinar_marcaciones_con_moviles(pd.DataFrame(), fecha_inicio, fecha_fin)
            if not marcas.empty:
                f_min = marcas["fecha"].min().date()
                f_max = marcas["fecha"].max().date()
                ids_mov = set(marcas["id_empleado"].astype(str).str.strip())
                calculado = comparar(
                    DB,
                    marcas,
                    fecha_inicio=fecha_inicio or f_min,
                    fecha_fin=fecha_fin or f_max,
                    ids_empleados=ids_mov,
                )
                if df.empty:
                    return calculado
                if not calculado.empty:
                    df_copy = df.copy()
                    calc_copy = calculado.copy()
                    df_copy["_k"] = (
                        df_copy["id_empleado"].astype(str).str.strip()
                        + "|"
                        + pd.to_datetime(df_copy["fecha"], errors="coerce").dt.strftime("%Y-%m-%d").fillna("")
                    )
                    calc_copy["_k"] = (
                        calc_copy["id_empleado"].astype(str).str.strip()
                        + "|"
                        + pd.to_datetime(calc_copy["fecha"], errors="coerce").dt.strftime("%Y-%m-%d").fillna("")
                    )
                    keys_calc = set(calc_copy["_k"])
                    resto = df_copy.loc[~df_copy["_k"].isin(keys_calc)].drop(columns=["_k"])
                    fusionado = pd.concat([resto, calc_copy.drop(columns=["_k"])], ignore_index=True)
                    return fusionado
        except Exception:
            pass
    return df


class NominaAPIHandler(BaseHTTPRequestHandler):
    server_version = "SterinovaNominaHTTP/2.0"

    def log_message(self, format: str, *args: Any) -> None:
        # Log limpio en consola
        print(f"[API] {self.address_string()} - {format % args}")

    def _send_cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._send_cors()
        self.end_headers()

    def _json_response(self, data: Any, status: int = 200, cookie: str | None = None) -> None:
        payload = json.dumps(data, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(status)
        self._send_cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        if cookie is not None:
            self.send_header("Set-Cookie", cookie)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _error_response(self, message: str, status: int = 400) -> None:
        self._json_response({"ok": False, "error": message}, status=status)

    def _session_token(self) -> str:
        try:
            cookie = SimpleCookie(self.headers.get("Cookie", ""))
            return cookie[SESSION_COOKIE].value if SESSION_COOKIE in cookie else ""
        except CookieError:
            return ""

    def _session_user(self) -> dict[str, Any] | None:
        token = self._session_token()
        with SESSION_LOCK:
            session = SESSIONS.get(token)
            if session is None:
                return None
            expires, user = session
            if expires <= monotonic():
                del SESSIONS[token]
                return None
            return user

    def _session_cookie(self, token: str, max_age: int) -> str:
        secure = (
            os.environ.get("SESSION_COOKIE_SECURE") == "1"
            or self.headers.get("X-Forwarded-Proto", "").strip().lower() == "https"
        )
        cookie = f"{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}"
        return f"{cookie}; Secure" if secure else cookie

    def _require_roles(self, user: dict[str, Any] | None, allowed: tuple[str, ...]) -> bool:
        if user is None:
            self._error_response("La sesión no está activa.", 401)
            return False
        if user.get("role") not in allowed:
            self._error_response("No tienes permisos para realizar esta acción.", 403)
            return False
        return True

    def _effective_area(self, user: dict[str, Any], requested_area: Any) -> int | None:
        """Fuerza el área del usuario si es supervisor; otros roles pueden filtrar libremente."""
        if user.get("role") == "supervisor":
            return int(user["id_area"]) if user.get("id_area") else None
        return int(requested_area) if requested_area and str(requested_area).isdigit() else None

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def _serve_file(self, filepath: Path, download_name: str | None = None) -> None:
        if not filepath.is_file():
            self._error_response("Archivo no encontrado", 404)
            return
        content = filepath.read_bytes()
        mime, _ = mimetypes.guess_type(str(filepath))
        if filepath.suffix.lower() == ".webmanifest":
            mime = "application/manifest+json"
        elif filepath.suffix.lower() == ".js":
            mime = "application/javascript; charset=utf-8"
        elif filepath.suffix.lower() == ".css":
            mime = "text/css; charset=utf-8"
        elif filepath.suffix.lower() == ".html":
            mime = "text/html; charset=utf-8"
        self.send_response(200)
        self._send_cors()
        self.send_header("Content-Type", mime or "application/octet-stream")
        if download_name:
            self.send_header("Cache-Control", "no-store")
            self.send_header(
                "Content-Disposition",
                f'attachment; filename="{download_name}"',
            )
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        query = parse_qs(parsed.query)

        try:
            if path.startswith("/api/") and path not in ("/api/branding/logo", "/api/branding/icon"):
                user = self._session_user()
                if user is None:
                    self._error_response("La sesión no está activa.", 401)
                    return
                if path == "/api/sesion":
                    self._json_response({"ok": True, "user": user})
                    return

            # --- Archivos estáticos y recursos ---
            if path == "/api/branding/logo":
                self._serve_file(DATA_DIR / "logo.png")
                return
            if path == "/api/branding/icon":
                self._serve_file(DATA_DIR / "icono.ico")
                return
            if path.startswith("/api/reportes/descargar/"):
                filename = Path(path.replace("/api/reportes/descargar/", "")).name
                self._serve_file(REPORTS_DIR / filename, download_name=filename)
                return

            # --- Endpoints API ---
            if path == "/api/dashboard":
                resumen = DB.obtener_resumen_dashboard()
                ultima = resumen["ultima_fecha_asignada"]
                alerta = alerta_programacion_requerida(ultima)
                if not alerta:
                    mensaje_alerta = "Programación de turnos al día."
                    nivel_alerta = "ok"
                elif ultima is None:
                    mensaje_alerta = "¡Atención! No hay turnos asignados. Vaya a Asignación de Turnos para programar el siguiente período."
                    nivel_alerta = "danger"
                elif (ultima - date.today()).days < 0:
                    mensaje_alerta = "¡Atención! La programación ya venció. Vaya a Asignación de Turnos para programar los siguientes turnos."
                    nivel_alerta = "danger"
                else:
                    mensaje_alerta = "¡Atención! Quedan pocos días de turnos asignados. Vaya a Asignación de Turnos para programar el siguiente período."
                    nivel_alerta = "warning"

                detalle = _cargar_ultimo_detalle()
                kpis = calcular_metricas(detalle)
                solicitudes = DB.listar_solicitudes()
                pendientes = sum(1 for s in solicitudes if s["estado"] in ("PENDIENTE", "PENDIENTE_SUPERVISOR", "AVALADO_SUPERVISOR"))
                marcaciones_hoy = DB.listar_marcaciones_moviles(
                    fecha_inicio=date.today(), fecha_fin=date.today()
                )
                self._json_response(
                    {
                        "ok": True,
                        "total_empleados": resumen["total_empleados"],
                        "total_turnos": resumen["total_turnos"],
                        "total_areas": len(DB.listar_areas()),
                        "ultima_fecha_asignada": ultima.isoformat() if ultima else None,
                        "alerta_requerida": alerta,
                        "mensaje_alerta": mensaje_alerta,
                        "nivel_alerta": nivel_alerta,
                        "kpis": kpis,
                        "solicitudes_pendientes": pendientes,
                        "marcaciones_moviles_hoy": len(marcaciones_hoy),
                        "total_festivos": len(DB.listar_dias_festivos()),
                    }
                )
                return

            if path == "/api/areas":
                self._json_response({"ok": True, "areas": DB.listar_areas()})
                return

            if path == "/api/sistema/almacenamiento":
                if not self._require_roles(user, ("superadmin",)):
                    return
                with DB_LOCK:
                    db_path = DATA_DIR / "asistencia.db"
                    db_mb = round(db_path.stat().st_size / (1024 * 1024), 2) if db_path.is_file() else 0.0
                    rep_count, rep_mb = _resumen_directorio(REPORTS_DIR)
                    upl_count, upl_mb = _resumen_directorio(UPLOADS_DIR)
                    stats_bd = DB.estadisticas_bd()
                self._json_response(
                    {
                        "ok": True,
                        "db_mb": db_mb,
                        "reportes_count": rep_count,
                        "reportes_mb": rep_mb,
                        "uploads_count": upl_count,
                        "uploads_mb": upl_mb,
                        "total_metricas": stats_bd["total_metricas"],
                        "total_selfies": stats_bd.get("total_selfies", 0),
                        "mb_selfies": stats_bd.get("mb_selfies", 0.0),
                        "total_notifs_leidas": stats_bd["total_notifs_leidas"],
                    }
                )
                return

            if path == "/api/turnos":
                id_area = self._effective_area(user, query.get("id_area", [None])[0])
                turnos = DB.listar_turnos_detallado(id_area=id_area, incluir_globales=True)
                self._json_response(
                    {
                        "ok": True,
                        "turnos": [
                            {
                                "id": t["id"],
                                "nombre": t["nombre"],
                                "hora_entrada": t["hora_entrada"],
                                "hora_salida": t["hora_salida"],
                                "tolerancia_min": t["tolerancia_min"],
                                "descanso_min": t["descanso_min"],
                                "cruza_medianoche": bool(t["cruza_medianoche"]),
                                "recargo_nocturno_pct": t["recargo_nocturno_pct"],
                                "activo": bool(t["activo"]),
                                "id_area": t.get("id_area"),
                                "nombre_area": t.get("nombre_area", "Global"),
                            }
                            for t in turnos
                        ],
                    }
                )
                return

            if path == "/api/festivos":
                festivos = DB.listar_dias_festivos()
                self._json_response(
                    {
                        "ok": True,
                        "festivos": [
                            {"fecha": f.isoformat(), "descripcion": desc}
                            for f, desc in festivos
                        ],
                    }
                )
                return

            if path == "/api/empleados":
                id_area_q = query.get("id_area", [None])[0]
                id_area = int(id_area_q) if id_area_q and str(id_area_q).isdigit() else None
                empleados = DB.listar_empleados_detallado(id_area=id_area)
                self._json_response({"ok": True, "empleados": empleados})
                return

            if path == "/api/asignaciones":
                id_empleado = query.get("id_empleado", [None])[0]
                mes_str = query.get("mes", [None])[0]
                f_ini_str = query.get("fecha_inicio", [None])[0]
                f_fin_str = query.get("fecha_fin", [None])[0]

                if mes_str and not f_ini_str:
                    anio, mes = [int(x) for x in mes_str.split("-")]
                    f_ini = date(anio, mes, 1)
                    f_fin = date(anio, mes, calendar.monthrange(anio, mes)[1])
                else:
                    f_ini = date.fromisoformat(f_ini_str) if f_ini_str else None
                    f_fin = date.fromisoformat(f_fin_str) if f_fin_str else None

                asignaciones = DB.listar_asignaciones(
                    id_empleado=id_empleado or None,
                    fecha_inicio=f_ini,
                    fecha_fin=f_fin,
                )
                turnos_map = {t.id: t for t in DB.listar_turnos(incluir_inactivos=True)}
                empleados_map = dict(DB.listar_empleados())
                self._json_response(
                    {
                        "ok": True,
                        "asignaciones": [
                            {
                                "id": a.id,
                                "id_empleado": a.id_empleado,
                                "nombre_empleado": empleados_map.get(a.id_empleado, a.id_empleado),
                                "fecha": a.fecha.isoformat(),
                                "id_turno": a.id_turno,
                                "nombre_turno": (
                                    "DESCANSO"
                                    if a.es_descanso
                                    else (turnos_map[a.id_turno].nombre if a.id_turno in turnos_map else "Sin turno")
                                ),
                                "hora_entrada": (
                                    turnos_map[a.id_turno].hora_entrada
                                    if (not a.es_descanso and a.id_turno in turnos_map)
                                    else ""
                                ),
                                "hora_salida": (
                                    turnos_map[a.id_turno].hora_salida
                                    if (not a.es_descanso and a.id_turno in turnos_map)
                                    else ""
                                ),
                                "es_descanso": a.es_descanso,
                                "observaciones": a.observaciones,
                            }
                            for a in asignaciones
                        ],
                    }
                )
                return

            if path == "/api/analisis":
                id_empleado = query.get("id_empleado", [None])[0]
                id_area_q = query.get("id_area", [None])[0]
                id_area = int(id_area_q) if id_area_q and str(id_area_q).isdigit() else None
                turno = query.get("turno", [None])[0]
                f_ini_str = query.get("fecha_inicio", [None])[0]
                f_fin_str = query.get("fecha_fin", [None])[0]
                kpi = query.get("kpi", [None])[0]

                f_ini = date.fromisoformat(f_ini_str) if f_ini_str else None
                f_fin = date.fromisoformat(f_fin_str) if f_fin_str else None

                detalle = _obtener_detalle_activo(f_ini, f_fin)
                empleados_det = DB.listar_empleados_detallado()
                nombres_por_id = {str(e["id_empleado"]).strip(): e["nombre"] for e in empleados_det}
                areas_por_id = {str(e["id_empleado"]).strip(): (e.get("id_area"), e.get("nombre_area", "Sin Área")) for e in empleados_det}

                if detalle.empty:
                    self._json_response(
                        {
                            "ok": True,
                            "kpis": {"horas_extra": 0.0, "minutos_tardanza": 0, "ausencias": 0, "llegadas_tempranas": 0},
                            "filas": [],
                            "turnos_disponibles": [],
                            "rango_fechas": {"inicio": "", "fin": ""},
                        }
                    )
                    return

                if id_area is not None:
                    ids_area = {str(e["id_empleado"]).strip() for e in empleados_det if e.get("id_area") == id_area}
                    detalle = detalle.loc[detalle["id_empleado"].astype(str).str.strip().isin(ids_area)].copy()

                turnos_disp = sorted(
                    str(v) for v in detalle.get("turno", pd.Series(dtype=object)).dropna().unique()
                )
                fechas_col = pd.to_datetime(detalle["fecha"], errors="coerce").dropna().dt.date if not detalle.empty else pd.Series(dtype=object)
                rango = {
                    "inicio": min(fechas_col).isoformat() if not fechas_col.empty else "",
                    "fin": max(fechas_col).isoformat() if not fechas_col.empty else "",
                }

                filtrado_base = filtrar_detalle(
                    detalle,
                    fecha_inicio=f_ini,
                    fecha_fin=f_fin,
                    id_empleado=id_empleado if id_empleado and id_empleado != "TODOS" else None,
                    turno=turno if turno and turno != "TODOS" else None,
                )
                kpis = calcular_metricas(filtrado_base)
                filtrado_final = filtrar_por_kpi(filtrado_base, kpi if kpi else None)

                filas = []
                for _, row in filtrado_final.iterrows():
                    s_row = _serializar_fila_detalle(row.to_dict(), nombres_por_id)
                    emp_area_id, emp_area_nom = areas_por_id.get(s_row["id_empleado"], (None, "Sin Área"))
                    s_row["id_area"] = emp_area_id
                    s_row["nombre_area"] = emp_area_nom
                    filas.append(s_row)

                self._json_response(
                    {
                        "ok": True,
                        "kpis": kpis,
                        "filas": filas,
                        "turnos_disponibles": turnos_disp,
                        "rango_fechas": rango,
                    }
                )
                return

            if path == "/api/marcaciones-moviles":
                id_empleado = query.get("id_empleado", [None])[0]
                if user.get("role") == "empleado":
                    id_empleado = str(user.get("id", "")).strip()
                id_area = self._effective_area(user, query.get("id_area", [None])[0])
                marcaciones = DB.listar_marcaciones_moviles(id_empleado=id_empleado or None, id_area=id_area)
                self._json_response({"ok": True, "marcaciones": marcaciones})
                return

            if path == "/api/solicitudes":
                id_empleado = query.get("id_empleado", [None])[0]
                if user.get("role") == "empleado":
                    id_empleado = str(user.get("id", "")).strip()
                id_area = self._effective_area(user, query.get("id_area", [None])[0])
                solicitudes = DB.listar_solicitudes(id_empleado=id_empleado or None, id_area=id_area)
                self._json_response({"ok": True, "solicitudes": solicitudes})
                return

            if path == "/api/comunicados":
                id_empleado = query.get("id_empleado", [None])[0]
                id_area_q = query.get("id_area", [None])[0]
                id_area = int(id_area_q) if id_area_q and str(id_area_q).isdigit() else None
                comunicados = DB.listar_comunicados(id_empleado=id_empleado or None, id_area=id_area)
                self._json_response({"ok": True, "comunicados": comunicados})
                return

            if path == "/api/notificaciones":
                rol = query.get("rol", [""])[0]
                user_id = query.get("user_id", [""])[0]
                id_area_q = query.get("id_area", [None])[0]
                id_area = int(id_area_q) if id_area_q and str(id_area_q).isdigit() else None
                notifs = DB.listar_notificaciones_para_usuario(rol, user_id, id_area=id_area)
                self._json_response(
                    {
                        "ok": True,
                        "notificaciones": notifs,
                        "no_leidas": sum(1 for n in notifs if not n.get("leida")),
                    }
                )
                return

            if path == "/api/usuarios":
                if not self._require_roles(user, ("superadmin", "admin")):
                    return
                usuarios = DB.listar_usuarios_sistema()
                self._json_response({"ok": True, "usuarios": usuarios})
                return

            if path == "/api/reportes":
                archivos = sorted(
                    REPORTS_DIR.glob("*.xlsx"),
                    key=lambda p: p.stat().st_mtime,
                    reverse=True,
                )
                self._json_response(
                    {
                        "ok": True,
                        "reportes": [
                            {
                                "nombre": a.name,
                                "tamano_kb": round(a.stat().st_size / 1024, 1),
                                "fecha": datetime.fromtimestamp(a.stat().st_mtime).strftime("%Y-%m-%d %H:%M"),
                                "url": f"/api/reportes/descargar/{a.name}",
                            }
                            for a in archivos
                        ],
                    }
                )
                return

            if path == "/api/empleado/resumen":
                id_empleado = query.get("id_empleado", [""])[0].strip()
                if user.get("role") == "empleado":
                    id_empleado = str(user.get("id", "")).strip()
                if not id_empleado:
                    self._error_response("Falta id_empleado")
                    return
                hoy = date.today()
                asignaciones = DB.listar_asignaciones(id_empleado=id_empleado)
                turnos_map = {t.id: t for t in DB.listar_turnos(incluir_inactivos=True)}
                turno_hoy = None
                proximos_turnos = []
                for a in asignaciones:
                    t_obj = turnos_map.get(a.id_turno)
                    info = {
                        "fecha": a.fecha.isoformat(),
                        "es_descanso": a.es_descanso,
                        "id_turno": a.id_turno,
                        "nombre_turno": "DESCANSO" if a.es_descanso else (t_obj.nombre if t_obj else "Sin turno"),
                        "hora_entrada": "" if a.es_descanso or not t_obj else t_obj.hora_entrada,
                        "hora_salida": "" if a.es_descanso or not t_obj else t_obj.hora_salida,
                        "observaciones": a.observaciones,
                    }
                    if a.fecha == hoy:
                        turno_hoy = info
                    if a.fecha >= hoy:
                        proximos_turnos.append(info)

                detalle = _obtener_detalle_activo()
                nombres_por_id = dict(DB.listar_empleados())
                detalle_emp = filtrar_detalle(detalle, id_empleado=id_empleado) if not detalle.empty else pd.DataFrame()
                kpis_emp = calcular_metricas(detalle_emp)
                historial = [
                    _serializar_fila_detalle(row.to_dict(), nombres_por_id)
                    for _, row in detalle_emp.iterrows()
                ]
                marcaciones_moviles = DB.listar_marcaciones_moviles(id_empleado=id_empleado)
                solicitudes = DB.listar_solicitudes(id_empleado=id_empleado)
                emp_det = next(
                    (e for e in DB.listar_empleados_detallado() if str(e["id_empleado"]).strip() == id_empleado),
                    {},
                )
                id_area_emp = emp_det.get("id_area")
                comunicados = DB.listar_comunicados(id_empleado=id_empleado, id_area=id_area_emp)
                notificaciones = DB.listar_notificaciones_para_usuario("empleado", id_empleado, id_area=id_area_emp)

                self._json_response(
                    {
                        "ok": True,
                        "hoy": hoy.isoformat(),
                        "id_area": id_area_emp,
                        "nombre_area": emp_det.get("nombre_area", "Sin Área"),
                        "turno_hoy": turno_hoy,
                        "proximos_turnos": proximos_turnos[:15],
                        "asignaciones": [
                            {
                                "fecha": a.fecha.isoformat(),
                                "es_descanso": a.es_descanso,
                                "id_turno": a.id_turno,
                                "nombre_turno": "DESCANSO" if a.es_descanso else (turnos_map[a.id_turno].nombre if a.id_turno in turnos_map else "Sin turno"),
                                "hora_entrada": "" if a.es_descanso or a.id_turno not in turnos_map else turnos_map[a.id_turno].hora_entrada,
                                "hora_salida": "" if a.es_descanso or a.id_turno not in turnos_map else turnos_map[a.id_turno].hora_salida,
                                "observaciones": a.observaciones,
                            }
                            for a in asignaciones
                        ],
                        "kpis": kpis_emp,
                        "historial": historial,
                        "marcaciones_moviles": marcaciones_moviles[:20],
                        "solicitudes": solicitudes,
                        "comunicados": comunicados,
                        "notificaciones": notificaciones,
                    }
                )
                return

            # --- Servir Frontend SPA (public/) ---
            if path == "/" or path == "":
                self._serve_file(PUBLIC_DIR / "index.html")
                return
            candidate = (PUBLIC_DIR / path.lstrip("/")).resolve()
            if str(candidate).startswith(str(PUBLIC_DIR.resolve())) and candidate.is_file():
                self._serve_file(candidate)
                return
            # Fallback SPA
            self._serve_file(PUBLIC_DIR / "index.html")

        except Exception as error:
            traceback.print_exc()
            self._error_response(f"Error interno: {error}", 500)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        try:
            if path == "/api/logout":
                with SESSION_LOCK:
                    SESSIONS.pop(self._session_token(), None)
                self._json_response({"ok": True}, cookie=self._session_cookie("", 0))
                return

            session_user = self._session_user()
            if path != "/api/login" and session_user is None:
                self._error_response("La sesión no está activa.", 401)
                return

            if path == "/api/login" and self.headers.get_content_type() != "application/json":
                self._error_response("El ingreso requiere un cuerpo JSON.", 415)
                return
            body = self._read_json()

            if path == "/api/login":
                identificador = str(
                    body.get("identificador") or body.get("username") or body.get("id_empleado") or ""
                ).strip()
                clave = str(
                    body.get("clave") or body.get("password") or body.get("pin") or ""
                ).strip()
                user = DB.autenticar_unificado(identificador, clave)
                if not user:
                    self._error_response("Usuario/ID o contraseña/PIN incorrectos.", 401)
                    return
                token = secrets.token_urlsafe(32)
                now = monotonic()
                with SESSION_LOCK:
                    expired = [key for key, (expires, _) in SESSIONS.items() if expires <= now]
                    for key in expired:
                        del SESSIONS[key]
                    SESSIONS.pop(self._session_token(), None)
                    SESSIONS[token] = (now + SESSION_SECONDS, user)
                self._json_response(
                    {"ok": True, "user": user},
                    cookie=self._session_cookie(token, SESSION_SECONDS),
                )
                return

            if path == "/api/areas":
                if not self._require_roles(session_user, ("superadmin",)):
                    return
                nombre = str(body.get("nombre", "")).strip()
                descripcion = str(body.get("descripcion", "")).strip()
                area_id = int(body["id"]) if body.get("id") else None
                with DB_LOCK:
                    new_id = DB.guardar_area(nombre, descripcion, area_id=area_id)
                self._json_response({"ok": True, "id": new_id})
                return

            if path == "/api/areas/eliminar":
                if not self._require_roles(session_user, ("superadmin",)):
                    return
                area_id = int(body.get("id", 0))
                with DB_LOCK:
                    DB.eliminar_area(area_id)
                self._json_response({"ok": True})
                return

            if path == "/api/usuarios":
                if not self._require_roles(session_user, ("superadmin",)):
                    return
                username = str(body.get("username", "")).strip()
                password = str(body.get("password", "")).strip()
                nombre = str(body.get("nombre", "")).strip()
                rol = str(body.get("rol", "admin")).strip().lower()
                id_area_raw = body.get("id_area")
                id_area = int(id_area_raw) if id_area_raw and str(id_area_raw).isdigit() else None
                with DB_LOCK:
                    DB.guardar_usuario_sistema(username, password, nombre, rol, id_area=id_area)
                self._json_response({"ok": True})
                return

            if path == "/api/usuarios/eliminar":
                if not self._require_roles(session_user, ("superadmin",)):
                    return
                username = str(body.get("username", "")).strip()
                with DB_LOCK:
                    DB.eliminar_usuario_sistema(username)
                self._json_response({"ok": True})
                return

            if path == "/api/turnos":
                if not self._require_roles(session_user, ("superadmin", "supervisor", "talento_humano")):
                    return
                nombre = str(body.get("nombre", "")).strip()
                hora_entrada = str(body.get("hora_entrada", "")).strip()
                hora_salida = str(body.get("hora_salida", "")).strip()
                if not nombre or not hora_entrada or not hora_salida:
                    self._error_response("Nombre, hora de entrada y hora de salida son obligatorios.")
                    return
                id_area = self._effective_area(session_user, body.get("id_area"))
                turno = Turno(
                    id=int(body["id"]) if body.get("id") else None,
                    nombre=nombre,
                    hora_entrada=hora_entrada,
                    hora_salida=hora_salida,
                    tolerancia_min=int(body.get("tolerancia_min", 10) or 0),
                    descanso_min=int(body.get("descanso_min", 0) or 0),
                    cruza_medianoche=bool(hora_salida < hora_entrada),
                    recargo_nocturno_pct=float(body.get("recargo_nocturno_pct", 0) or 0),
                    activo=bool(body.get("activo", True)),
                )
                with DB_LOCK:
                    turno_id = DB.guardar_turno_con_area(turno, id_area=id_area)
                self._json_response({"ok": True, "id": turno_id})
                return

            if path == "/api/turnos/eliminar":
                if not self._require_roles(session_user, ("superadmin", "supervisor", "talento_humano")):
                    return
                turno_id = int(body.get("id", 0))
                with DB_LOCK:
                    DB.eliminar_turno(turno_id)
                self._json_response({"ok": True})
                return

            if path == "/api/festivos":
                if not self._require_roles(session_user, ("superadmin", "talento_humano")):
                    return
                fecha = date.fromisoformat(str(body.get("fecha", "")).strip())
                descripcion = str(body.get("descripcion", "")).strip()
                with DB_LOCK:
                    DB.guardar_dia_festivo(fecha, descripcion)
                self._json_response({"ok": True})
                return

            if path == "/api/festivos/cargar-colombia":
                if not self._require_roles(session_user, ("superadmin", "talento_humano")):
                    return
                anio = int(body.get("anio", date.today().year))
                dias = festivos_colombia(anio)
                with DB_LOCK:
                    cantidad = DB.guardar_dias_festivos(dias)
                self._json_response({"ok": True, "cantidad": cantidad, "anio": anio})
                return

            if path == "/api/festivos/eliminar":
                if not self._require_roles(session_user, ("superadmin", "talento_humano")):
                    return
                fecha = date.fromisoformat(str(body.get("fecha", "")).strip())
                with DB_LOCK:
                    DB.eliminar_dia_festivo(fecha)
                self._json_response({"ok": True})
                return

            if path == "/api/empleados":
                if not self._require_roles(session_user, ("superadmin", "talento_humano", "supervisor")):
                    return
                id_emp = str(body.get("id_empleado", "")).strip()
                nombre = str(body.get("nombre", "")).strip()
                cargo = str(body.get("cargo", "Operario")).strip()
                pin = str(body.get("pin") or "").strip()
                id_area = self._effective_area(session_user, body.get("id_area"))
                if not id_emp or not nombre:
                    self._error_response("ID y nombre del empleado son obligatorios.")
                    return
                with DB_LOCK:
                    DB.guardar_empleado_individual(id_emp, nombre, cargo, pin, id_area=id_area)
                self._json_response({"ok": True})
                return

            if path == "/api/empleados/eliminar":
                if not self._require_roles(session_user, ("superadmin", "talento_humano", "supervisor")):
                    return
                id_emp = str(body.get("id_empleado", "")).strip()
                with DB_LOCK:
                    if session_user.get("role") == "supervisor":
                        emps = DB.listar_empleados_detallado(id_area=self._effective_area(session_user, None))
                        if not any(str(e["id_empleado"]).strip() == id_emp for e in emps):
                            self._error_response("Solo puedes eliminar empleados de tu propia área.", 403)
                            return
                    DB.eliminar_empleado(id_emp)
                self._json_response({"ok": True})
                return

            if path == "/api/empleados/importar-excel":
                if not self._require_roles(session_user, ("superadmin", "talento_humano", "supervisor")):
                    return
                contenido_b64 = str(body.get("content_base64", ""))
                nombre_archivo = str(body.get("filename", "empleados.xlsx"))
                id_area_def = self._effective_area(session_user, body.get("id_area_default"))
                if not contenido_b64:
                    self._error_response("Seleccione un archivo Excel válido.")
                    return
                raw_bytes = base64.b64decode(contenido_b64.split(",")[-1])
                ruta_tmp = UPLOADS_DIR / f"emp_{datetime.now():%Y%m%d_%H%M%S}_{Path(nombre_archivo).name}"
                ruta_tmp.write_bytes(raw_bytes)
                try:
                    areas_por_nombre = {a["nombre"].strip().lower(): a["id"] for a in DB.listar_areas()}
                    importados = 0
                    libro = pd.read_excel(ruta_tmp, header=None, dtype=object)
                    for _, row in libro.iterrows():
                        if len(row) < 2 or pd.isna(row.iloc[0]):
                            continue
                        c0 = str(row.iloc[0]).strip().lstrip("'")
                        c1 = str(row.iloc[1]).strip() if pd.notna(row.iloc[1]) else ""
                        if not c0 or c0.lower() in ("id", "id_empleado", "codigo", "cedula"):
                            continue
                        # Si es archivo de huellero (col 2 es fecha), o si es base maestra (col 2 es Area, col 3 Cargo, col 4 PIN)
                        area_row = id_area_def
                        cargo_row = "Operario"
                        pin_row = ""
                        if len(row) >= 3 and pd.notna(row.iloc[2]):
                            val2 = str(row.iloc[2]).strip()
                            # Si val2 coincide con un área o no parece fecha, usarlo como Área
                            if val2.lower() in areas_por_nombre:
                                area_row = areas_por_nombre[val2.lower()]
                            elif not any(ch.isdigit() for ch in val2) and len(val2) > 2:
                                area_row = DB.guardar_area(val2, "Importada desde Excel")
                                areas_por_nombre[val2.lower()] = area_row
                        if len(row) >= 4 and pd.notna(row.iloc[3]):
                            val3 = str(row.iloc[3]).strip()
                            if not ":" in val3:
                                cargo_row = val3
                        if len(row) >= 5 and pd.notna(row.iloc[4]):
                            pin_row = str(row.iloc[4]).strip()
                            if pin_row == "1234":
                                pin_row = ""
                        if c1:
                            DB.guardar_empleado_individual(c0, c1, cargo_row, pin_row, id_area=area_row)
                            importados += 1
                    if importados == 0:
                        df = normalizar_huellero(str(ruta_tmp))
                        for _, row in df[["id_empleado", "nombre"]].drop_duplicates().iterrows():
                            emp_id = str(row["id_empleado"]).strip()
                            if emp_id:
                                DB.guardar_empleado_individual(
                                    emp_id,
                                    str(row["nombre"]).strip() or emp_id,
                                    id_area=id_area_def,
                                )
                                importados += 1
                finally:
                    ruta_tmp.unlink(missing_ok=True)
                self._json_response({"ok": True, "importados": importados})
                return

            if path == "/api/asignaciones/masivas":
                if not self._require_roles(session_user, ("superadmin", "supervisor", "talento_humano")):
                    return
                empleados = [str(e).strip() for e in body.get("empleados", []) if str(e).strip()]
                fechas = [date.fromisoformat(str(f).strip()) for f in body.get("fechas", []) if str(f).strip()]
                es_descanso = bool(body.get("es_descanso", False))
                id_turno = None if es_descanso else (int(body["id_turno"]) if body.get("id_turno") else None)
                observaciones = str(body.get("observaciones", "")).strip()

                if not empleados or not fechas:
                    self._error_response("Seleccione al menos un empleado y una fecha.")
                    return
                if not es_descanso and id_turno is None:
                    self._error_response("Seleccione un turno o marque descanso.")
                    return

                lista = [
                    Asignacion(
                        id=None,
                        id_empleado=emp,
                        fecha=f,
                        id_turno=id_turno,
                        es_descanso=es_descanso,
                        observaciones=observaciones,
                    )
                    for emp in empleados
                    for f in fechas
                ]
                cantidad = DB.guardar_asignaciones_masivas(lista)
                self._json_response({"ok": True, "asignadas": cantidad})
                return

            if path == "/api/asignaciones/patron":
                if not self._require_roles(session_user, ("superadmin", "supervisor", "talento_humano")):
                    return
                empleados = [str(e).strip() for e in body.get("empleados", []) if str(e).strip()]
                inicio = date.fromisoformat(str(body.get("fecha_inicio", "")).strip())
                fin = date.fromisoformat(str(body.get("fecha_fin", "")).strip())
                dias_semana = {int(d) for d in body.get("dias_semana", [])}
                es_descanso = bool(body.get("es_descanso", False))
                id_turno = None if es_descanso else (int(body["id_turno"]) if body.get("id_turno") else None)
                observaciones = str(body.get("observaciones", "")).strip()
                solo_previsualizar = bool(body.get("preview", False))

                fechas = fechas_por_patron(inicio, fin, dias_semana)
                existentes = DB.listar_asignaciones(fecha_inicio=inicio, fecha_fin=fin)
                resumen = resumir_patron(empleados, fechas, existentes)

                if solo_previsualizar:
                    self._json_response({"ok": True, "preview": True, "resumen": resumen})
                    return

                lista = [
                    Asignacion(
                        id=None,
                        id_empleado=emp,
                        fecha=f,
                        id_turno=id_turno,
                        es_descanso=es_descanso,
                        observaciones=observaciones,
                    )
                    for emp in empleados
                    for f in fechas
                ]
                cantidad = DB.guardar_asignaciones_masivas(lista)
                self._json_response({"ok": True, "asignadas": cantidad, "resumen": resumen})
                return

            if path == "/api/asignaciones/eliminar":
                if not self._require_roles(session_user, ("superadmin", "supervisor", "talento_humano")):
                    return
                empleados = [str(e).strip() for e in body.get("empleados", []) if str(e).strip()]
                fechas = [date.fromisoformat(str(f).strip()) for f in body.get("fechas", []) if str(f).strip()]
                eliminadas = 0
                for emp in empleados:
                    for f in fechas:
                        if DB.eliminar_asignacion(emp, f):
                            eliminadas += 1
                self._json_response({"ok": True, "eliminadas": eliminadas})
                return

            if path == "/api/previsualizar-huellero":
                archivos_payload = body.get("archivos", [])
                columna_id = str(body.get("columna_id", "ID_Empleado")).strip()
                columna_fecha = str(body.get("columna_fecha", "Fecha")).strip()
                columna_hora = str(body.get("columna_hora", "Hora")).strip()

                if not archivos_payload:
                    self._error_response("Suba al menos un archivo Excel para previsualizar.")
                    return

                registros_totales = []
                empleados_detectados = set()
                fechas_detectadas = []
                resumen_archivos = []

                for arch in archivos_payload:
                    fname = Path(str(arch.get("filename", "huellero.xlsx"))).name
                    b64 = str(arch.get("content_base64", ""))
                    if not b64:
                        continue
                    raw = base64.b64decode(b64.split(",")[-1])
                    dest = UPLOADS_DIR / f"preview_{datetime.now():%Y%m%d_%H%M%S}_{fname}"
                    dest.write_bytes(raw)
                    try:
                        df = normalizar_huellero(str(dest), columna_id, columna_fecha, columna_hora)
                        resumen_archivos.append(
                            {
                                "archivo": fname,
                                "hoja": df.attrs.get("hoja_origen") or "Principal",
                                "marcaciones": len(df),
                            }
                        )
                        if not df.empty:
                            for _, r in df.iterrows():
                                emp_id = str(r["id_empleado"]).strip()
                                empleados_detectados.add(emp_id)
                                f_dt = pd.to_datetime(r["fecha"], errors="coerce")
                                if pd.notna(f_dt):
                                    fechas_detectadas.append(f_dt.date())
                                if len(registros_totales) < 25:
                                    registros_totales.append(
                                        {
                                            "id_empleado": emp_id,
                                            "nombre": str(r["nombre"] or ""),
                                            "fecha": f_dt.strftime("%Y-%m-%d") if pd.notna(f_dt) else "",
                                            "hora": str(r["hora"] or ""),
                                        }
                                    )
                    finally:
                        dest.unlink(missing_ok=True)

                self._json_response(
                    {
                        "ok": True,
                        "archivos": resumen_archivos,
                        "total_marcaciones": sum(a["marcaciones"] for a in resumen_archivos),
                        "total_empleados": len(empleados_detectados),
                        "fecha_min": min(fechas_detectadas).isoformat() if fechas_detectadas else "",
                        "fecha_max": max(fechas_detectadas).isoformat() if fechas_detectadas else "",
                        "muestra": registros_totales,
                    }
                )
                return

            if path == "/api/procesar-huellero":
                if not self._require_roles(session_user, ("superadmin", "supervisor", "auditor", "talento_humano")):
                    return
                archivos_payload = body.get("archivos", [])
                fecha_inicio = date.fromisoformat(str(body.get("fecha_inicio", "")).strip())
                fecha_fin = date.fromisoformat(str(body.get("fecha_fin", "")).strip())
                columna_id = str(body.get("columna_id", "ID_Empleado")).strip()
                columna_fecha = str(body.get("columna_fecha", "Fecha")).strip()
                columna_hora = str(body.get("columna_hora", "Hora")).strip()
                turnos_seleccionados = body.get("turnos", [])
                incluir_no_programados = bool(body.get("incluir_no_programados", False))
                incluir_marcaciones_app = bool(body.get("incluir_marcaciones_app", True))
                id_area = self._effective_area(session_user, body.get("id_area"))
                id_empleado_ind = str(body.get("id_empleado", "")).strip()

                if fecha_inicio > fecha_fin:
                    self._error_response("La fecha inicial no puede ser posterior a la fecha final.")
                    return
                if (fecha_fin - fecha_inicio).days >= 31:
                    self._error_response("El período debe tener máximo 31 días para ajustarse a la hoja de turnos.")
                    return

                empleados_det = DB.listar_empleados_detallado(id_area=id_area)
                if id_empleado_ind and id_empleado_ind != "TODOS":
                    empleados_det = [e for e in empleados_det if str(e["id_empleado"]).strip() == id_empleado_ind]
                empleados = [(str(e["id_empleado"]).strip(), e["nombre"]) for e in empleados_det]
                ids_locales = {emp_id for emp_id, _ in empleados}

                rutas_guardadas = []
                for arch in archivos_payload:
                    fname = Path(str(arch.get("filename", "huellero.xlsx"))).name
                    b64 = str(arch.get("content_base64", ""))
                    if b64:
                        raw = base64.b64decode(b64.split(",")[-1])
                        dest = UPLOADS_DIR / f"{datetime.now():%Y%m%d_%H%M%S}_{fname}"
                        dest.write_bytes(raw)
                        rutas_guardadas.append(dest)

                if rutas_guardadas:
                    try:
                        marcaciones, estadisticas = normalizar_lote(
                            rutas_guardadas,
                            columna_id=columna_id,
                            columna_fecha=columna_fecha,
                            columna_hora=columna_hora,
                            fecha_inicio=fecha_inicio,
                            fecha_fin=fecha_fin,
                            ids_locales=ids_locales,
                        )
                    finally:
                        # Limpieza automática: eliminar Excel temporales del huellero para no llenar disco
                        for ruta_tmp in rutas_guardadas:
                            ruta_tmp.unlink(missing_ok=True)
                else:
                    marcaciones = pd.DataFrame(columns=["id_empleado", "nombre", "fecha", "hora", "fecha_hora"])
                    estadisticas = {
                        "total_archivo": 0,
                        "locales": 0,
                        "en_periodo": 0,
                        "ignoradas": 0,
                        "fuera_periodo": 0,
                        "archivos": ["Marcaciones App Móvil / Base Local"],
                    }

                if incluir_marcaciones_app:
                    marcaciones = _combinar_marcaciones_con_moviles(marcaciones, fecha_inicio, fecha_fin)
                    if ids_locales and not marcaciones.empty:
                        marcaciones = marcaciones.loc[marcaciones["id_empleado"].astype(str).str.strip().isin(ids_locales)].copy()
                    estadisticas["en_periodo"] = len(marcaciones)

                todos_asignados = DB.listar_ids_empleados_con_asignacion(fecha_inicio, fecha_fin) & ids_locales
                todos_turnos = [t.nombre for t in DB.listar_turnos(incluir_inactivos=False)]
                filtro_turno = (
                    None
                    if not turnos_seleccionados or set(turnos_seleccionados) == set(todos_turnos)
                    else turnos_seleccionados
                )
                ids_elegibles = DB.listar_ids_empleados_con_asignacion(
                    fecha_inicio, fecha_fin, filtro_turno
                ) & ids_locales
                if id_empleado_ind and id_empleado_ind != "TODOS":
                    ids_elegibles = {id_empleado_ind}

                detalle = comparar(
                    DB,
                    marcaciones,
                    fecha_inicio=fecha_inicio,
                    fecha_fin=fecha_fin,
                    ids_empleados=ids_elegibles,
                )

                ids_marcados = set(marcaciones["id_empleado"].astype(str)) if not marcaciones.empty else set()
                ids_no_programados = (ids_marcados - todos_asignados) & ids_locales
                detalle_no_prog = pd.DataFrame()
                if incluir_no_programados and ids_no_programados:
                    detalle_no_prog = comparar(
                        DB,
                        marcaciones,
                        fecha_inicio=fecha_inicio,
                        fecha_fin=fecha_fin,
                        ids_empleados=ids_no_programados,
                    )

                # Guardar métricas nuevas en histórico permanente de SQLite (acumula meses sin sobrescribir otras áreas/fechas)
                if detalle is not None and not detalle.empty:
                    _guardar_ultimo_detalle(detalle)

                mes = date(fecha_inicio.year, fecha_inicio.month, 1)
                archivos_generados = []
                stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                sufijo = f"Emp_{id_empleado_ind}" if (id_empleado_ind and id_empleado_ind != "TODOS") else (f"Area_{id_area}" if id_area else "General")

                if detalle is not None and not detalle.empty:
                    nombre_comp = f"Comparativo_{sufijo}_{fecha_inicio:%Y%m%d}_{fecha_fin:%Y%m%d}_{stamp}.xlsx"
                    exportar_comparativo(detalle, str(REPORTS_DIR / nombre_comp))
                    archivos_generados.append(
                        {"tipo": f"Comparativo ({sufijo})", "nombre": nombre_comp, "url": f"/api/reportes/descargar/{nombre_comp}"}
                    )

                    if id_empleado_ind and id_empleado_ind != "TODOS" and empleados:
                        emp_nom = dict(empleados).get(id_empleado_ind, id_empleado_ind)
                        nombre_ind = f"Hoja_Turnos_Individual_{id_empleado_ind}_{fecha_inicio:%Y%m%d}_{fecha_fin:%Y%m%d}_{stamp}.xlsx"
                        ruta_ind = generar_hoja_turnos(
                            id_empleado_ind,
                            emp_nom,
                            mes,
                            detalle,
                            ruta_salida=str(REPORTS_DIR / nombre_ind),
                            fecha_inicio=fecha_inicio,
                            fecha_fin=fecha_fin,
                        )
                        p_ind = Path(ruta_ind)
                        archivos_generados.append(
                            {"tipo": "Hoja de Turnos Individual", "nombre": p_ind.name, "url": f"/api/reportes/descargar/{p_ind.name}"}
                        )
                    else:
                        rutas_hojas = generar_hojas_turnos(
                            DB,
                            detalle,
                            mes,
                            salida=str(REPORTS_DIR),
                            fecha_inicio=fecha_inicio,
                            fecha_fin=fecha_fin,
                        )
                        for r in rutas_hojas:
                            p = Path(r)
                            archivos_generados.append(
                                {"tipo": "Hojas de Turnos Agrupadas", "nombre": p.name, "url": f"/api/reportes/descargar/{p.name}"}
                            )

                    nombre_nov = f"Novedades_{sufijo}_{fecha_inicio:%Y%m%d}_{fecha_fin:%Y%m%d}_{stamp}.xlsx"
                    exportar_reporte_novedades(detalle, str(REPORTS_DIR / nombre_nov))
                    archivos_generados.append(
                        {"tipo": "Reporte de Novedades (6 Pestañas)", "nombre": nombre_nov, "url": f"/api/reportes/descargar/{nombre_nov}"}
                    )

                if incluir_no_programados and not detalle_no_prog.empty:
                    nombre_aud = f"Auditoria_No_Programados_{sufijo}_{fecha_inicio:%Y%m%d}_{fecha_fin:%Y%m%d}_{stamp}.xlsx"
                    exportar_auditoria_no_programados(
                        detalle_no_prog,
                        str(REPORTS_DIR / nombre_aud),
                        dict(empleados),
                    )
                    archivos_generados.append(
                        {"tipo": "Auditoría No Programados", "nombre": nombre_aud, "url": f"/api/reportes/descargar/{nombre_aud}"}
                    )

                kpis = calcular_metricas(detalle)
                self._json_response(
                    {
                        "ok": True,
                        "estadisticas": estadisticas,
                        "empleados_programados": len(ids_elegibles),
                        "empleados_no_programados": len(ids_no_programados) if incluir_no_programados else 0,
                        "filas_generadas": len(detalle),
                        "kpis": kpis,
                        "reportes": archivos_generados,
                    }
                )
                return

            if path == "/api/exportar-novedades":
                id_empleado = body.get("id_empleado")
                turno = body.get("turno")
                f_ini_str = body.get("fecha_inicio")
                f_fin_str = body.get("fecha_fin")
                f_ini = date.fromisoformat(f_ini_str) if f_ini_str else None
                f_fin = date.fromisoformat(f_fin_str) if f_fin_str else None

                detalle = _obtener_detalle_activo(f_ini, f_fin)
                if detalle.empty:
                    self._error_response("No hay datos procesados para exportar.")
                    return
                filtrado = filtrar_detalle(
                    detalle,
                    fecha_inicio=f_ini,
                    fecha_fin=f_fin,
                    id_empleado=id_empleado if id_empleado and id_empleado != "TODOS" else None,
                    turno=turno if turno and turno != "TODOS" else None,
                )
                if filtrado.empty:
                    self._error_response("Los filtros actuales no devuelven filas para exportar.")
                    return
                nombres_por_id = dict(DB.listar_empleados())
                filtrado["nombre_empleado"] = filtrado["id_empleado"].astype(str).str.strip().map(nombres_por_id).fillna("")
                nombre = f"Novedades_{datetime.now():%Y%m%d_%H%M%S}.xlsx"
                exportar_reporte_novedades(filtrado, str(REPORTS_DIR / nombre))
                self._json_response(
                    {
                        "ok": True,
                        "nombre": nombre,
                        "url": f"/api/reportes/descargar/{nombre}",
                    }
                )
                return

            if path == "/api/empleado/marcar":
                id_empleado = str(session_user.get("id") if session_user.get("role") == "empleado" else body.get("id_empleado", "")).strip()
                tipo = str(body.get("tipo", "ENTRADA")).strip().upper()
                latitud = body.get("latitud")
                longitud = body.get("longitud")
                precision_m = body.get("precision_m")
                direccion = str(body.get("direccion", "")).strip()
                dispositivo = str(body.get("dispositivo", "App Celular")).strip()
                observaciones = str(body.get("observaciones", "")).strip()

                if not id_empleado:
                    self._error_response("ID de empleado requerido.")
                    return

                lat_f = float(latitud) if latitud is not None else None
                lon_f = float(longitud) if longitud is not None else None
                prec_f = float(precision_m) if precision_m is not None else None

                # Si llegaron coordenadas pero el navegador aún no resolvió la dirección, resolver en servidor (OpenStreetMap Nominatim)
                if lat_f is not None and lon_f is not None and not direccion:
                    try:
                        import urllib.request
                        url_geo = f"https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat={lat_f}&lon={lon_f}&accept-language=es"
                        req = urllib.request.Request(url_geo, headers={"User-Agent": "SterinovaNominaApp/2.0"})
                        with urllib.request.urlopen(req, timeout=3.5) as resp:
                            geo_data = json.loads(resp.read().decode("utf-8"))
                            direccion = str(geo_data.get("display_name") or "").strip()
                    except Exception:
                        pass
                if not direccion and lat_f is not None and lon_f is not None:
                    direccion = f"Coord: {lat_f:.6f}, {lon_f:.6f}"

                marca_id = DB.registrar_marcacion_movil(
                    id_empleado=id_empleado,
                    tipo=tipo,
                    latitud=lat_f,
                    longitud=lon_f,
                    precision_m=prec_f,
                    direccion=direccion,
                    dispositivo=dispositivo,
                    observaciones=observaciones,
                )
                self._json_response(
                    {
                        "ok": True,
                        "id": marca_id,
                        "fecha_hora": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                        "latitud": lat_f,
                        "longitud": lon_f,
                        "direccion": direccion,
                    }
                )
                return

            if path == "/api/empleado/solicitud":
                id_empleado = str(session_user.get("id") if session_user.get("role") == "empleado" else body.get("id_empleado", "")).strip()
                tipo = str(body.get("tipo", "PERMISO")).strip()
                fecha_inicio = str(body.get("fecha_inicio", "")).strip()
                fecha_fin = str(body.get("fecha_fin", "")).strip() or fecha_inicio
                motivo = str(body.get("motivo", "")).strip()
                if not id_empleado or not fecha_inicio or not motivo:
                    self._error_response("Complete la fecha y el motivo de la solicitud.")
                    return
                sol_id = DB.crear_solicitud(id_empleado, tipo, fecha_inicio, fecha_fin, motivo)
                self._json_response({"ok": True, "id": sol_id})
                return

            if path == "/api/solicitudes/responder":
                if not self._require_roles(session_user, ("supervisor", "talento_humano", "superadmin")):
                    return
                sol_id = int(body.get("id", 0))
                estado = str(body.get("estado", "APROBADA")).strip()
                respuesta = str(body.get("respuesta_admin", "")).strip()
                autor_rol = str(session_user.get("role", "supervisor")).strip()
                autor_nombre = str(session_user.get("nombre", "")).strip()
                if autor_rol == "supervisor" and estado not in ("AVALADO_SUPERVISOR", "RECHAZADA_SUPERVISOR"):
                    self._error_response("El supervisor solo puede avalar o rechazar en primera instancia.", 403)
                    return
                with DB_LOCK:
                    DB.responder_solicitud(sol_id, estado, respuesta, autor_rol=autor_rol, autor_nombre=autor_nombre)
                self._json_response({"ok": True})
                return

            if path == "/api/exportar-permisos":
                if not self._require_roles(session_user, ("talento_humano", "superadmin", "admin")):
                    return
                id_area = self._effective_area(session_user, body.get("id_area"))
                solicitudes = DB.listar_solicitudes(id_area=id_area)
                if not solicitudes:
                    self._error_response("No hay solicitudes de permisos para exportar.")
                    return
                df_perm = pd.DataFrame(solicitudes)
                cols_orden = [
                    "id", "creado_en", "id_empleado", "nombre_empleado", "nombre_area",
                    "tipo", "fecha_inicio", "fecha_fin", "motivo", "estado",
                    "supervisor_usuario", "respuesta_supervisor", "rrhh_usuario", "respuesta_admin"
                ]
                cols_final = [c for c in cols_orden if c in df_perm.columns]
                nombre_arch = f"Reporte_Permisos_RRHH_{datetime.now():%Y%m%d_%H%M%S}.xlsx"
                ruta_arch = REPORTS_DIR / nombre_arch
                df_perm[cols_final].to_excel(ruta_arch, sheet_name="Permisos y Solicitudes", index=False, engine="openpyxl")
                self._json_response(
                    {
                        "ok": True,
                        "nombre": nombre_arch,
                        "url": f"/api/reportes/descargar/{nombre_arch}",
                    }
                )
                return

            if path == "/api/comunicados":
                if not self._require_roles(session_user, ("talento_humano", "superadmin")):
                    return
                titulo = str(body.get("titulo", "")).strip()
                tipo = str(body.get("tipo", "MEMORANDO")).strip()
                mensaje = str(body.get("mensaje", "")).strip()
                destino_tipo = str(body.get("destino_tipo", "TODOS")).strip()
                destino_valor = str(body.get("destino_valor", "")).strip()
                fecha_evento = str(body.get("fecha_evento", "")).strip()
                autor = str(session_user.get("nombre") or "Talento Humano").strip()
                if not titulo or not mensaje:
                    self._error_response("El título y el mensaje del comunicado son obligatorios.")
                    return
                with DB_LOCK:
                    com_id = DB.crear_comunicado(
                        titulo=titulo,
                        tipo=tipo,
                        mensaje=mensaje,
                        destino_tipo=destino_tipo,
                        destino_valor=destino_valor,
                        fecha_evento=fecha_evento,
                        autor=autor,
                    )
                self._json_response({"ok": True, "id": com_id})
                return

            if path == "/api/comunicados/leer":
                id_comunicado = int(body.get("id_comunicado", 0))
                id_empleado = str(session_user.get("id") if session_user.get("role") == "empleado" else body.get("id_empleado", "")).strip()
                with DB_LOCK:
                    DB.confirmar_lectura_comunicado(id_comunicado, id_empleado)
                self._json_response({"ok": True})
                return

            if path == "/api/notificaciones/leer":
                notif_id = int(body.get("id", 0))
                with DB_LOCK:
                    DB.marcar_notificacion_leida(notif_id)
                self._json_response({"ok": True})
                return

            if path == "/api/sistema/limpiar":
                if not self._require_roles(session_user, ("superadmin",)):
                    return
                tipo = str(body.get("tipo", "")).strip()
                dias = int(body.get("dias", 30))
                eliminados = 0
                corte_ts = (datetime.now() - timedelta(days=max(0, dias))).timestamp()

                with DB_LOCK:
                    if tipo == "uploads":
                        for f in UPLOADS_DIR.iterdir():
                            if f.is_file():
                                f.unlink(missing_ok=True)
                                eliminados += 1
                    elif tipo == "reportes":
                        for f in REPORTS_DIR.iterdir():
                            if f.is_file() and (dias <= 0 or f.stat().st_mtime < corte_ts):
                                f.unlink(missing_ok=True)
                                eliminados += 1
                    elif tipo == "selfies":
                        eliminados = DB.limpiar_selfies_antiguas(dias=dias)
                        DB.compactar_bd()
                    elif tipo == "notificaciones":
                        eliminados = DB.limpiar_notificaciones_leidas(dias=dias)
                        DB.compactar_bd()
                    elif tipo == "compactar":
                        DB.compactar_bd()
                    else:
                        self._error_response("Tipo de limpieza no válido.")
                        return
                    return

                self._json_response({"ok": True, "tipo": tipo, "eliminados": eliminados})
                return

            self._error_response(f"Ruta POST no encontrada: {path}", 404)

        except ValueError as error:
            self._error_response(str(error), 400)
        except Exception as error:
            traceback.print_exc()
            self._error_response(f"Error al procesar solicitud: {error}", 500)


def iniciar_servidor(host: str = "0.0.0.0", port: int = 8000) -> None:
    server = ThreadingHTTPServer((host, port), NominaAPIHandler)
    print(f"============================================================")
    print(f" STERINOVA - Sistema Web & App Móvil de Asistencia y Nómina")
    print(f" Servidor en línea en: http://localhost:{port}")
    print(f"============================================================")
    server.serve_forever()


if __name__ == "__main__":
    puerto = int(os.environ.get("PORT", "8000"))
    iniciar_servidor(port=puerto)

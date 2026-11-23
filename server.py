from __future__ import annotations

import base64
import calendar
import io
import json
import mimetypes
import os
import traceback
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
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

REPORTS_DIR.mkdir(parents=True, exist_ok=True)
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

DB = Database(DATA_DIR / "asistencia.db")
DB.initialize()


def _cargar_ultimo_detalle() -> pd.DataFrame:
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
    ruta = DATA_DIR / "ultimo_detalle.pkl"
    if df is not None and not df.empty:
        df.to_pickle(ruta)


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
    """Devuelve el último detalle procesado o calcula uno en vivo con asignaciones + marcaciones móviles."""
    df = _cargar_ultimo_detalle()
    moviles = DB.listar_marcaciones_moviles(fecha_inicio=fecha_inicio, fecha_fin=fecha_fin)
    if df.empty or moviles:
        try:
            marcas = _combinar_marcaciones_con_moviles(pd.DataFrame(), fecha_inicio, fecha_fin)
            calculado = comparar(DB, marcas, fecha_inicio=fecha_inicio, fecha_fin=fecha_fin)
            if df.empty:
                return calculado
            if not calculado.empty and moviles:
                # Si hay marcaciones móviles recientes, actualizar esas fechas/empleados
                return calculado if len(calculado) >= len(df) else df
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

    def _json_response(self, data: Any, status: int = 200) -> None:
        payload = json.dumps(data, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(status)
        self._send_cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _error_response(self, message: str, status: int = 400) -> None:
        self._json_response({"ok": False, "error": message}, status=status)

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
                pendientes = sum(1 for s in solicitudes if s["estado"] == "PENDIENTE")
                marcaciones_hoy = DB.listar_marcaciones_moviles(
                    fecha_inicio=date.today(), fecha_fin=date.today()
                )
                self._json_response(
                    {
                        "ok": True,
                        "total_empleados": resumen["total_empleados"],
                        "total_turnos": resumen["total_turnos"],
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

            if path == "/api/turnos":
                turnos = DB.listar_turnos(incluir_inactivos=True)
                self._json_response(
                    {
                        "ok": True,
                        "turnos": [
                            {
                                "id": t.id,
                                "nombre": t.nombre,
                                "hora_entrada": t.hora_entrada,
                                "hora_salida": t.hora_salida,
                                "tolerancia_min": t.tolerancia_min,
                                "descanso_min": t.descanso_min,
                                "cruza_medianoche": t.cruza_medianoche,
                                "recargo_nocturno_pct": t.recargo_nocturno_pct,
                                "activo": t.activo,
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
                empleados = DB.listar_empleados_detallado()
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
                turno = query.get("turno", [None])[0]
                f_ini_str = query.get("fecha_inicio", [None])[0]
                f_fin_str = query.get("fecha_fin", [None])[0]
                kpi = query.get("kpi", [None])[0]

                f_ini = date.fromisoformat(f_ini_str) if f_ini_str else None
                f_fin = date.fromisoformat(f_fin_str) if f_fin_str else None

                detalle = _obtener_detalle_activo(f_ini, f_fin)
                nombres_por_id = dict(DB.listar_empleados())
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

                turnos_disp = sorted(
                    str(v) for v in detalle.get("turno", pd.Series(dtype=object)).dropna().unique()
                )
                fechas_col = pd.to_datetime(detalle["fecha"], errors="coerce").dropna().dt.date
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

                filas = [
                    _serializar_fila_detalle(row.to_dict(), nombres_por_id)
                    for _, row in filtrado_final.iterrows()
                ]
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
                marcaciones = DB.listar_marcaciones_moviles(id_empleado=id_empleado or None)
                self._json_response({"ok": True, "marcaciones": marcaciones})
                return

            if path == "/api/solicitudes":
                id_empleado = query.get("id_empleado", [None])[0]
                solicitudes = DB.listar_solicitudes(id_empleado=id_empleado or None)
                self._json_response({"ok": True, "solicitudes": solicitudes})
                return

            if path == "/api/usuarios":
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

                self._json_response(
                    {
                        "ok": True,
                        "hoy": hoy.isoformat(),
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
                self._json_response({"ok": True, "user": user})
                return

            if path == "/api/usuarios":
                username = str(body.get("username", "")).strip()
                password = str(body.get("password", "")).strip()
                nombre = str(body.get("nombre", "")).strip()
                rol = str(body.get("rol", "admin")).strip().lower()
                DB.guardar_usuario_sistema(username, password, nombre, rol)
                self._json_response({"ok": True})
                return

            if path == "/api/usuarios/eliminar":
                username = str(body.get("username", "")).strip()
                DB.eliminar_usuario_sistema(username)
                self._json_response({"ok": True})
                return

            if path == "/api/turnos":
                nombre = str(body.get("nombre", "")).strip()
                hora_entrada = str(body.get("hora_entrada", "")).strip()
                hora_salida = str(body.get("hora_salida", "")).strip()
                if not nombre or not hora_entrada or not hora_salida:
                    self._error_response("Nombre, hora de entrada y hora de salida son obligatorios.")
                    return
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
                turno_id = DB.guardar_turno(turno)
                self._json_response({"ok": True, "id": turno_id})
                return

            if path == "/api/turnos/eliminar":
                turno_id = int(body.get("id", 0))
                DB.eliminar_turno(turno_id)
                self._json_response({"ok": True})
                return

            if path == "/api/festivos":
                fecha = date.fromisoformat(str(body.get("fecha", "")).strip())
                descripcion = str(body.get("descripcion", "")).strip()
                DB.guardar_dia_festivo(fecha, descripcion)
                self._json_response({"ok": True})
                return

            if path == "/api/festivos/cargar-colombia":
                anio = int(body.get("anio", date.today().year))
                dias = festivos_colombia(anio)
                cantidad = DB.guardar_dias_festivos(dias)
                self._json_response({"ok": True, "cantidad": cantidad, "anio": anio})
                return

            if path == "/api/festivos/eliminar":
                fecha = date.fromisoformat(str(body.get("fecha", "")).strip())
                DB.eliminar_dia_festivo(fecha)
                self._json_response({"ok": True})
                return

            if path == "/api/empleados":
                id_emp = str(body.get("id_empleado", "")).strip()
                nombre = str(body.get("nombre", "")).strip()
                cargo = str(body.get("cargo", "Operario")).strip()
                pin = str(body.get("pin", "1234")).strip()
                if not id_emp or not nombre:
                    self._error_response("ID y nombre del empleado son obligatorios.")
                    return
                DB.guardar_empleado_individual(id_emp, nombre, cargo, pin)
                self._json_response({"ok": True})
                return

            if path == "/api/empleados/eliminar":
                id_emp = str(body.get("id_empleado", "")).strip()
                DB.eliminar_empleado(id_emp)
                self._json_response({"ok": True})
                return

            if path == "/api/empleados/importar-excel":
                 contenido_b64 = str(body.get("content_base64", ""))
                 nombre_archivo = str(body.get("filename", "empleados.xlsx"))
                 if not contenido_b64:
                     self._error_response("Seleccione un archivo Excel válido.")
                     return
                 raw_bytes = base64.b64decode(contenido_b64.split(",")[-1])
                 ruta_tmp = UPLOADS_DIR / f"emp_{datetime.now():%Y%m%d_%H%M%S}_{Path(nombre_archivo).name}"
                 ruta_tmp.write_bytes(raw_bytes)
                 df = normalizar_huellero(str(ruta_tmp))
                 pares = []
                 if not df.empty:
                     for _, row in df[["id_empleado", "nombre"]].drop_duplicates().iterrows():
                         if str(row["id_empleado"]).strip():
                             pares.append((str(row["id_empleado"]).strip(), str(row["nombre"]).strip() or str(row["id_empleado"]).strip()))
                 else:
                     libro = pd.read_excel(ruta_tmp, header=None, dtype=object)
                     for _, row in libro.iterrows():
                         if len(row) >= 2 and pd.notna(row.iloc[0]) and pd.notna(row.iloc[1]):
                             c0 = str(row.iloc[0]).strip().lstrip("'")
                             c1 = str(row.iloc[1]).strip()
                             if c0 and c0.lower() not in ("id", "id_empleado", "codigo"):
                                 pares.append((c0, c1))
                 guardados = DB.guardar_empleados(pares)
                 self._json_response({"ok": True, "importados": guardados})
                 return

            if path == "/api/asignaciones/masivas":
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
                empleados = [str(e).strip() for e in body.get("empleados", []) if str(e).strip()]
                fechas = [date.fromisoformat(str(f).strip()) for f in body.get("fechas", []) if str(f).strip()]
                eliminadas = 0
                for emp in empleados:
                    for f in fechas:
                        if DB.eliminar_asignacion(emp, f):
                            eliminadas += 1
                self._json_response({"ok": True, "eliminadas": eliminadas})
                return

            if path == "/api/procesar-huellero":
                archivos_payload = body.get("archivos", [])
                fecha_inicio = date.fromisoformat(str(body.get("fecha_inicio", "")).strip())
                fecha_fin = date.fromisoformat(str(body.get("fecha_fin", "")).strip())
                columna_id = str(body.get("columna_id", "ID_Empleado")).strip()
                columna_fecha = str(body.get("columna_fecha", "Fecha")).strip()
                columna_hora = str(body.get("columna_hora", "Hora")).strip()
                turnos_seleccionados = body.get("turnos", [])
                incluir_no_programados = bool(body.get("incluir_no_programados", False))
                incluir_marcaciones_app = bool(body.get("incluir_marcaciones_app", True))

                if fecha_inicio > fecha_fin:
                    self._error_response("La fecha inicial no puede ser posterior a la fecha final.")
                    return
                if (fecha_fin - fecha_inicio).days >= 31:
                    self._error_response("El período debe tener máximo 31 días para ajustarse a la hoja de turnos.")
                    return

                empleados = DB.listar_empleados()
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
                    marcaciones, estadisticas = normalizar_lote(
                        rutas_guardadas,
                        columna_id=columna_id,
                        columna_fecha=columna_fecha,
                        columna_hora=columna_hora,
                        fecha_inicio=fecha_inicio,
                        fecha_fin=fecha_fin,
                        ids_locales=ids_locales,
                    )
                else:
                    # Permite procesar solo con marcaciones de la app móvil o asignaciones existentes
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
                    estadisticas["en_periodo"] = len(marcaciones)

                todos_asignados = DB.listar_ids_empleados_con_asignacion(fecha_inicio, fecha_fin)
                todos_turnos = [t.nombre for t in DB.listar_turnos(incluir_inactivos=False)]
                filtro_turno = (
                    None
                    if not turnos_seleccionados or set(turnos_seleccionados) == set(todos_turnos)
                    else turnos_seleccionados
                )
                ids_elegibles = DB.listar_ids_empleados_con_asignacion(
                    fecha_inicio, fecha_fin, filtro_turno
                )

                detalle = comparar(
                    DB,
                    marcaciones,
                    fecha_inicio=fecha_inicio,
                    fecha_fin=fecha_fin,
                    ids_empleados=ids_elegibles,
                )

                ids_marcados = set(marcaciones["id_empleado"].astype(str)) if not marcaciones.empty else set()
                ids_no_programados = ids_marcados - todos_asignados
                detalle_no_prog = pd.DataFrame()
                if incluir_no_programados and ids_no_programados:
                    detalle_no_prog = comparar(
                        DB,
                        marcaciones,
                        fecha_inicio=fecha_inicio,
                        fecha_fin=fecha_fin,
                        ids_empleados=ids_no_programados,
                    )

                _guardar_ultimo_detalle(detalle)

                mes = date(fecha_inicio.year, fecha_inicio.month, 1)
                archivos_generados = []
                stamp = datetime.now().strftime("%Y%m%d_%H%M%S")

                if detalle is not None and not detalle.empty:
                    nombre_comp = f"Comparativo_{fecha_inicio:%Y%m%d}_{fecha_fin:%Y%m%d}_{stamp}.xlsx"
                    exportar_comparativo(detalle, str(REPORTS_DIR / nombre_comp))
                    archivos_generados.append(
                        {"tipo": "Comparativo General", "nombre": nombre_comp, "url": f"/api/reportes/descargar/{nombre_comp}"}
                    )

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
                            {"tipo": "Hojas de Turnos Corporativas", "nombre": p.name, "url": f"/api/reportes/descargar/{p.name}"}
                        )

                    nombre_nov = f"Novedades_6_Pestanas_{fecha_inicio:%Y%m%d}_{fecha_fin:%Y%m%d}_{stamp}.xlsx"
                    exportar_reporte_novedades(detalle, str(REPORTS_DIR / nombre_nov))
                    archivos_generados.append(
                        {"tipo": "Reporte de Novedades (6 Pestañas)", "nombre": nombre_nov, "url": f"/api/reportes/descargar/{nombre_nov}"}
                    )

                if incluir_no_programados and not detalle_no_prog.empty:
                    nombre_aud = f"Auditoria_No_Programados_{fecha_inicio:%Y%m%d}_{fecha_fin:%Y%m%d}_{stamp}.xlsx"
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
                id_empleado = str(body.get("id_empleado", "")).strip()
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
                id_empleado = str(body.get("id_empleado", "")).strip()
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
                sol_id = int(body.get("id", 0))
                estado = str(body.get("estado", "APROBADA")).strip()
                respuesta = str(body.get("respuesta_admin", "")).strip()
                DB.responder_solicitud(sol_id, estado, respuesta)
                self._json_response({"ok": True})
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

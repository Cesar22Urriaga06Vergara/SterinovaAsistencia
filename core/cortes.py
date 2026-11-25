from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import date

from core.rutas import ahora_bogota


class ConflictoCorte(ValueError):
    pass


class AccesoCorte(ValueError):
    pass


class Cortes:
    def __init__(self, connection: sqlite3.Connection):
        self.db = connection

    def initialize(self):
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS cortes (
                id INTEGER PRIMARY KEY,
                mes TEXT NOT NULL,
                inicio TEXT NOT NULL,
                fin TEXT NOT NULL,
                revision INTEGER NOT NULL DEFAULT 1,
                estado TEXT NOT NULL DEFAULT 'ABIERTO'
            );
            CREATE TABLE IF NOT EXISTS cortes_areas (
                corte INTEGER NOT NULL REFERENCES cortes(id),
                revision INTEGER NOT NULL,
                area INTEGER NOT NULL,
                nombre TEXT NOT NULL,
                estado TEXT NOT NULL DEFAULT 'PENDIENTE',
                resultado TEXT,
                PRIMARY KEY(corte, revision, area)
            );
            CREATE TABLE IF NOT EXISTS cortes_eventos (
                id INTEGER PRIMARY KEY,
                corte INTEGER NOT NULL REFERENCES cortes(id),
                revision INTEGER NOT NULL,
                area INTEGER,
                accion TEXT NOT NULL,
                actor TEXT NOT NULL,
                fecha TEXT NOT NULL,
                motivo TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS cortes_cierres (
                corte INTEGER NOT NULL REFERENCES cortes(id),
                revision INTEGER NOT NULL,
                PRIMARY KEY(corte, revision)
            );
        """)

    @contextmanager
    def transaccion(self):
        self.db.execute("BEGIN IMMEDIATE")
        with self.db:
            yield

    def _corte(self, corte):
        fila = self.db.execute("SELECT * FROM cortes WHERE id=?", (corte,)).fetchone()
        if fila is None:
            raise ValueError("Corte no encontrado.")
        return dict(fila)

    def _evento(self, corte, revision, area, accion, usuario, motivo=""):
        self.db.execute(
            """INSERT INTO cortes_eventos (corte,revision,area,accion,actor,fecha,motivo)
               VALUES (?,?,?,?,?,?,?)""",
            (corte, revision, area, accion, str(usuario["id"]), ahora_bogota().isoformat(), motivo),
        )

    def _areas(self, corte, revision):
        self.db.execute(
            """INSERT INTO cortes_areas (corte,revision,area,nombre)
               SELECT ?,?,id,nombre FROM areas
               WHERE id IN (SELECT id_area FROM empleados)""", (corte, revision),
        )

    def guardar(self, datos, usuario):
        if usuario["role"] != "talento_humano":
            raise AccesoCorte("Talento Humano configura los cortes.")
        mes = str(datos.get("mes", ""))
        if date.fromisoformat(mes + "-01").isoformat()[:7] != mes:
            raise ValueError("Indique el mes de nómina.")
        inicio = date.fromisoformat(datos.get("inicio") or "").isoformat()
        fin = date.fromisoformat(datos.get("fin") or "").isoformat()
        if inicio > fin or (date.fromisoformat(fin) - date.fromisoformat(inicio)).days >= 31:
            raise ValueError("Indique un rango válido de hasta 31 días.")
        corte = int(datos.get("id") or 0)
        with self.transaccion():
            if self.db.execute(
                "SELECT 1 FROM cortes WHERE id<>? AND inicio<=? AND fin>=?", (corte, fin, inicio)
            ).fetchone():
                raise ConflictoCorte("Las fechas se solapan con otro corte.")
            if corte:
                actual = self._corte(corte)
                if actual["revision"] != 1 or self.db.execute(
                    "SELECT 1 FROM cortes_eventos WHERE corte=? AND accion='enviar'", (corte,)
                ).fetchone():
                    raise ConflictoCorte("Las fechas solo se editan antes del primer envío.")
                self.db.execute("UPDATE cortes SET mes=?,inicio=?,fin=? WHERE id=?", (mes, inicio, fin, corte))
            else:
                corte = self.db.execute(
                    "INSERT INTO cortes(mes,inicio,fin) VALUES (?,?,?)", (mes, inicio, fin)
                ).lastrowid
                self._areas(corte, 1)
                if not self.db.execute("SELECT 1 FROM cortes_areas WHERE corte=?", (corte,)).fetchone():
                    raise ConflictoCorte("Asigne empleados a un área antes de crear el corte.")
            self._evento(corte, 1, None, "editar" if datos.get("id") else "crear", usuario)
        return corte

    def listar(self, usuario):
        area = usuario.get("id_area") if usuario["role"] == "supervisor" else None
        resultado = []
        for fila in self.db.execute("SELECT * FROM cortes ORDER BY inicio DESC"):
            corte = dict(fila)
            params = (corte["id"], corte["revision"], area, area)
            corte["areas"] = [dict(a) for a in self.db.execute(
                """SELECT area,nombre,estado FROM cortes_areas
                   WHERE corte=? AND revision=? AND (? IS NULL OR area=?) ORDER BY nombre""", params,
            )]
            corte["revisiones_cerradas"] = [r[0] for r in self.db.execute(
                "SELECT revision FROM cortes_cierres WHERE corte=? ORDER BY revision DESC", (corte["id"],),
            )]
            corte["eventos"] = [dict(e) for e in self.db.execute(
                """SELECT revision,area,accion,actor,fecha,motivo FROM cortes_eventos
                   WHERE corte=? AND (? IS NULL OR area=? OR area IS NULL) ORDER BY id DESC""",
                (corte["id"], area, area),
            )]
            resultado.append(corte)
        return resultado

    def accion(self, datos, usuario):
        corte = int(datos.get("id") or 0)
        accion = datos.get("accion")
        rol = usuario["role"]
        motivo = str(datos.get("motivo") or "").strip()
        area = usuario.get("id_area") if rol == "supervisor" else int(datos.get("area") or 0)
        permitidos = {
            "enviar": ("supervisor",), "validar": ("talento_humano",),
            "devolver": ("talento_humano",), "cerrar": ("superadmin",),
            "reabrir": ("superadmin",), "observar": ("auditor",),
        }
        if rol not in permitidos.get(accion, ()):
            raise AccesoCorte("La acción no está permitida para su perfil.")
        if accion in ("devolver", "reabrir", "observar") and not motivo:
            raise ValueError("Indique el motivo o la observación.")
        with self.transaccion():
            actual = self._corte(corte)
            revision = int(datos.get("revision") or 0)
            if revision != actual["revision"]:
                raise ConflictoCorte("La revisión cambió. Actualice el corte.")
            if accion == "observar":
                self._evento(corte, revision, None, accion, usuario, motivo)
                return
            if accion == "reabrir":
                if actual["estado"] != "CERRADO":
                    raise ConflictoCorte("El corte debe estar cerrado para reabrirlo.")
                revision += 1
                self.db.execute("UPDATE cortes SET estado='ABIERTO',revision=? WHERE id=?", (revision, corte))
                self.db.execute(
                    """INSERT INTO cortes_areas(corte,revision,area,nombre)
                       SELECT corte,?,area,nombre FROM cortes_areas WHERE corte=? AND revision=?""",
                    (revision, corte, revision - 1),
                )
                self._evento(corte, revision, None, accion, usuario, motivo)
                return
            if actual["estado"] != "ABIERTO":
                raise ConflictoCorte("El corte está cerrado.")
            if accion == "cerrar":
                pendientes = self.db.execute(
                    "SELECT estado FROM cortes_areas WHERE corte=? AND revision=?", (corte, revision),
                ).fetchall()
                if not pendientes or any(a["estado"] != "VALIDADO" for a in pendientes):
                    raise ConflictoCorte("Todas las áreas deben estar validadas.")
                if self.db.execute(
                    """SELECT 1 FROM historico_metricas h LEFT JOIN empleados e USING(id_empleado)
                       WHERE h.fecha BETWEEN ? AND ? AND NOT EXISTS (
                         SELECT 1 FROM cortes_areas a WHERE a.corte=? AND a.revision=? AND a.area=e.id_area
                       ) LIMIT 1""", (actual["inicio"], actual["fin"], corte, revision),
                ).fetchone():
                    raise ConflictoCorte("Hay resultados de empleados sin un área incluida en el corte.")
                self.db.execute("INSERT INTO cortes_cierres VALUES (?,?)", (corte, revision))
                self.db.execute("UPDATE cortes SET estado='CERRADO' WHERE id=?", (corte,))
                self._evento(corte, revision, None, accion, usuario)
                return
            origen, destino = {
                "enviar": (("PENDIENTE", "DEVUELTO"), "ENVIADO"),
                "validar": (("ENVIADO",), "VALIDADO"),
                "devolver": (("ENVIADO",), "DEVUELTO"),
            }[accion]
            clave = (corte, revision, area)
            fila = self.db.execute(
                "SELECT estado FROM cortes_areas WHERE corte=? AND revision=? AND area=?", clave,
            ).fetchone()
            if not fila or fila["estado"] not in origen:
                raise ConflictoCorte("La etapa del área cambió. Actualice el corte.")
            resultado = None
            if accion == "enviar":
                resultados = self.db.execute(
                    """SELECT h.*, e.nombre AS nombre_empleado FROM historico_metricas h
                       JOIN empleados e USING(id_empleado)
                       WHERE e.id_area=? AND h.fecha BETWEEN ? AND ? ORDER BY h.fecha,h.id_empleado""",
                    (area, actual["inicio"], actual["fin"]),
                )
                resultado = json.dumps([dict(r) for r in resultados], ensure_ascii=False)
            self.db.execute(
                "UPDATE cortes_areas SET estado=?,resultado=COALESCE(?,resultado) WHERE corte=? AND revision=? AND area=?",
                (destino, resultado, *clave),
            )
            self._evento(corte, revision, area, accion, usuario, motivo)

    def verificar_procesamiento(self, inicio, fin, area):
        bloqueado = self.db.execute(
            """SELECT 1 FROM cortes c WHERE c.inicio<=? AND c.fin>=? AND (
                 c.estado='CERRADO' OR EXISTS (
                   SELECT 1 FROM cortes_areas a WHERE a.corte=c.id AND a.revision=c.revision
                   AND a.estado IN ('ENVIADO','VALIDADO') AND (? IS NULL OR a.area=?)
                 )
               ) LIMIT 1""", (fin.isoformat(), inicio.isoformat(), area, area),
        ).fetchone()
        if bloqueado:
            raise ConflictoCorte("El rango incluye un corte cerrado o un área entregada a revisión.")

    def resultados(self, corte, revision, area):
        cerrada = self.db.execute(
            "SELECT 1 FROM cortes_cierres WHERE corte=? AND revision=?", (corte, revision)
        ).fetchone()
        if not cerrada and (area is None or not self.db.execute(
            """SELECT 1 FROM cortes_areas
               WHERE corte=? AND revision=? AND area=? AND estado IN ('ENVIADO','VALIDADO')""",
            (corte, revision, area),
        ).fetchone()):
            raise ValueError("El área aún no tiene resultados disponibles para esta revisión.")
        return [
            fila
            for resultado, in self.db.execute(
                """SELECT resultado FROM cortes_areas
                   WHERE corte=? AND revision=? AND (? IS NULL OR area=?)""", (corte, revision, area, area),
            )
            for fila in json.loads(resultado or "[]")
        ]

import sqlite3
from pathlib import Path
from datetime import date
from typing import Optional
import os
import sys
import shutil

from models import Asignacion, Turno


class Database:
    def __init__(self, db_path: Optional[Path] = None) -> None:
        if db_path is None:
            db_path = Path(__file__).resolve().parent / "data" / "asistencia.db"
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(str(db_path), check_same_thread=False)
        self.connection.row_factory = sqlite3.Row

    def initialize(self) -> None:
        self.connection.executescript(
            """
            DROP TABLE IF EXISTS planillas_digitalizadas;

            CREATE TABLE IF NOT EXISTS turnos (
                id INTEGER PRIMARY KEY,
                nombre TEXT NOT NULL,
                hora_entrada TEXT NOT NULL,
                hora_salida TEXT NOT NULL,
                tolerancia_min INTEGER NOT NULL DEFAULT 10,
                descanso_min INTEGER NOT NULL DEFAULT 0,
                cruza_medianoche INTEGER NOT NULL DEFAULT 0,
                recargo_nocturno_pct REAL NOT NULL DEFAULT 0,
                activo INTEGER NOT NULL DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS asignaciones (
                id INTEGER PRIMARY KEY,
                id_empleado TEXT NOT NULL,
                fecha TEXT NOT NULL,
                id_turno INTEGER,
                es_descanso INTEGER NOT NULL DEFAULT 0,
                observaciones TEXT,
                FOREIGN KEY (id_turno) REFERENCES turnos(id)
            );

            CREATE TABLE IF NOT EXISTS empleados (
                id_empleado TEXT PRIMARY KEY,
                nombre TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS dias_festivos (
                fecha TEXT PRIMARY KEY,
                descripcion TEXT
            );

            CREATE TABLE IF NOT EXISTS usuarios_admin (
                username TEXT PRIMARY KEY,
                password_hash TEXT NOT NULL,
                nombre TEXT NOT NULL,
                rol TEXT NOT NULL DEFAULT 'admin'
            );

            CREATE TABLE IF NOT EXISTS marcaciones_moviles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                id_empleado TEXT NOT NULL,
                fecha_hora TEXT NOT NULL,
                tipo TEXT NOT NULL,
                latitud REAL,
                longitud REAL,
                precision_m REAL,
                direccion TEXT,
                dispositivo TEXT,
                observaciones TEXT
            );

            CREATE TABLE IF NOT EXISTS solicitudes_empleado (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                id_empleado TEXT NOT NULL,
                tipo TEXT NOT NULL,
                fecha_inicio TEXT NOT NULL,
                fecha_fin TEXT NOT NULL,
                motivo TEXT NOT NULL,
                estado TEXT NOT NULL DEFAULT 'PENDIENTE',
                respuesta_admin TEXT DEFAULT '',
                creado_en TEXT NOT NULL
            );

            """
        )
        # Asegurar columna pin en empleados para acceso móvil/web
        columnas_emp = {
            row["name"]
            for row in self.connection.execute("PRAGMA table_info(empleados)").fetchall()
        }
        if "pin" not in columnas_emp:
            self.connection.execute("ALTER TABLE empleados ADD COLUMN pin TEXT DEFAULT '1234'")
        if "cargo" not in columnas_emp:
            self.connection.execute("ALTER TABLE empleados ADD COLUMN cargo TEXT DEFAULT 'Operario'")

        # Asegurar columna foto_base64 en marcaciones_moviles
        columnas_marc = {
            row["name"]
            for row in self.connection.execute("PRAGMA table_info(marcaciones_moviles)").fetchall()
        }
        if "foto_base64" not in columnas_marc:
            self.connection.execute("ALTER TABLE marcaciones_moviles ADD COLUMN foto_base64 TEXT DEFAULT ''")

        # Asegurar columna rol en usuarios_admin (soporta 'superadmin', 'admin' y 'supervisor')
        columnas_usr = {
            row["name"]
            for row in self.connection.execute("PRAGMA table_info(usuarios_admin)").fetchall()
        }
        if "rol" not in columnas_usr:
            self.connection.execute("ALTER TABLE usuarios_admin ADD COLUMN rol TEXT DEFAULT 'admin'")

        # Leer credenciales iniciales del Superadmin desde .env o variables de entorno del deploy
        env_vars = {}
        env_file = Path(__file__).resolve().parent / ".env"
        if env_file.is_file():
            for line in env_file.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env_vars[k.strip()] = v.strip().strip('"').strip("'")

        sa_user = os.environ.get("SUPERADMIN_USER") or env_vars.get("SUPERADMIN_USER") or "superadmin"
        sa_pass = os.environ.get("SUPERADMIN_PASS") or env_vars.get("SUPERADMIN_PASS")
        sa_name = os.environ.get("SUPERADMIN_NAME") or env_vars.get("SUPERADMIN_NAME") or "Super Administrador"

        if sa_pass:
            self.connection.execute(
                """INSERT INTO usuarios_admin (username, password_hash, nombre, rol)
                   VALUES (?, ?, ?, 'superadmin')
                   ON CONFLICT(username) DO UPDATE SET
                   password_hash=excluded.password_hash,
                   nombre=excluded.nombre,
                   rol='superadmin'""",
                (sa_user.strip(), sa_pass.strip(), sa_name.strip()),
            )
        self.connection.commit()

    def guardar_empleados(self, empleados: list[tuple[str, str]]) -> int:
        unicos = {}
        for id_empleado, nombre in empleados:
            id_limpio = str(id_empleado).strip()
            nombre_limpio = str(nombre).strip()
            if id_limpio.startswith("'"):
                id_limpio = id_limpio[1:].strip()
            if id_limpio:
                unicos[id_limpio] = nombre_limpio
        if not unicos:
            return 0

        with self.connection:
            self.connection.executemany(
                """INSERT INTO empleados (id_empleado, nombre)
                   VALUES (?, ?)
                   ON CONFLICT(id_empleado) DO UPDATE SET nombre=excluded.nombre""",
                list(unicos.items()),
            )
        return len(unicos)

    def listar_empleados(self) -> list[tuple[str, str]]:
        rows = self.connection.execute(
            "SELECT id_empleado, nombre FROM empleados ORDER BY id_empleado"
        ).fetchall()
        return [(str(row["id_empleado"]), str(row["nombre"])) for row in rows]

    def listar_turnos(self, incluir_inactivos: bool = True) -> list[Turno]:
        query = "SELECT * FROM turnos"
        if not incluir_inactivos:
            query += " WHERE activo = 1"
        query += " ORDER BY nombre"
        rows = self.connection.execute(query).fetchall()
        return [Turno.from_row(dict(row)) for row in rows]

    def obtener_resumen_dashboard(self) -> dict[str, int | date | None]:
        """Lee los indicadores del menú en una sola consulta agregada."""
        row = self.connection.execute(
            """SELECT
                   (SELECT COUNT(*) FROM empleados) AS total_empleados,
                   (SELECT COUNT(*) FROM turnos) AS total_turnos,
                   (SELECT MAX(fecha) FROM asignaciones) AS ultima_fecha_asignada"""
        ).fetchone()
        fecha = row["ultima_fecha_asignada"]
        return {
            "total_empleados": int(row["total_empleados"] or 0),
            "total_turnos": int(row["total_turnos"] or 0),
            "ultima_fecha_asignada": date.fromisoformat(fecha) if fecha else None,
        }

    def guardar_turno(self, turno: Turno) -> int:
        values = (
            turno.nombre,
            turno.hora_entrada,
            turno.hora_salida,
            int(turno.tolerancia_min or 0),
            int(turno.descanso_min or 0),
            int(turno.hora_salida < turno.hora_entrada),
            float(turno.recargo_nocturno_pct or 0.0),
            int(turno.activo),
        )
        if turno.id is None:
            cursor = self.connection.execute(
                """INSERT INTO turnos
                (nombre, hora_entrada, hora_salida, tolerancia_min, descanso_min,
                 cruza_medianoche, recargo_nocturno_pct, activo)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                values,
            )
            self.connection.commit()
            return int(cursor.lastrowid)

        self.connection.execute(
            """UPDATE turnos SET
            nombre=?, hora_entrada=?, hora_salida=?, tolerancia_min=?,
            descanso_min=?, cruza_medianoche=?, recargo_nocturno_pct=?, activo=?
            WHERE id=?""",
            (*values, turno.id),
        )
        self.connection.commit()
        return turno.id

    def eliminar_turno(self, turno_id: int) -> None:
        self.connection.execute("DELETE FROM turnos WHERE id=?", (turno_id,))
        self.connection.commit()

    def listar_dias_festivos(self) -> list[tuple[date, str]]:
        rows = self.connection.execute(
            "SELECT fecha, descripcion FROM dias_festivos ORDER BY fecha"
        ).fetchall()
        return [
            (date.fromisoformat(str(row["fecha"])), str(row["descripcion"] or ""))
            for row in rows
        ]

    def guardar_dia_festivo(self, fecha: date, descripcion: str = "") -> None:
        with self.connection:
            self.connection.execute(
                """INSERT INTO dias_festivos (fecha, descripcion)
                   VALUES (?, ?)
                   ON CONFLICT(fecha) DO UPDATE SET descripcion=excluded.descripcion""",
                (fecha.isoformat(), descripcion.strip()),
            )

    def guardar_dias_festivos(self, dias: list[tuple[date, str]]) -> int:
        """Guarda o actualiza un conjunto de festivos dentro de una transacción."""
        normalizados = []
        for fecha, descripcion in dias:
            if not isinstance(fecha, date):
                raise ValueError("Cada festivo debe tener una fecha válida.")
            normalizados.append((fecha.isoformat(), str(descripcion or "").strip()))
        if not normalizados:
            return 0
        with self.connection:
            self.connection.executemany(
                """INSERT INTO dias_festivos (fecha, descripcion)
                   VALUES (?, ?)
                   ON CONFLICT(fecha) DO UPDATE SET descripcion=excluded.descripcion""",
                normalizados,
            )
        return len(normalizados)

    def eliminar_dia_festivo(self, fecha: date) -> None:
        with self.connection:
            self.connection.execute(
                "DELETE FROM dias_festivos WHERE fecha=?",
                (fecha.isoformat(),),
            )

    def es_dia_festivo(self, fecha: date) -> bool:
        row = self.connection.execute(
            "SELECT 1 FROM dias_festivos WHERE fecha=?",
            (fecha.isoformat(),),
        ).fetchone()
        return row is not None

    def guardar_asignacion(self, asignacion: Asignacion) -> int:
        fecha = asignacion.fecha.isoformat()
        existing = self.connection.execute(
            "SELECT id FROM asignaciones WHERE id_empleado=? AND fecha=?",
            (asignacion.id_empleado, fecha),
        ).fetchone()
        values = (
            asignacion.id_empleado,
            fecha,
            asignacion.id_turno,
            int(asignacion.es_descanso),
            asignacion.observaciones,
        )
        if existing is None:
            cursor = self.connection.execute(
                """INSERT INTO asignaciones
                (id_empleado, fecha, id_turno, es_descanso, observaciones)
                VALUES (?, ?, ?, ?, ?)""",
                values,
            )
            self.connection.commit()
            return int(cursor.lastrowid)

        asignacion_id = int(existing["id"])
        self.connection.execute(
            """UPDATE asignaciones SET
            id_empleado=?, fecha=?, id_turno=?, es_descanso=?, observaciones=?
            WHERE id=?""",
            (*values, asignacion_id),
        )
        self.connection.commit()
        return asignacion_id

    def eliminar_asignacion(self, id_empleado: str, fecha: date) -> bool:
        """Elimina la asignación de un empleado para una fecha concreta.

        Retorna True si había una fila que eliminar y False si no existía.
        """
        with self.connection:
            cursor = self.connection.execute(
                "DELETE FROM asignaciones WHERE id_empleado=? AND fecha=?",
                (str(id_empleado).strip(), fecha.isoformat()),
            )
        return cursor.rowcount > 0

    def guardar_asignaciones_masivas(self, asignaciones: list[Asignacion]) -> int:
        """Inserta o reemplaza asignaciones por empleado y fecha atómicamente."""
        if not asignaciones:
            return 0
        with self.connection:
            for asignacion in asignaciones:
                if not asignacion.id_empleado or (asignacion.id_turno is None and not asignacion.es_descanso):
                    raise ValueError("Cada asignación requiere empleado y turno o descanso.")
                fecha = asignacion.fecha.isoformat()
                existente = self.connection.execute(
                    "SELECT id FROM asignaciones WHERE id_empleado=? AND fecha=? ORDER BY id LIMIT 1",
                    (asignacion.id_empleado, fecha),
                ).fetchone()
                valores = (
                    asignacion.id_empleado,
                    fecha,
                    asignacion.id_turno,
                    int(asignacion.es_descanso),
                    asignacion.observaciones,
                )
                if existente is None:
                    self.connection.execute(
                        """INSERT INTO asignaciones
                           (id_empleado, fecha, id_turno, es_descanso, observaciones)
                           VALUES (?, ?, ?, ?, ?)""",
                        valores,
                    )
                else:
                    self.connection.execute(
                        """UPDATE asignaciones SET id_empleado=?, fecha=?, id_turno=?,
                           es_descanso=?, observaciones=? WHERE id=?""",
                        (*valores, int(existente["id"])),
                    )
        return len(asignaciones)

    def listar_asignaciones(
        self,
        id_empleado: Optional[str] = None,
        fecha_inicio: Optional[date] = None,
        fecha_fin: Optional[date] = None,
    ) -> list[Asignacion]:
        clauses = []
        params = []
        if id_empleado is not None:
            clauses.append("id_empleado=?")
            params.append(id_empleado)
        if fecha_inicio is not None:
            clauses.append("fecha>=?")
            params.append(fecha_inicio.isoformat())
        if fecha_fin is not None:
            clauses.append("fecha<=?")
            params.append(fecha_fin.isoformat())

        query = "SELECT * FROM asignaciones"
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        query += " ORDER BY id_empleado, fecha"
        rows = self.connection.execute(query, params).fetchall()
        return [
            Asignacion(
                id=row["id"],
                id_empleado=row["id_empleado"],
                fecha=date.fromisoformat(row["fecha"]),
                id_turno=row["id_turno"],
                es_descanso=bool(row["es_descanso"]),
                observaciones=row["observaciones"] or "",
            )
            for row in rows
        ]

    def listar_ids_empleados_con_asignacion(
        self,
        fecha_inicio: date,
        fecha_fin: date,
        nombre_turno: str | list[str] | tuple[str, ...] | set[str] | None = None,
    ) -> set[str]:
        """IDs asignados en el período, opcionalmente con el turno indicado.

        La coincidencia del turno determina la elegibilidad del empleado; las
        demás asignaciones de esa persona dentro del período se conservan al
        comparar y exportar.
        """
        parametros: list[object] = [fecha_inicio.isoformat(), fecha_fin.isoformat()]
        consulta = """SELECT DISTINCT a.id_empleado
                      FROM asignaciones AS a"""
        if isinstance(nombre_turno, str):
            nombres_turnos = [nombre_turno] if nombre_turno else []
        else:
            nombres_turnos = sorted({str(nombre).strip() for nombre in (nombre_turno or []) if str(nombre).strip()})
        if nombres_turnos:
            consulta += " JOIN turnos AS t ON t.id = a.id_turno"
        consulta += " WHERE a.fecha >= ? AND a.fecha <= ?"
        if nombres_turnos:
            placeholders = ", ".join("?" for _ in nombres_turnos)
            consulta += f" AND t.nombre IN ({placeholders}) AND t.activo = 1"
            parametros.extend(nombres_turnos)
        consulta += " ORDER BY a.id_empleado"
        filas = self.connection.execute(consulta, parametros).fetchall()
        return {str(fila["id_empleado"]).strip() for fila in filas}

    # --- Nuevos métodos para Web & App Móvil ---

    def autenticar_unificado(self, identificador: str, clave: str) -> Optional[dict]:
        """Autentica automáticamente detectando si es Superadmin, Admin, Supervisor o Empleado."""
        ident = str(identificador).strip()
        pwd = str(clave).strip()
        if not ident or not pwd:
            return None

        # 1. Buscar en tabla usuarios_admin (superadmin, admin, supervisor)
        row = self.connection.execute(
            """SELECT username, nombre, COALESCE(rol, 'admin') AS rol
               FROM usuarios_admin
               WHERE lower(username) = lower(?) AND password_hash = ?""",
            (ident, pwd),
        ).fetchone()
        if row:
            return {
                "role": str(row["rol"] or "admin").strip().lower(),
                "id": row["username"],
                "nombre": row["nombre"],
            }

        # 2. Buscar en tabla empleados (por ID o cédula + PIN)
        return self.autenticar_empleado(ident, pwd)

    def listar_usuarios_sistema(self) -> list[dict]:
        rows = self.connection.execute(
            """SELECT username, nombre, COALESCE(rol, 'admin') AS rol
               FROM usuarios_admin
               ORDER BY CASE rol WHEN 'superadmin' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END, username"""
        ).fetchall()
        return [dict(r) for r in rows]

    def guardar_usuario_sistema(self, username: str, password: str, nombre: str, rol: str) -> None:
        u = username.strip()
        r = rol.strip().lower()
        if r not in ("superadmin", "admin", "supervisor"):
            raise ValueError("El rol debe ser superadmin, admin o supervisor.")
        if not u or not nombre.strip():
            raise ValueError("El usuario y nombre son obligatorios.")
        with self.connection:
            existente = self.connection.execute(
                "SELECT password_hash FROM usuarios_admin WHERE username = ?",
                (u,),
            ).fetchone()
            pwd_final = password.strip() if password.strip() else (existente["password_hash"] if existente else "")
            if not pwd_final:
                raise ValueError("Debe asignar una contraseña al usuario nuevo.")
            self.connection.execute(
                """INSERT INTO usuarios_admin (username, password_hash, nombre, rol)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(username) DO UPDATE SET
                   password_hash=excluded.password_hash,
                   nombre=excluded.nombre,
                   rol=excluded.rol""",
                (u, pwd_final, nombre.strip(), r),
            )

    def eliminar_usuario_sistema(self, username: str) -> None:
        u = username.strip()
        row = self.connection.execute(
            "SELECT rol FROM usuarios_admin WHERE username = ?", (u,)
        ).fetchone()
        if row and row["rol"] == "superadmin":
            total_sa = self.connection.execute(
                "SELECT COUNT(*) AS c FROM usuarios_admin WHERE rol = 'superadmin'"
            ).fetchone()["c"]
            if total_sa <= 1:
                raise ValueError("No se puede eliminar el único Superadministrador del sistema.")
        with self.connection:
            self.connection.execute("DELETE FROM usuarios_admin WHERE username = ?", (u,))

    def autenticar_admin(self, username: str, password: str, rol_esperado: Optional[str] = None) -> Optional[dict]:
        row = self.connection.execute(
            "SELECT username, nombre, COALESCE(rol, 'admin') AS rol FROM usuarios_admin WHERE username=? AND password_hash=?",
            (username.strip(), password),
        ).fetchone()
        if row:
            rol_real = str(row["rol"] or "admin").strip().lower()
            if rol_esperado and rol_real != rol_esperado and rol_real != "admin":
                return None
            return {
                "role": rol_esperado if (rol_esperado == "supervisor" and rol_real == "admin") else rol_real,
                "id": row["username"],
                "nombre": row["nombre"],
            }
        return None

    def autenticar_empleado(self, id_empleado: str, pin: str) -> Optional[dict]:
        id_limpio = str(id_empleado).strip().lstrip("'")
        # Buscar coincidencia exacta o sin ceros a la izquierda
        rows = self.connection.execute(
            "SELECT id_empleado, nombre, COALESCE(pin, '1234') AS pin, COALESCE(cargo, 'Operario') AS cargo FROM empleados"
        ).fetchall()
        for row in rows:
            emp_id = str(row["id_empleado"]).strip()
            if emp_id == id_limpio or emp_id.lstrip("0") == id_limpio.lstrip("0"):
                pin_guardado = str(row["pin"] or "1234").strip()
                ultimos_4 = emp_id[-4:] if len(emp_id) >= 4 else emp_id
                if pin.strip() == pin_guardado or (pin_guardado == "1234" and pin.strip() == ultimos_4):
                    return {
                        "role": "empleado",
                        "id": emp_id,
                        "nombre": row["nombre"],
                        "cargo": row["cargo"],
                    }
        return None

    def listar_empleados_detallado(self) -> list[dict]:
        rows = self.connection.execute(
            """SELECT id_empleado, nombre,
                      COALESCE(pin, '1234') AS pin,
                      COALESCE(cargo, 'Operario') AS cargo
               FROM empleados ORDER BY id_empleado"""
        ).fetchall()
        return [dict(r) for r in rows]

    def guardar_empleado_individual(
        self, id_empleado: str, nombre: str, cargo: str = "Operario", pin: str = "1234"
    ) -> None:
        id_limpio = str(id_empleado).strip().lstrip("'")
        with self.connection:
            self.connection.execute(
                """INSERT INTO empleados (id_empleado, nombre, cargo, pin)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(id_empleado) DO UPDATE SET
                   nombre=excluded.nombre, cargo=excluded.cargo, pin=excluded.pin""",
                (id_limpio, nombre.strip(), cargo.strip() or "Operario", pin.strip() or "1234"),
            )

    def eliminar_empleado(self, id_empleado: str) -> None:
        with self.connection:
            self.connection.execute("DELETE FROM empleados WHERE id_empleado=?", (id_empleado.strip(),))

    def registrar_marcacion_movil(
        self,
        id_empleado: str,
        tipo: str,
        latitud: Optional[float] = None,
        longitud: Optional[float] = None,
        precision_m: Optional[float] = None,
        direccion: str = "",
        dispositivo: str = "App Móvil / Web",
        observaciones: str = "",
        foto_base64: str = "",
        fecha_hora: Optional[str] = None,
    ) -> int:
        from datetime import datetime
        ahora = fecha_hora or datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with self.connection:
            cursor = self.connection.execute(
                """INSERT INTO marcaciones_moviles
                   (id_empleado, fecha_hora, tipo, latitud, longitud, precision_m, direccion, dispositivo, observaciones, foto_base64)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    str(id_empleado).strip(),
                    ahora,
                    tipo.upper().strip(),
                    latitud,
                    longitud,
                    precision_m,
                    direccion,
                    dispositivo,
                    observaciones,
                    foto_base64,
                ),
            )
            return int(cursor.lastrowid)

    def listar_marcaciones_moviles(
        self,
        id_empleado: Optional[str] = None,
        fecha_inicio: Optional[date] = None,
        fecha_fin: Optional[date] = None,
    ) -> list[dict]:
        clauses = []
        params = []
        if id_empleado:
            clauses.append("m.id_empleado = ?")
            params.append(str(id_empleado).strip())
        if fecha_inicio:
            clauses.append("substr(m.fecha_hora, 1, 10) >= ?")
            params.append(fecha_inicio.isoformat())
        if fecha_fin:
            clauses.append("substr(m.fecha_hora, 1, 10) <= ?")
            params.append(fecha_fin.isoformat())

        query = """SELECT m.*, COALESCE(e.nombre, m.id_empleado) AS nombre_empleado
                   FROM marcaciones_moviles m
                   LEFT JOIN empleados e ON e.id_empleado = m.id_empleado"""
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        query += " ORDER BY m.fecha_hora DESC"
        rows = self.connection.execute(query, params).fetchall()
        return [dict(r) for r in rows]

    def crear_solicitud(
        self,
        id_empleado: str,
        tipo: str,
        fecha_inicio: str,
        fecha_fin: str,
        motivo: str,
    ) -> int:
        from datetime import datetime
        ahora = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with self.connection:
            cursor = self.connection.execute(
                """INSERT INTO solicitudes_empleado
                   (id_empleado, tipo, fecha_inicio, fecha_fin, motivo, estado, creado_en)
                   VALUES (?, ?, ?, ?, ?, 'PENDIENTE', ?)""",
                (str(id_empleado).strip(), tipo.strip(), fecha_inicio, fecha_fin, motivo.strip(), ahora),
            )
            return int(cursor.lastrowid)

    def listar_solicitudes(self, id_empleado: Optional[str] = None) -> list[dict]:
        query = """SELECT s.*, COALESCE(e.nombre, s.id_empleado) AS nombre_empleado
                   FROM solicitudes_empleado s
                   LEFT JOIN empleados e ON e.id_empleado = s.id_empleado"""
        params = []
        if id_empleado:
            query += " WHERE s.id_empleado = ?"
            params.append(str(id_empleado).strip())
        query += " ORDER BY s.creado_en DESC"
        rows = self.connection.execute(query, params).fetchall()
        return [dict(r) for r in rows]

    def responder_solicitud(self, solicitud_id: int, estado: str, respuesta_admin: str = "") -> None:
        with self.connection:
            self.connection.execute(
                """UPDATE solicitudes_empleado
                   SET estado = ?, respuesta_admin = ?
                   WHERE id = ?""",
                (estado.upper().strip(), respuesta_admin.strip(), solicitud_id),
            )

    def close(self) -> None:
        self.connection.close()

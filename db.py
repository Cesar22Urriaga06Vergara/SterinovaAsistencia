import sqlite3
from hashlib import pbkdf2_hmac
from hmac import compare_digest
from secrets import token_bytes
from pathlib import Path
from datetime import date
from typing import Optional
import os
import sys
import shutil

from models import Asignacion, Turno


_SECRET_PREFIX = "pbkdf2_sha256$"
_SECRET_ITERATIONS = 600_000


def _hash_secret(secret: str) -> str:
    salt = token_bytes(16)
    digest = pbkdf2_hmac("sha256", secret.encode(), salt, _SECRET_ITERATIONS)
    return f"{_SECRET_PREFIX}{salt.hex()}${digest.hex()}"


def _verify_secret(secret: str, stored: str) -> bool:
    if not stored or not stored.startswith(_SECRET_PREFIX):
        return False
    try:
        salt_hex, digest_hex = stored[len(_SECRET_PREFIX):].split("$")
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(digest_hex)
    except ValueError:
        return False
    if len(salt) != 16 or len(expected) != 32:
        return False
    digest = pbkdf2_hmac("sha256", secret.encode(), salt, _SECRET_ITERATIONS)
    return compare_digest(digest, expected)


class Database:
    def __init__(self, db_path: Optional[Path] = None) -> None:
        if db_path is None:
            db_path = Path(__file__).resolve().parent / "data" / "asistencia.db"
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(str(db_path), check_same_thread=False, timeout=15.0)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA synchronous=NORMAL")
        self.connection.execute("PRAGMA busy_timeout=5000")
        self.connection.execute("PRAGMA foreign_keys=ON")

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
                estado TEXT NOT NULL DEFAULT 'PENDIENTE_SUPERVISOR',
                respuesta_admin TEXT DEFAULT '',
                creado_en TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS areas (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nombre TEXT NOT NULL UNIQUE,
                descripcion TEXT DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS comunicados (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                titulo TEXT NOT NULL,
                tipo TEXT NOT NULL DEFAULT 'MEMORANDO',
                mensaje TEXT NOT NULL,
                destino_tipo TEXT NOT NULL DEFAULT 'TODOS',
                destino_valor TEXT DEFAULT '',
                fecha_evento TEXT DEFAULT '',
                autor TEXT NOT NULL DEFAULT 'Talento Humano',
                creado_en TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS comunicados_lecturas (
                id_comunicado INTEGER NOT NULL,
                id_empleado TEXT NOT NULL,
                leido_en TEXT NOT NULL,
                PRIMARY KEY (id_comunicado, id_empleado)
            );

            CREATE TABLE IF NOT EXISTS notificaciones (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                destino_rol TEXT DEFAULT '',
                destino_id TEXT DEFAULT '',
                id_area INTEGER,
                titulo TEXT NOT NULL,
                mensaje TEXT NOT NULL,
                tipo TEXT DEFAULT 'INFO',
                leida INTEGER NOT NULL DEFAULT 0,
                creado_en TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS historico_metricas (
                id_empleado TEXT NOT NULL,
                fecha TEXT NOT NULL,
                turno TEXT DEFAULT '',
                hora_entrada_teorica TEXT DEFAULT '',
                hora_salida_teorica TEXT DEFAULT '',
                hora_entrada_real TEXT DEFAULT '',
                hora_salida_real TEXT DEFAULT '',
                horas_trabajadas REAL DEFAULT 0,
                horas_extra REAL DEFAULT 0,
                ED REAL DEFAULT 0,
                EN REAL DEFAULT 0,
                EF REAL DEFAULT 0,
                END REAL DEFAULT 0,
                RN REAL DEFAULT 0,
                RND REAL DEFAULT 0,
                RF REAL DEFAULT 0,
                minutos_tardanza INTEGER DEFAULT 0,
                estado TEXT DEFAULT '',
                observaciones TEXT DEFAULT '',
                actualizado_en TEXT NOT NULL,
                PRIMARY KEY (id_empleado, fecha)
            );

            CREATE INDEX IF NOT EXISTS idx_historico_fecha ON historico_metricas(fecha);

            """
        )
        # Semilla de áreas iniciales si no hay ninguna
        total_areas = self.connection.execute("SELECT COUNT(*) AS c FROM areas").fetchone()["c"]
        if total_areas == 0:
            for nombre_area, desc_area in (
                ("Producción", "Planta y líneas de producción"),
                ("Calidad", "Control y aseguramiento de calidad"),
                ("Conductores / Logística", "Transporte y distribución"),
                ("Administrativos", "Personal administrativo y oficinas"),
            ):
                self.connection.execute(
                    "INSERT OR IGNORE INTO areas (nombre, descripcion) VALUES (?, ?)",
                    (nombre_area, desc_area),
                )

        # Asegurar columnas en empleados (pin, cargo, id_area)
        columnas_emp = {
            row["name"]
            for row in self.connection.execute("PRAGMA table_info(empleados)").fetchall()
        }
        if "pin" not in columnas_emp:
            self.connection.execute("ALTER TABLE empleados ADD COLUMN pin TEXT")
        if "cargo" not in columnas_emp:
            self.connection.execute("ALTER TABLE empleados ADD COLUMN cargo TEXT DEFAULT 'Operario'")
        if "id_area" not in columnas_emp:
            self.connection.execute("ALTER TABLE empleados ADD COLUMN id_area INTEGER DEFAULT NULL")

        # Asegurar columna id_area en turnos
        columnas_tur = {
            row["name"]
            for row in self.connection.execute("PRAGMA table_info(turnos)").fetchall()
        }
        if "id_area" not in columnas_tur:
            self.connection.execute("ALTER TABLE turnos ADD COLUMN id_area INTEGER DEFAULT NULL")

        # Asegurar columnas adicionales en solicitudes_empleado para flujo 2 etapas
        columnas_sol = {
            row["name"]
            for row in self.connection.execute("PRAGMA table_info(solicitudes_empleado)").fetchall()
        }
        if "respuesta_supervisor" not in columnas_sol:
            self.connection.execute("ALTER TABLE solicitudes_empleado ADD COLUMN respuesta_supervisor TEXT DEFAULT ''")
        if "supervisor_usuario" not in columnas_sol:
            self.connection.execute("ALTER TABLE solicitudes_empleado ADD COLUMN supervisor_usuario TEXT DEFAULT ''")
        if "rrhh_usuario" not in columnas_sol:
            self.connection.execute("ALTER TABLE solicitudes_empleado ADD COLUMN rrhh_usuario TEXT DEFAULT ''")

        # Asegurar columnas rol e id_area en usuarios_admin
        columnas_usr = {
            row["name"]
            for row in self.connection.execute("PRAGMA table_info(usuarios_admin)").fetchall()
        }
        if "rol" not in columnas_usr:
            self.connection.execute("ALTER TABLE usuarios_admin ADD COLUMN rol TEXT DEFAULT 'admin'")
        if "id_area" not in columnas_usr:
            self.connection.execute("ALTER TABLE usuarios_admin ADD COLUMN id_area INTEGER DEFAULT NULL")

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

        with self.connection:
            self._migrar_credenciales()
            if sa_pass and sa_pass.strip():
                current = self.connection.execute(
                    "SELECT password_hash FROM usuarios_admin WHERE username = ?", (sa_user.strip(),)
                ).fetchone()
                password = sa_pass.strip()
                stored = current["password_hash"] if current else ""
                if not _verify_secret(password, stored):
                    stored = _hash_secret(password)
                self.connection.execute(
                    """INSERT INTO usuarios_admin (username, password_hash, nombre, rol)
                       VALUES (?, ?, ?, 'superadmin')
                       ON CONFLICT(username) DO UPDATE SET
                       password_hash=excluded.password_hash,
                       nombre=excluded.nombre,
                       rol='superadmin'""",
                    (sa_user.strip(), stored, sa_name.strip()),
                )

    def _migrar_credenciales(self) -> None:
        admin_rows = self.connection.execute(
            "SELECT username, password_hash FROM usuarios_admin WHERE substr(password_hash, 1, ?) != ?",
            (len(_SECRET_PREFIX), _SECRET_PREFIX),
        ).fetchall()
        self.connection.executemany(
            "UPDATE usuarios_admin SET password_hash = ? WHERE username = ?",
            [(_hash_secret(row["password_hash"].strip()), row["username"]) for row in admin_rows],
        )
        employee_rows = self.connection.execute(
            "SELECT id_empleado, pin FROM empleados WHERE pin IS NOT NULL AND substr(pin, 1, ?) != ?",
            (len(_SECRET_PREFIX), _SECRET_PREFIX),
        ).fetchall()
        for row in employee_rows:
            pin = row["pin"].strip()
            stored = _hash_secret(pin) if pin and pin != "1234" else None
            self.connection.execute("UPDATE empleados SET pin = ? WHERE id_empleado = ?", (stored, row["id_empleado"]))

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
                """INSERT INTO empleados (id_empleado, nombre, pin)
                   VALUES (?, ?, NULL)
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

    # --- Nuevos métodos para Web & App Móvil (6 Roles, Áreas, Memorandos y Notificaciones) ---

    def listar_areas(self) -> list[dict]:
        rows = self.connection.execute(
            """SELECT a.id, a.nombre, COALESCE(a.descripcion, '') AS descripcion,
                      (SELECT COUNT(*) FROM empleados e WHERE e.id_area = a.id) AS total_empleados,
                      (SELECT COUNT(*) FROM usuarios_admin u WHERE u.id_area = a.id AND u.rol = 'supervisor') AS total_supervisores
               FROM areas a
               ORDER BY a.nombre"""
        ).fetchall()
        return [dict(r) for r in rows]

    def guardar_area(self, nombre: str, descripcion: str = "", area_id: Optional[int] = None) -> int:
        nom = nombre.strip()
        if not nom:
            raise ValueError("El nombre del área es obligatorio.")
        with self.connection:
            if area_id:
                self.connection.execute(
                    "UPDATE areas SET nombre=?, descripcion=? WHERE id=?",
                    (nom, descripcion.strip(), int(area_id)),
                )
                return int(area_id)
            cursor = self.connection.execute(
                """INSERT INTO areas (nombre, descripcion)
                   VALUES (?, ?)
                   ON CONFLICT(nombre) DO UPDATE SET descripcion=excluded.descripcion""",
                (nom, descripcion.strip()),
            )
            return int(cursor.lastrowid or 0)

    def eliminar_area(self, area_id: int) -> None:
        with self.connection:
            self.connection.execute("UPDATE empleados SET id_area = NULL WHERE id_area = ?", (int(area_id),))
            self.connection.execute("UPDATE usuarios_admin SET id_area = NULL WHERE id_area = ?", (int(area_id),))
            self.connection.execute("UPDATE turnos SET id_area = NULL WHERE id_area = ?", (int(area_id),))
            self.connection.execute("DELETE FROM areas WHERE id = ?", (int(area_id),))

    def autenticar_unificado(self, identificador: str, clave: str) -> Optional[dict]:
        """Autentica automáticamente detectando cualquiera de los 6 roles:
        superadmin, admin, supervisor, auditor, talento_humano o empleado."""
        ident = str(identificador).strip()
        pwd = str(clave).strip()
        if not ident or not pwd:
            return None

        # 1. Buscar en tabla usuarios_admin
        rows = self.connection.execute(
            """SELECT u.username, u.nombre, COALESCE(u.rol, 'admin') AS rol,
                      u.id_area, COALESCE(a.nombre, '') AS nombre_area, u.password_hash
               FROM usuarios_admin u
               LEFT JOIN areas a ON a.id = u.id_area
               WHERE lower(u.username) = lower(?)""",
            (ident,),
        ).fetchall()
        row = next((item for item in rows if _verify_secret(pwd, item["password_hash"])), None)
        if row:
            return {
                "role": str(row["rol"] or "admin").strip().lower(),
                "id": row["username"],
                "nombre": row["nombre"],
                "id_area": row["id_area"],
                "nombre_area": row["nombre_area"] or "Todas las Áreas",
            }

        # 2. Buscar en tabla empleados (por ID o cédula + PIN)
        return self.autenticar_empleado(ident, pwd)

    def listar_usuarios_sistema(self) -> list[dict]:
        rows = self.connection.execute(
            """SELECT u.username, u.nombre, COALESCE(u.rol, 'admin') AS rol,
                      u.id_area, COALESCE(a.nombre, 'Global / Todas las Áreas') AS nombre_area
               FROM usuarios_admin u
               LEFT JOIN areas a ON a.id = u.id_area
               ORDER BY CASE u.rol
                   WHEN 'superadmin' THEN 1
                   WHEN 'admin' THEN 2
                   WHEN 'auditor' THEN 3
                   WHEN 'talento_humano' THEN 4
                   ELSE 5 END, u.username"""
        ).fetchall()
        return [dict(r) for r in rows]

    def guardar_usuario_sistema(
        self,
        username: str,
        password: str,
        nombre: str,
        rol: str,
        id_area: Optional[int] = None,
    ) -> None:
        u = username.strip()
        r = rol.strip().lower()
        roles_validos = ("superadmin", "admin", "supervisor", "auditor", "talento_humano")
        if r not in roles_validos:
            raise ValueError(f"El rol debe ser uno de: {', '.join(roles_validos)}")
        if not u or not nombre.strip():
            raise ValueError("El usuario y nombre son obligatorios.")
        if r == "supervisor" and not id_area:
            raise ValueError("Todo Supervisor debe estar asignado a un Área.")
        with self.connection:
            existente = self.connection.execute(
                "SELECT password_hash FROM usuarios_admin WHERE username = ?",
                (u,),
            ).fetchone()
            pwd_final = _hash_secret(password.strip()) if password.strip() else (existente["password_hash"] if existente else "")
            if not pwd_final:
                raise ValueError("Debe asignar una contraseña al usuario nuevo.")
            self.connection.execute(
                """INSERT INTO usuarios_admin (username, password_hash, nombre, rol, id_area)
                   VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(username) DO UPDATE SET
                   password_hash=excluded.password_hash,
                   nombre=excluded.nombre,
                   rol=excluded.rol,
                   id_area=excluded.id_area""",
                (u, pwd_final, nombre.strip(), r, int(id_area) if id_area else None),
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
        return self.autenticar_unificado(username, password)

    def autenticar_empleado(self, id_empleado: str, pin: str) -> Optional[dict]:
        id_limpio = str(id_empleado).strip().lstrip("'")
        rows = self.connection.execute(
            """SELECT e.id_empleado, e.nombre,
                      e.pin,
                      COALESCE(e.cargo, 'Operario') AS cargo,
                      e.id_area, COALESCE(a.nombre, 'Sin Área Asignada') AS nombre_area
               FROM empleados e
               LEFT JOIN areas a ON a.id = e.id_area"""
        ).fetchall()
        for row in rows:
            emp_id = str(row["id_empleado"]).strip()
            if emp_id == id_limpio or emp_id.lstrip("0") == id_limpio.lstrip("0"):
                if _verify_secret(pin.strip(), row["pin"]):
                    return {
                        "role": "empleado",
                        "id": emp_id,
                        "nombre": row["nombre"],
                        "cargo": row["cargo"],
                        "id_area": row["id_area"],
                        "nombre_area": row["nombre_area"],
                    }
        return None

    def listar_empleados_detallado(self, id_area: Optional[int] = None) -> list[dict]:
        query = """SELECT e.id_empleado, e.nombre,
                          COALESCE(e.cargo, 'Operario') AS cargo,
                          e.id_area, COALESCE(a.nombre, 'Sin Área') AS nombre_area
                   FROM empleados e
                   LEFT JOIN areas a ON a.id = e.id_area"""
        params = []
        if id_area is not None:
            query += " WHERE e.id_area = ?"
            params.append(int(id_area))
        query += " ORDER BY e.id_empleado"
        rows = self.connection.execute(query, params).fetchall()
        return [dict(r) for r in rows]

    def guardar_empleado_individual(
        self,
        id_empleado: str,
        nombre: str,
        cargo: str = "Operario",
        pin: str = "",
        id_area: Optional[int] = None,
    ) -> None:
        id_limpio = str(id_empleado).strip().lstrip("'")
        new_pin = pin.strip()
        if new_pin == "1234":
            raise ValueError("Asigne un PIN distinto del PIN compartido anterior.")
        pin_hash = _hash_secret(new_pin) if new_pin else None
        with self.connection:
            self.connection.execute(
                """INSERT INTO empleados (id_empleado, nombre, cargo, pin, id_area)
                   VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(id_empleado) DO UPDATE SET
                   nombre=excluded.nombre,
                   cargo=excluded.cargo,
                   pin=COALESCE(excluded.pin, empleados.pin),
                   id_area=COALESCE(excluded.id_area, empleados.id_area)""",
                (
                    id_limpio,
                    nombre.strip(),
                    cargo.strip() or "Operario",
                    pin_hash,
                    int(id_area) if id_area else None,
                ),
            )

    def eliminar_empleado(self, id_empleado: str) -> None:
        with self.connection:
            self.connection.execute("DELETE FROM empleados WHERE id_empleado=?", (id_empleado.strip(),))

    def listar_turnos_detallado(self, id_area: Optional[int] = None, incluir_globales: bool = True) -> list[dict]:
        query = """SELECT t.*, COALESCE(a.nombre, 'Global / Todas las Áreas') AS nombre_area
                   FROM turnos t
                   LEFT JOIN areas a ON a.id = t.id_area"""
        params = []
        if id_area is not None:
            if incluir_globales:
                query += " WHERE (t.id_area = ? OR t.id_area IS NULL)"
            else:
                query += " WHERE t.id_area = ?"
            params.append(int(id_area))
        query += " ORDER BY t.nombre"
        rows = self.connection.execute(query, params).fetchall()
        return [dict(r) for r in rows]

    def guardar_turno_con_area(self, turno: Turno, id_area: Optional[int] = None) -> int:
        turno_id = self.guardar_turno(turno)
        with self.connection:
            self.connection.execute(
                "UPDATE turnos SET id_area = ? WHERE id = ?",
                (int(id_area) if id_area else None, int(turno_id)),
            )
        return turno_id

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
        fecha_hora: Optional[str] = None,
    ) -> int:
        from datetime import datetime
        ahora = fecha_hora or datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with self.connection:
            cursor = self.connection.execute(
                """INSERT INTO marcaciones_moviles
                   (id_empleado, fecha_hora, tipo, latitud, longitud, precision_m, direccion, dispositivo, observaciones)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
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
                ),
            )
            return int(cursor.lastrowid)

    def listar_marcaciones_moviles(
        self,
        id_empleado: Optional[str] = None,
        fecha_inicio: Optional[date] = None,
        fecha_fin: Optional[date] = None,
        id_area: Optional[int] = None,
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
        if id_area is not None:
            clauses.append("e.id_area = ?")
            params.append(int(id_area))

        query = """SELECT m.id, m.id_empleado, m.fecha_hora, m.tipo, m.latitud, m.longitud,
                          m.precision_m, m.direccion, m.dispositivo, m.observaciones,
                          COALESCE(e.nombre, m.id_empleado) AS nombre_empleado,
                          e.id_area, COALESCE(a.nombre, 'Sin Área') AS nombre_area
                   FROM marcaciones_moviles m
                   LEFT JOIN empleados e ON e.id_empleado = m.id_empleado
                   LEFT JOIN areas a ON a.id = e.id_area"""
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        query += " ORDER BY m.fecha_hora DESC"
        rows = self.connection.execute(query, params).fetchall()
        return [dict(r) for r in rows]

    # --- NOTIFICACIONES EN TIEMPO REAL ---
    def crear_notificacion(
        self,
        titulo: str,
        mensaje: str,
        tipo: str = "INFO",
        destino_rol: str = "",
        destino_id: str = "",
        id_area: Optional[int] = None,
    ) -> int:
        from datetime import datetime
        ahora = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with self.connection:
            cursor = self.connection.execute(
                """INSERT INTO notificaciones
                   (destino_rol, destino_id, id_area, titulo, mensaje, tipo, leida, creado_en)
                   VALUES (?, ?, ?, ?, ?, ?, 0, ?)""",
                (
                    destino_rol.strip().lower(),
                    str(destino_id).strip(),
                    int(id_area) if id_area else None,
                    titulo.strip(),
                    mensaje.strip(),
                    tipo.strip().upper(),
                    ahora,
                ),
            )
            return int(cursor.lastrowid)

    def listar_notificaciones_para_usuario(
        self,
        rol: str,
        user_id: str,
        id_area: Optional[int] = None,
    ) -> list[dict]:
        r = rol.strip().lower()
        u = str(user_id).strip()
        rows = self.connection.execute(
            """SELECT * FROM notificaciones
               WHERE (destino_id = ?)
                  OR (destino_rol = ? AND (destino_id = '' OR destino_id IS NULL) AND (id_area IS NULL OR id_area = ?))
                  OR (destino_rol = 'todos' AND (id_area IS NULL OR id_area = ?))
               ORDER BY id DESC LIMIT 40""",
            (u, r, int(id_area) if id_area else -1, int(id_area) if id_area else -1),
        ).fetchall()
        return [dict(x) for x in rows]

    def marcar_notificacion_leida(self, notif_id: int) -> None:
        with self.connection:
            self.connection.execute("UPDATE notificaciones SET leida = 1 WHERE id = ?", (int(notif_id),))

    # --- FLUJO DE SOLICITUDES Y PERMISOS (EMPLEADO -> SUPERVISOR -> TALENTO HUMANO) ---
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
        emp_row = self.connection.execute(
            "SELECT nombre, id_area FROM empleados WHERE id_empleado = ?",
            (str(id_empleado).strip(),),
        ).fetchone()
        nombre_emp = emp_row["nombre"] if emp_row else id_empleado
        id_area = emp_row["id_area"] if emp_row else None

        with self.connection:
            cursor = self.connection.execute(
                """INSERT INTO solicitudes_empleado
                   (id_empleado, tipo, fecha_inicio, fecha_fin, motivo, estado, creado_en)
                   VALUES (?, ?, ?, ?, ?, 'PENDIENTE_SUPERVISOR', ?)""",
                (str(id_empleado).strip(), tipo.strip(), fecha_inicio, fecha_fin, motivo.strip(), ahora),
            )
            sol_id = int(cursor.lastrowid)

        self.crear_notificacion(
            titulo=f"Nueva solicitud de {nombre_emp}",
            mensaje=f"{tipo} ({fecha_inicio} a {fecha_fin}): {motivo}",
            tipo="PERMISO",
            destino_rol="supervisor",
            id_area=id_area,
        )
        return sol_id

    def listar_solicitudes(
        self,
        id_empleado: Optional[str] = None,
        id_area: Optional[int] = None,
    ) -> list[dict]:
        query = """SELECT s.*, COALESCE(e.nombre, s.id_empleado) AS nombre_empleado,
                          e.id_area, COALESCE(a.nombre, 'Sin Área') AS nombre_area
                   FROM solicitudes_empleado s
                   LEFT JOIN empleados e ON e.id_empleado = s.id_empleado
                   LEFT JOIN areas a ON a.id = e.id_area"""
        clauses = []
        params = []
        if id_empleado:
            clauses.append("s.id_empleado = ?")
            params.append(str(id_empleado).strip())
        if id_area is not None:
            clauses.append("e.id_area = ?")
            params.append(int(id_area))
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        query += " ORDER BY s.creado_en DESC"
        rows = self.connection.execute(query, params).fetchall()
        return [dict(r) for r in rows]

    def responder_solicitud(
        self,
        solicitud_id: int,
        estado: str,
        respuesta: str = "",
        autor_rol: str = "supervisor",
        autor_nombre: str = "",
    ) -> None:
        sol = self.connection.execute(
            """SELECT s.*, COALESCE(e.nombre, s.id_empleado) AS nombre_empleado
               FROM solicitudes_empleado s
               LEFT JOIN empleados e ON e.id_empleado = s.id_empleado
               WHERE s.id = ?""",
            (int(solicitud_id),),
        ).fetchone()
        if not sol:
            raise ValueError("Solicitud no encontrada.")

        est = estado.upper().strip()
        rol_limpio = autor_rol.strip().lower()

        with self.connection:
            if rol_limpio == "supervisor":
                # El supervisor avala (pasa a Talento Humano) o rechaza
                nuevo_estado = "AVALADO_SUPERVISOR" if est in ("AVALADO_SUPERVISOR", "APROBADA") else "RECHAZADA_SUPERVISOR"
                self.connection.execute(
                    """UPDATE solicitudes_empleado
                       SET estado = ?, respuesta_supervisor = ?, supervisor_usuario = ?
                       WHERE id = ?""",
                    (nuevo_estado, respuesta.strip(), autor_nombre, int(solicitud_id)),
                )
            else:
                # Talento Humano o Superadmin da la aprobación/rechazo final
                nuevo_estado = "APROBADA" if est == "APROBADA" else "RECHAZADA"
                self.connection.execute(
                    """UPDATE solicitudes_empleado
                       SET estado = ?, respuesta_admin = ?, rrhh_usuario = ?
                       WHERE id = ?""",
                    (nuevo_estado, respuesta.strip(), autor_nombre, int(solicitud_id)),
                )

        if nuevo_estado == "AVALADO_SUPERVISOR":
            self.crear_notificacion(
                titulo=f"Permiso Avalado por Supervisor ({sol['nombre_empleado']})",
                mensaje=f"Pendiente aprobación final de Talento Humano: {sol['tipo']} ({sol['fecha_inicio']} a {sol['fecha_fin']})",
                tipo="RRHH",
                destino_rol="talento_humano",
            )
            self.crear_notificacion(
                titulo="Tu Supervisor avaló tu solicitud",
                mensaje=f"Tu solicitud de {sol['tipo']} pasó a Talento Humano para aprobación final.",
                tipo="INFO",
                destino_id=sol["id_empleado"],
            )
        else:
            self.crear_notificacion(
                titulo=f"Respuesta a tu solicitud ({nuevo_estado})",
                mensaje=f"{sol['tipo']} ({sol['fecha_inicio']}): {respuesta or nuevo_estado}",
                tipo="PERMISO",
                destino_id=sol["id_empleado"],
            )

    # --- MEMORANDOS, CITACIONES A CAPACITACIÓN Y COMUNICADOS (TALENTO HUMANO) ---
    def crear_comunicado(
        self,
        titulo: str,
        tipo: str,
        mensaje: str,
        destino_tipo: str = "TODOS",
        destino_valor: str = "",
        fecha_evento: str = "",
        autor: str = "Talento Humano",
    ) -> int:
        from datetime import datetime
        ahora = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        dt_tipo = destino_tipo.strip().upper()  # 'TODOS' | 'AREA' | 'EMPLEADO'
        dt_val = str(destino_valor).strip()

        with self.connection:
            cursor = self.connection.execute(
                """INSERT INTO comunicados
                   (titulo, tipo, mensaje, destino_tipo, destino_valor, fecha_evento, autor, creado_en)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    titulo.strip(),
                    tipo.strip().upper(),
                    mensaje.strip(),
                    dt_tipo,
                    dt_val,
                    fecha_evento.strip(),
                    autor.strip(),
                    ahora,
                ),
            )
            com_id = int(cursor.lastrowid)

        # Disparar notificación en tiempo real según destinatario
        if dt_tipo == "EMPLEADO" and dt_val:
            self.crear_notificacion(
                titulo=f"📢 {tipo}: {titulo}",
                mensaje=mensaje,
                tipo="MEMORANDO",
                destino_id=dt_val,
            )
        elif dt_tipo == "AREA" and dt_val.isdigit():
            self.crear_notificacion(
                titulo=f"📢 {tipo} de Área: {titulo}",
                mensaje=mensaje,
                tipo="MEMORANDO",
                destino_rol="todos",
                id_area=int(dt_val),
            )
        else:
            self.crear_notificacion(
                titulo=f"📢 {tipo} General: {titulo}",
                mensaje=mensaje,
                tipo="MEMORANDO",
                destino_rol="todos",
            )
        return com_id

    def listar_comunicados(
        self,
        id_empleado: Optional[str] = None,
        id_area: Optional[int] = None,
    ) -> list[dict]:
        rows = self.connection.execute(
            """SELECT c.*,
                      (SELECT COUNT(*) FROM comunicados_lecturas cl WHERE cl.id_comunicado = c.id) AS total_lecturas
               FROM comunicados c
               ORDER BY c.id DESC"""
        ).fetchall()
        areas_map = {str(a["id"]): a["nombre"] for a in self.listar_areas()}
        emps_map = dict(self.listar_empleados())

        lecturas_emp = set()
        if id_empleado:
            l_rows = self.connection.execute(
                "SELECT id_comunicado FROM comunicados_lecturas WHERE id_empleado = ?",
                (str(id_empleado).strip(),),
            ).fetchall()
            lecturas_emp = {r["id_comunicado"] for r in l_rows}

        resultado = []
        for r in rows:
            item = dict(r)
            dt_tipo = item["destino_tipo"]
            dt_val = str(item["destino_valor"] or "")
            if id_empleado:
                if dt_tipo == "EMPLEADO" and dt_val != str(id_empleado).strip():
                    continue
                if dt_tipo == "AREA" and str(id_area or "") != dt_val:
                    continue
            if dt_tipo == "TODOS":
                item["destino_etiqueta"] = "Toda la Empresa"
            elif dt_tipo == "AREA":
                item["destino_etiqueta"] = f"Área: {areas_map.get(dt_val, dt_val)}"
            else:
                item["destino_etiqueta"] = f"Empleado: {emps_map.get(dt_val, dt_val)}"
            item["leido_por_mi"] = item["id"] in lecturas_emp
            resultado.append(item)
        return resultado

    def confirmar_lectura_comunicado(self, id_comunicado: int, id_empleado: str) -> None:
        from datetime import datetime
        ahora = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with self.connection:
            self.connection.execute(
                """INSERT OR REPLACE INTO comunicados_lecturas (id_comunicado, id_empleado, leido_en)
                   VALUES (?, ?, ?)""",
                (int(id_comunicado), str(id_empleado).strip(), ahora),
            )

    # --- HISTÓRICO PERMANENTE DE MÉTRICAS (PARA ADMIN GENERAL Y AUDITOR) ---
    def guardar_historico_metricas(self, filas: list[dict]) -> int:
        from datetime import datetime
        if not filas:
            return 0
        ahora = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        registros = []
        for f in filas:
            emp_id = str(f.get("id_empleado", "")).strip()
            fecha_val = str(f.get("fecha", ""))[:10]
            if not emp_id or not fecha_val:
                continue
            registros.append(
                (
                    emp_id,
                    fecha_val,
                    str(f.get("turno", "") or ""),
                    str(f.get("hora_entrada_teorica", "") or ""),
                    str(f.get("hora_salida_teorica", "") or ""),
                    str(f.get("hora_entrada_real", "") or ""),
                    str(f.get("hora_salida_real", "") or ""),
                    float(f.get("horas_trabajadas", 0) or 0),
                    float(f.get("horas_extra", 0) or 0),
                    float(f.get("ED", 0) or 0),
                    float(f.get("EN", 0) or 0),
                    float(f.get("EF", 0) or 0),
                    float(f.get("END", 0) or 0),
                    float(f.get("RN", 0) or 0),
                    float(f.get("RND", 0) or 0),
                    float(f.get("RF", 0) or 0),
                    int(f.get("minutos_tardanza", 0) or 0),
                    str(f.get("estado", "") or ""),
                    str(f.get("observaciones", "") or ""),
                    ahora,
                )
            )
        with self.connection:
            self.connection.executemany(
                """INSERT OR REPLACE INTO historico_metricas (
                       id_empleado, fecha, turno,
                       hora_entrada_teorica, hora_salida_teorica,
                       hora_entrada_real, hora_salida_real,
                       horas_trabajadas, horas_extra,
                       ED, EN, EF, END, RN, RND, RF,
                       minutos_tardanza, estado, observaciones, actualizado_en
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                registros,
            )
        return len(registros)

    def listar_historico_metricas(self) -> list[dict]:
        rows = self.connection.execute(
            """SELECT id_empleado, fecha, turno,
                      hora_entrada_teorica, hora_salida_teorica,
                      hora_entrada_real, hora_salida_real,
                      horas_trabajadas, horas_extra,
                      ED, EN, EF, END, RN, RND, RF,
                      minutos_tardanza, estado, observaciones
               FROM historico_metricas
               ORDER BY fecha DESC, id_empleado"""
        ).fetchall()
        return [dict(r) for r in rows]

    # --- ESTADÍSTICAS Y LIMPIEZA SEGURA DE ALMACENAMIENTO ---
    def estadisticas_bd(self) -> dict:
        row = self.connection.execute(
            """SELECT
                   (SELECT COUNT(*) FROM historico_metricas) AS total_metricas,
                   (SELECT COUNT(*) FROM notificaciones WHERE leida = 1) AS total_notifs_leidas"""
        ).fetchone()
        return {
            "total_metricas": int(row["total_metricas"] or 0),
            "total_notifs_leidas": int(row["total_notifs_leidas"] or 0),
        }

    def limpiar_notificaciones_leidas(self, dias: int = 30) -> int:
        from datetime import datetime, timedelta
        corte = (datetime.now() - timedelta(days=max(0, int(dias)))).strftime("%Y-%m-%d %H:%M:%S")
        with self.connection:
            if dias <= 0:
                cur = self.connection.execute("DELETE FROM notificaciones WHERE leida = 1")
            else:
                cur = self.connection.execute(
                    "DELETE FROM notificaciones WHERE leida = 1 AND creado_en < ?",
                    (corte,),
                )
            return int(cur.rowcount or 0)

    def compactar_bd(self) -> None:
        self.connection.execute("VACUUM")

    def close(self) -> None:
        self.connection.close()

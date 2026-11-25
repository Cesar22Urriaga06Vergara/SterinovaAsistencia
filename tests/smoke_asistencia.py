"""Run with python tests/smoke_asistencia.py after installing requirements.txt."""

import base64
import io
import json
import os
import shutil
import subprocess
import sys
import unittest
from contextlib import closing
from datetime import date
from http.cookiejar import CookieJar
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import HTTPCookieProcessor, Request, build_opener, urlopen

from openpyxl import Workbook, load_workbook


ROOT = Path(__file__).resolve().parents[1]
DAY = date(2026, 11, 23)


def request(base_url, path, payload=None, *, open_request=urlopen, headers=None, method=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = Request(base_url + path, data, {"Content-Type": "application/json", **(headers or {})}, method=method)
    with open_request(req, timeout=20) as response:
        return response.read()


def seed(database, assignment_model, shift_model):
    first_area = database.guardar_area("Operaciones de prueba", "")
    second_area = database.guardar_area("Administración de prueba", "")
    password = "SoloDatosDePrueba2026"
    roles = ("superadmin", "admin", "supervisor", "auditor", "talento_humano")
    for role in roles:
        area = first_area if role == "supervisor" else None
        database.guardar_usuario_sistema(f"prueba_{role}", password, role, role, area)

    database.guardar_empleado_individual("99001", "Persona Excel", pin="7164", id_area=first_area)
    database.guardar_empleado_individual("99002", "Persona Móvil", pin="5926", id_area=second_area)
    night = database.guardar_turno_con_area(
        shift_model(None, "Nocturno de prueba", "18:00", "23:00"), first_area
    )
    day = database.guardar_turno_con_area(
        shift_model(None, "Diurno de prueba", "08:00", "17:00"), second_area
    )
    database.guardar_asignacion(assignment_model(None, "99001", DAY, night))
    database.guardar_asignacion(assignment_model(None, "99002", DAY, day))
    database.guardar_dia_festivo(date(2026, 11, 24), "Festivo ficticio")
    database.registrar_marcacion_movil("99002", "ENTRADA", fecha_hora=f"{DAY} 08:00:00")
    database.registrar_marcacion_movil("99002", "SALIDA", fecha_hora=f"{DAY} 17:00:00")
    return {**{f"prueba_{role}": (password, role) for role in roles}, "99001": ("7164", "empleado")}


def excel_payload():
    workbook = Workbook()
    sheet = workbook.active
    sheet.append(["ID_Empleado", "Fecha", "Hora"])
    sheet.append(["99001", DAY.strftime("%d/%m/%Y"), "18:00"])
    sheet.append(["99001", DAY.strftime("%d/%m/%Y"), "23:00"])
    with io.BytesIO() as stream:
        workbook.save(stream)
        return base64.b64encode(stream.getvalue()).decode("ascii")


class AttendanceSmokeTest(unittest.TestCase):
    def test_web_login_excel_and_mobile_to_report(self):
        with TemporaryDirectory() as temp:
            sandbox = Path(temp)
            for name in ("server.py", "db.py", "models.py"):
                shutil.copy2(ROOT / name, sandbox)
            for name in ("core", "public"):
                shutil.copytree(ROOT / name, sandbox / name, ignore=shutil.ignore_patterns("__pycache__"))
            (sandbox / "data").mkdir()
            for template in (ROOT / "data").glob("*.xlsx"):
                shutil.copy2(template, sandbox / "data")

            data_dir = sandbox / "estado"
            entorno = {"SUPERADMIN_PASS": "", "ASISTENCIA_DATA_DIR": str(data_dir)}
            with patch.dict(os.environ, entorno), patch.object(
                sys, "path", [str(sandbox), *sys.path]
            ):
                import server

            with closing(server.DB):
                columns = server.DB.connection.execute("PRAGMA table_info(marcaciones_moviles)").fetchall()
                self.assertNotIn("foto_base64", {column["name"] for column in columns})
                accounts = seed(server.DB, server.Asignacion, server.Turno)
                with server.DB.connection:
                    server.DB.connection.execute(
                        "ALTER TABLE marcaciones_moviles ADD COLUMN foto_base64 TEXT DEFAULT ''"
                    )
                    server.DB.connection.execute(
                        "UPDATE marcaciones_moviles SET foto_base64 = ? WHERE id_empleado = ?",
                        ("foto-anterior-ficticia", "99002"),
                    )
                    server.DB.connection.execute(
                        "INSERT INTO usuarios_admin (username, password_hash, nombre, rol) VALUES (?, ?, ?, ?)",
                        ("legacy_admin", "ClaveAnterior2026", "Admin anterior", "admin"),
                    )
                    server.DB.connection.executemany(
                        "INSERT INTO empleados (id_empleado, nombre, pin) VALUES (?, ?, ?)",
                        [("99127", "PIN anterior", "7168"), ("99428", "PIN compartido", "1234")],
                    )
                server.DB.initialize()
                legacy_admin = server.DB.connection.execute(
                    "SELECT password_hash FROM usuarios_admin WHERE username = ?", ("legacy_admin",)
                ).fetchone()[0]
                self.assertNotEqual(legacy_admin, "ClaveAnterior2026")
                self.assertEqual(server.DB.autenticar_unificado("LEGACY_ADMIN", "ClaveAnterior2026")["role"], "admin")
                self.assertIsNone(server.DB.autenticar_unificado("legacy_admin", legacy_admin))
                self.assertIsNotNone(server.DB.autenticar_empleado("99127", "7168"))
                self.assertIsNone(server.DB.autenticar_empleado("99428", "1234"))
                self.assertIsNone(server.DB.autenticar_empleado("99428", "9428"))
                server.DB.initialize()
                self.assertEqual(server.DB.connection.execute(
                    "SELECT password_hash FROM usuarios_admin WHERE username = ?", ("legacy_admin",)
                ).fetchone()[0], legacy_admin)
                with server.ThreadingHTTPServer(("127.0.0.1", 0), server.NominaAPIHandler) as http:
                    worker = Thread(target=http.serve_forever, daemon=True)
                    worker.start()
                    try:
                        base_url = f"http://127.0.0.1:{http.server_port}"
                        self.assertIn(b"<html", request(base_url, "/").lower())
                        with self.assertRaises(HTTPError) as denied:
                            request(base_url, "/api/reportes")
                        self.assertEqual(denied.exception.code, 401)
                        for identifier, (password, role) in accounts.items():
                            login = json.loads(request(base_url, "/api/login", {
                                "identificador": identifier, "clave": password,
                            }))
                            self.assertEqual(login["user"]["role"], role)

                        cookies = CookieJar()
                        opener = build_opener(HTTPCookieProcessor(cookies))
                        def authenticated(path, payload=None):
                            return request(base_url, path, payload, open_request=opener.open)

                        password, _ = accounts["prueba_admin"]
                        authenticated("/api/login", {"identificador": "prueba_admin", "clave": password})
                        self.assertTrue(json.loads(authenticated("/api/empleados"))["empleados"])
                        with self.assertRaises(HTTPError) as denied:
                            authenticated("/api/empleados", {"id_empleado": "99001", "nombre": "Sin permiso"})
                        self.assertEqual(denied.exception.code, 403)
                        password, _ = accounts["prueba_superadmin"]
                        authenticated("/api/login", {"identificador": "prueba_superadmin", "clave": password})
                        session_cookie, = cookies
                        self.assertTrue(session_cookie.has_nonstandard_attr("HttpOnly"))
                        self.assertEqual(session_cookie.get_nonstandard_attr("SameSite"), "Strict")
                        self.assertEqual(json.loads(authenticated("/api/sesion"))["user"]["role"], "superadmin")
                        empleados = json.loads(authenticated("/api/empleados"))["empleados"]
                        self.assertTrue(empleados)
                        self.assertTrue(all("pin" not in empleado for empleado in empleados))
                        authenticated("/api/empleados", {"id_empleado": "99001", "nombre": "Persona editada"})
                        self.assertIsNotNone(server.DB.autenticar_empleado("99001", "7164"))
                        authenticated("/api/empleados", {
                            "id_empleado": "99001", "nombre": "Persona editada", "pin": "8137",
                        })
                        self.assertIsNone(server.DB.autenticar_empleado("99001", "7164"))
                        self.assertIsNotNone(server.DB.autenticar_empleado("99001", "8137"))
                        roster = Workbook()
                        roster.active.append(["ID", "Nombre"])
                        roster.active.append(["99001", "Persona importada"])
                        roster.active.append(["99501", "Persona sin acceso"])
                        with io.BytesIO() as stream:
                            roster.save(stream)
                            roster_content = base64.b64encode(stream.getvalue()).decode("ascii")
                        imported = json.loads(authenticated("/api/empleados/importar-excel", {
                            "filename": "empleados.xlsx", "content_base64": roster_content,
                        }))
                        self.assertEqual(imported["importados"], 2)
                        self.assertIsNotNone(server.DB.autenticar_empleado("99001", "8137"))
                        self.assertIsNone(server.DB.autenticar_empleado("99501", "1234"))

                        result = json.loads(authenticated("/api/procesar-huellero", {
                            "fecha_inicio": str(DAY),
                            "fecha_fin": str(DAY),
                            "incluir_marcaciones_app": True,
                            "archivos": [{"filename": "huellero.xlsx", "content_base64": excel_payload()}],
                        }))
                        self.assertTrue(result["ok"])
                        self.assertEqual(result["estadisticas"]["en_periodo"], 4)
                        self.assertEqual(result["filas_generadas"], 2)
                        self.assertEqual(len(server.DB.listar_historico_metricas()), 2)
                        self.assertEqual(list(server.UPLOADS_DIR.iterdir()), [])
                        analisis = json.loads(authenticated(
                            "/api/analisis?turno=Nocturno%20de%20prueba&turno=Diurno%20de%20prueba"
                        ))
                        self.assertEqual(len(analisis["filas"]), 2)

                        report = next(item for item in result["reportes"] if item["tipo"].startswith("Comparativo"))
                        with closing(load_workbook(io.BytesIO(authenticated(report["url"])), read_only=True)) as workbook:
                            self.assertEqual(workbook.sheetnames, ["Detalle", "Resumen por empleado"])
                            header, *rows, total = workbook["Detalle"].values
                            employee_column = header.index("id_empleado")
                            self.assertCountEqual([row[employee_column] for row in rows], ["99001", "99002"])
                            self.assertEqual(total[0], "TOTAL")
                        persisted = {row["id_empleado"]: row for row in server.DB.listar_historico_metricas()}
                        self.assertEqual(persisted["99001"]["RN"], 4)
                        self.assertEqual(persisted["99001"]["horas_trabajadas"], 5)
                        self.assertEqual(persisted["99002"]["horas_trabajadas"], 9)
                        punch = json.loads(authenticated("/api/empleado/marcar", {
                            "id_empleado": "99501", "tipo": "ENTRADA",
                            "latitud": 4.7, "longitud": -74.1, "precision_m": 9,
                            "direccion": "Dirección de prueba", "observaciones": "Nota de prueba",
                            "foto_base64": "campo-enviado-por-cliente-anterior",
                        }))
                        punches = json.loads(authenticated("/api/marcaciones-moviles"))["marcaciones"]
                        self.assertTrue(all("foto_base64" not in mark for mark in punches))
                        mark = next(item for item in punches if item["id"] == punch["id"])
                        self.assertEqual((mark["latitud"], mark["longitud"], mark["precision_m"]), (4.7, -74.1, 9))
                        self.assertEqual(mark["direccion"], "Dirección de prueba")
                        self.assertEqual(mark["observaciones"], "Nota de prueba")
                        self.assertEqual(server.DB.connection.execute(
                            "SELECT foto_base64 FROM marcaciones_moviles WHERE id = ?", (punch["id"],)
                        ).fetchone()[0], "")

                        def login_as(identifier):
                            client = build_opener(HTTPCookieProcessor(CookieJar()))
                            password, _ = accounts[identifier]
                            request(base_url, "/api/login", {"identificador": identifier, "clave": password}, open_request=client.open)
                            return lambda path, payload=None: request(base_url, path, payload, open_request=client.open)

                        hr = login_as("prueba_talento_humano")
                        auditor = login_as("prueba_auditor")
                        area_by_employee = {
                            row["id_empleado"]: row["id_area"] for row in server.DB.listar_empleados_detallado()
                        }
                        first_area, second_area = (area_by_employee[emp] for emp in ("99001", "99002"))
                        server.DB.guardar_usuario_sistema("otro_supervisor", password, "Otro supervisor", "supervisor", second_area)
                        accounts["otro_supervisor"] = (password, "supervisor")
                        supervisor = login_as("prueba_supervisor")
                        other_supervisor = login_as("otro_supervisor")
                        asignadas = json.loads(authenticated("/api/asignaciones/masivas", {
                            "empleados": ["99001", "99002"], "fechas": ["2026-12-06"], "es_descanso": True,
                        }))
                        self.assertEqual(asignadas["asignadas"], 2)
                        accounts["99001"] = ("8137", "empleado")
                        employee = login_as("99001")
                        solicitud = json.loads(employee("/api/empleado/solicitud", {
                            "fecha_inicio": str(DAY), "motivo": "Solicitud ficticia",
                        }))["id"]
                        with self.assertRaises(HTTPError) as premature:
                            hr("/api/solicitudes/responder", {"id": solicitud, "estado": "APROBADA"})
                        self.assertEqual(premature.exception.code, 409)
                        supervisor("/api/solicitudes/responder", {"id": solicitud, "estado": "AVALADO_SUPERVISOR"})
                        hr("/api/solicitudes/responder", {"id": solicitud, "estado": "APROBADA"})

                        corte_datos = {"mes": "2026-12", "inicio": "2026-11-23", "fin": "2026-12-05"}
                        corte = json.loads(hr("/api/cortes", corte_datos))["id"]
                        with self.assertRaises(HTTPError) as overlap:
                            hr("/api/cortes", corte_datos)
                        self.assertEqual(overlap.exception.code, 409)
                        def accion(cliente, nombre, **datos):
                            return cliente("/api/cortes/accion", {"id": corte, "revision": 1, "accion": nombre, **datos})

                        with self.assertRaises(HTTPError) as pending:
                            accion(authenticated, "cerrar")
                        self.assertEqual(pending.exception.code, 409)
                        accion(supervisor, "enviar")
                        accion(hr, "devolver", area=first_area, motivo="Revisar asistencia")
                        accion(supervisor, "enviar")
                        accion(other_supervisor, "enviar")
                        accion(hr, "validar", area=first_area)
                        accion(hr, "validar", area=second_area)
                        accion(authenticated, "cerrar")
                        accion(auditor, "observar", motivo="Revisión ficticia")
                        with self.assertRaises(HTTPError) as forbidden:
                            auditor("/api/procesar-huellero", {})
                        self.assertEqual(forbidden.exception.code, 403)
                        payload = {
                            "fecha_inicio": "2026-11-22", "fecha_fin": str(DAY),
                            "archivos": [{"filename": "huellero.xlsx", "content_base64": excel_payload()}],
                        }
                        with self.assertRaises(HTTPError) as locked:
                            authenticated("/api/procesar-huellero", payload)
                        self.assertEqual(locked.exception.code, 409)
                        archivo = f"/api/cortes/exportar?id={corte}&revision=1"
                        def descargar_filas():
                            with closing(load_workbook(io.BytesIO(auditor(archivo)), read_only=True)) as libro:
                                return list(libro["Detalle"].values)

                        cerrado = descargar_filas()
                        self.assertEqual(len(cerrado), 3)
                        accion(authenticated, "reabrir", motivo="Corrección ficticia")
                        authenticated("/api/procesar-huellero", payload)
                        self.assertEqual(descargar_filas(), cerrado)
                        self.assertEqual(json.loads(hr("/api/cortes"))["cortes"][0]["revision"], 2)

                        turno_noche = json.loads(authenticated("/api/turnos", {
                            "nombre": "Cruce nocturno", "hora_entrada": "22:00", "hora_salida": "06:00",
                            "id_area": first_area,
                        }))["id"]
                        authenticated("/api/asignaciones/masivas", {
                            "empleados": ["99001"], "fechas": ["2026-12-07"], "id_turno": turno_noche,
                        })
                        huellero = Workbook()
                        huellero.active.append(["ID_Empleado", "Fecha", "Hora"])
                        huellero.active.append(["99001", "07/12/2026", "22:00"])
                        huellero.active.append(["99001", "08/12/2026", "06:00"])
                        with io.BytesIO() as stream:
                            huellero.save(stream)
                            contenido = base64.b64encode(stream.getvalue()).decode("ascii")
                        resultado_noche = json.loads(authenticated("/api/procesar-huellero", {
                            "fecha_inicio": "2026-12-07", "fecha_fin": "2026-12-07",
                            "incluir_marcaciones_app": False,
                            "archivos": [{"filename": "turno_nocturno.xlsx", "content_base64": contenido}],
                        }))
                        self.assertEqual(resultado_noche["filas_generadas"], 1)
                        self.assertEqual(resultado_noche["estadisticas"]["en_periodo"], 1)
                        noche = next(f for f in server.DB.listar_historico_metricas() if f["fecha"] == "2026-12-07")
                        self.assertEqual(noche["horas_trabajadas"], 8)
                        stale = {"Cookie": f"{session_cookie.name}={session_cookie.value}"}
                        authenticated("/api/logout", {})
                        for path in ("/api/sesion", report["url"]):
                            with self.assertRaises(HTTPError) as revoked:
                                request(base_url, path, headers=stale)
                            self.assertEqual(revoked.exception.code, 401)
                        self.assertEqual(list(cookies), [])

                        authenticated("/api/login", {"identificador": "prueba_superadmin", "clave": password})
                        with patch.object(server, "monotonic", return_value=server.monotonic() + server.SESSION_SECONDS):
                            with self.assertRaises(HTTPError) as expired:
                                authenticated("/api/sesion")
                            self.assertEqual(expired.exception.code, 401)
                    finally:
                        http.shutdown()
                        worker.join(timeout=5)

            with patch.dict(os.environ, entorno):
                subprocess.run(
                    [sys.executable, "-B", "-c",
                     "import server; "
                     "assert server.DB.connection.execute('SELECT count(*) FROM marcaciones_moviles').fetchone()[0] == 3; "
                     "assert server.DB.connection.execute('SELECT count(*) FROM cortes_cierres').fetchone()[0] == 1; "
                     "assert any(server.REPORTS_DIR.glob('Comparativo_*.xlsx')); "
                     "server.DB.close()"],
                    cwd=sandbox, check=True,
                )


if __name__ == "__main__":
    unittest.main()

import argparse
import json
import sqlite3
from contextlib import closing
from pathlib import Path

from db import Database


TABLAS_PC = {
    "empleados": ("id_empleado", "nombre"),
    "turnos": ("id", "nombre", "hora_entrada", "hora_salida", "tolerancia_min",
               "descanso_min", "cruza_medianoche", "recargo_nocturno_pct", "activo"),
    "dias_festivos": ("fecha", "descripcion"),
    "asignaciones": ("id", "id_empleado", "fecha", "id_turno", "es_descanso", "observaciones"),
}


def abrir_lectura(ruta):
    return sqlite3.connect(ruta.resolve().as_uri() + "?mode=ro", uri=True)


def comprobar_integridad(db):
    if db.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
        raise ValueError("La base no superó la comprobación de integridad.")


def copiar_sqlite(origen, destino):
    destino.parent.mkdir(parents=True, exist_ok=True)
    destino.touch(exist_ok=False)
    try:
        with closing(abrir_lectura(origen)) as fuente, closing(sqlite3.connect(destino)) as copia:
            comprobar_integridad(fuente)
            fuente.backup(copia)
            comprobar_integridad(copia)
    except Exception:
        destino.unlink(missing_ok=True)
        raise


def importar(origen, destino, mapa, aplicar):
    if origen.resolve() == destino.resolve():
        raise ValueError("Seleccione archivos distintos para origen y destino.")
    with closing(abrir_lectura(origen)) as fuente, closing(sqlite3.connect(destino.resolve().as_uri() + "?mode=rw", uri=True)) as web:
        comprobar_integridad(fuente)
        web.execute("PRAGMA foreign_keys=ON")
        web.execute("BEGIN IMMEDIATE")
        areas = dict(web.execute("SELECT nombre,id FROM areas"))
        informe = {}
        conflictos = []
        for tabla, columnas_pc in TABLAS_PC.items():
            columnas = list(columnas_pc)
            maestro = tabla in ("empleados", "turnos")
            seleccion = ",".join(columnas)
            filas = fuente.execute(f"SELECT {seleccion} FROM {tabla}").fetchall()
            if maestro:
                columnas.append("id_area")
            informe[tabla] = {"origen": len(filas), "nuevos": 0, "coinciden": 0}
            for fila in filas:
                clave = fila[0]
                if maestro:
                    nombre_area = mapa.get(tabla, {}).get(str(clave), mapa.get("area_predeterminada"))
                    if nombre_area not in areas:
                        conflictos.append(f"{tabla}/{clave}: falta un área válida.")
                        continue
                    fila = (*fila, areas[nombre_area])
                if tabla == "asignaciones" and not web.execute(
                    "SELECT 1 FROM empleados WHERE id_empleado=?", (fila[1],)
                ).fetchone():
                    conflictos.append(f"{tabla}/{clave}: empleado sin importar.")
                    continue
                existentes = web.execute(
                    f"SELECT {','.join(columnas)} FROM {tabla} WHERE {columnas[0]}=?" +
                    (" OR (id_empleado=? AND fecha=?)" if tabla == "asignaciones" else ""),
                    fila[:3] if tabla == "asignaciones" else (clave,),
                ).fetchall()
                if existentes == [fila]:
                    informe[tabla]["coinciden"] += 1
                elif existentes:
                    conflictos.append(f"{tabla}/{clave}: difiere de la base web.")
                else:
                    try:
                        web.execute(
                            f"INSERT INTO {tabla} ({','.join(columnas)}) VALUES ({','.join('?' for _ in fila)})",
                            fila,
                        )
                        informe[tabla]["nuevos"] += 1
                    except sqlite3.IntegrityError:
                        conflictos.append(f"{tabla}/{clave}: referencia o restricción inválida.")
        if aplicar and not conflictos:
            web.commit()
        else:
            web.rollback()
        return {"tablas": informe, "conflictos": conflictos, "aplicado": aplicar and not conflictos}


def main():
    parser = argparse.ArgumentParser(description="Operaciones locales para el piloto de asistencia.")
    comandos = parser.add_subparsers(dest="comando", required=True)
    inicializar = comandos.add_parser("inicializar")
    inicializar.add_argument("destino", type=Path)
    copia = comandos.add_parser("copiar")
    carga = comandos.add_parser("importar")
    for comando in (copia, carga):
        comando.add_argument("origen", type=Path)
        comando.add_argument("destino", type=Path)
    carga.add_argument("--mapa", type=Path, required=True)
    carga.add_argument("--aplicar", action="store_true")
    args = parser.parse_args()
    if args.comando == "inicializar":
        args.destino.parent.mkdir(parents=True, exist_ok=True)
        args.destino.touch(exist_ok=False)
        with closing(Database(args.destino)) as db:
            db.initialize()
    elif args.comando == "copiar":
        copiar_sqlite(args.origen, args.destino)
    else:
        mapa = json.loads(args.mapa.read_text(encoding="utf-8-sig"))
        informe = importar(args.origen, args.destino, mapa, args.aplicar)
        print(json.dumps(informe, ensure_ascii=False, indent=2))
        return int(bool(informe["conflictos"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

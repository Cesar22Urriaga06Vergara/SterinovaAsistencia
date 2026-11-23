from __future__ import annotations

from pathlib import Path
from typing import Iterable

import pandas as pd

from core.normalizador import normalizar_huellero


EXTENSIONES_EXCEL = {".xlsx", ".xls"}
TODOS_LOS_TURNOS = "Todos los turnos"


def archivos_excel_en_carpeta(carpeta: str | Path) -> list[str]:
    """Lista archivos Excel del nivel superior; excluye temporales de Excel."""
    ruta = Path(carpeta)
    if not ruta.is_dir():
        raise ValueError(f"La carpeta seleccionada no existe: {ruta}")
    return sorted(
        (
            str(archivo)
            for archivo in ruta.iterdir()
            if archivo.is_file()
            and archivo.suffix.lower() in EXTENSIONES_EXCEL
            and not archivo.name.startswith("~$")
        ),
        key=lambda valor: valor.casefold(),
    )


def normalizar_lote(
    rutas: Iterable[str | Path],
    columna_id: str = "ID_Empleado",
    columna_fecha: str = "Fecha",
    columna_hora: str = "Hora",
    fecha_inicio=None,
    fecha_fin=None,
    ids_locales: set[str] | None = None,
) -> tuple[pd.DataFrame, dict[str, int | list[str]]]:
    """Normaliza libros uno a uno y conserva solo dos marcas por persona/día.

    Se valida el lote completo antes de devolverlo para que un libro dañado
    detenga la generación de reportes sin dejar resultados parciales.
    """
    archivos = [Path(ruta) for ruta in rutas]
    if not archivos:
        raise ValueError("Seleccione uno o más archivos Excel del huellero.")

    ids_validos = {str(valor).strip() for valor in ids_locales} if ids_locales is not None else None
    compactos: list[pd.DataFrame] = []
    cantidad_total = cantidad_local = cantidad_periodo = 0

    for archivo in archivos:
        try:
            frame = normalizar_huellero(
                str(archivo), columna_id, columna_fecha, columna_hora
            )
        except Exception as error:
            raise ValueError(f"Error en '{archivo.name}': {error}") from error
        if frame.empty:
            raise ValueError(
                f"El archivo '{archivo.name}' no contiene marcaciones válidas "
                "en ninguna hoja reconocible. No se generó ningún reporte."
            )

        cantidad_total += len(frame)
        filtrado = frame.copy()
        filtrado["id_empleado"] = filtrado["id_empleado"].astype(str).str.strip()
        if ids_validos is not None:
            filtrado = filtrado.loc[filtrado["id_empleado"].isin(ids_validos)].copy()
        cantidad_local += len(filtrado)
        fechas = pd.to_datetime(filtrado["fecha"], errors="coerce").dt.normalize()
        if fecha_inicio is not None:
            filtrado = filtrado.loc[fechas >= pd.Timestamp(fecha_inicio)].copy()
        if fecha_fin is not None:
            fechas = pd.to_datetime(filtrado["fecha"], errors="coerce").dt.normalize()
            filtrado = filtrado.loc[fechas <= pd.Timestamp(fecha_fin)].copy()
        cantidad_periodo += len(filtrado)
        if filtrado.empty:
            continue

        filtrado["fecha"] = pd.to_datetime(filtrado["fecha"], errors="coerce").dt.normalize()
        filtrado["fecha_hora"] = pd.to_datetime(filtrado["fecha_hora"], errors="coerce")
        agrupado = (
            filtrado.dropna(subset=["fecha_hora"])
            .groupby(["id_empleado", "fecha"], as_index=False, sort=False)
            .agg(
                nombre=("nombre", "first"),
                primera=("fecha_hora", "min"),
                ultima=("fecha_hora", "max"),
            )
        )
        for columna in ("primera", "ultima"):
            compacto = agrupado[["id_empleado", "nombre", "fecha", columna]].rename(
                columns={columna: "fecha_hora"}
            )
            compacto["hora"] = pd.to_datetime(compacto["fecha_hora"]).dt.time
            compactos.append(compacto)

    if compactos:
        resultado = pd.concat(compactos, ignore_index=True)
        resultado = resultado.sort_values(
            ["id_empleado", "fecha_hora"], kind="stable"
        ).reset_index(drop=True)
        # La misma marca puede aparecer en varios relojes; deduplicarla reduce
        # memoria sin cambiar el mínimo ni el máximo del día.
        resultado = resultado.drop_duplicates(
            subset=["id_empleado", "fecha", "fecha_hora"]
        ).reset_index(drop=True)
    else:
        resultado = pd.DataFrame(
            columns=["id_empleado", "nombre", "fecha", "hora", "fecha_hora"]
        )
    resultado.attrs["archivos_origen"] = [str(archivo) for archivo in archivos]
    return resultado, {
        "total_archivo": cantidad_total,
        "locales": cantidad_local,
        "en_periodo": cantidad_periodo,
        "ignoradas": cantidad_total - cantidad_local,
        "fuera_periodo": cantidad_local - cantidad_periodo,
        "archivos": [archivo.name for archivo in archivos],
    }

from __future__ import annotations

from datetime import date, datetime

import pandas as pd


ESTADOS_AUSENCIA = {"AUSENCIA", "AUSENCIA FESTIVO"}
TOLERANCIA_SALIDA_MINUTOS = 10

HOJAS_NOVEDADES = (
    "Llegadas Tempranas",
    "Llegadas Tardes",
    "Salidas Anticipadas",
    "Salidas a Tiempo",
    "Salidas con Hora Extra",
    "Ausencias",
)


def alerta_programacion_requerida(
    ultima_fecha_asignada: date | None,
    hoy: date | None = None,
) -> bool:
    """Alerta si faltan menos de cinco días, no hay turnos o la fecha venció."""
    if ultima_fecha_asignada is None:
        return True
    hoy = hoy or date.today()
    return (ultima_fecha_asignada - hoy).days < 5


def filtrar_detalle(
    detalle: pd.DataFrame,
    fecha_inicio: date | None = None,
    fecha_fin: date | None = None,
    id_empleado: str | None = None,
    turno: str | list[str] | None = None,
) -> pd.DataFrame:
    """Aplica filtros al detalle persistido sin volver a calcular marcaciones."""
    if detalle is None or detalle.empty:
        return pd.DataFrame(columns=list(detalle.columns) if detalle is not None else None)
    if fecha_inicio is not None and fecha_fin is not None and fecha_inicio > fecha_fin:
        raise ValueError("La fecha inicial no puede ser posterior a la fecha final.")

    fechas = pd.to_datetime(detalle["fecha"], errors="coerce").dt.date
    mascara = fechas.notna()
    if fecha_inicio is not None:
        mascara &= fechas >= fecha_inicio
    if fecha_fin is not None:
        mascara &= fechas <= fecha_fin
    if id_empleado is not None:
        mascara &= detalle["id_empleado"].astype(str).str.strip().eq(str(id_empleado).strip())
    if turno is not None:
        mascara &= detalle["turno"].astype(str).isin([turno] if isinstance(turno, str) else turno)
    return detalle.loc[mascara].copy()


def _numeros(detalle: pd.DataFrame, columna: str) -> pd.Series:
    if columna not in detalle:
        return pd.Series(0.0, index=detalle.index, dtype="float64")
    return pd.to_numeric(detalle[columna], errors="coerce").fillna(0.0)


def _mascara_llegada_temprana(detalle: pd.DataFrame) -> pd.Series:
    if not {"hora_entrada_real", "hora_entrada_teorica"}.issubset(detalle.columns):
        return pd.Series(False, index=detalle.index)
    real = pd.to_datetime(detalle["hora_entrada_real"], errors="coerce")
    teorica = pd.to_datetime(detalle["hora_entrada_teorica"], errors="coerce")
    return real.notna() & teorica.notna() & (real < teorica)


def calcular_metricas(detalle: pd.DataFrame) -> dict[str, int | float]:
    """Calcula los cuatro KPI del dashboard para el conjunto filtrado."""
    if detalle is None or detalle.empty:
        return {"horas_extra": 0.0, "minutos_tardanza": 0, "ausencias": 0, "llegadas_tempranas": 0}
    estado = detalle.get("estado", pd.Series("", index=detalle.index)).astype(str)
    return {
        "horas_extra": float(_numeros(detalle, "horas_extra").sum()),
        "minutos_tardanza": int(_numeros(detalle, "minutos_tardanza").sum()),
        "ausencias": int(estado.isin(ESTADOS_AUSENCIA).sum()),
        "llegadas_tempranas": int(_mascara_llegada_temprana(detalle).sum()),
    }


def filtrar_por_kpi(detalle: pd.DataFrame, clave: str | None) -> pd.DataFrame:
    """Devuelve filas de una novedad al activar una tarjeta KPI."""
    if detalle is None or detalle.empty or clave is None:
        return detalle.copy() if detalle is not None else pd.DataFrame()
    if clave == "horas_extra":
        mascara = _numeros(detalle, "horas_extra") > 0
    elif clave == "minutos_tardanza":
        mascara = _numeros(detalle, "minutos_tardanza") > 0
    elif clave == "ausencias":
        mascara = detalle.get("estado", pd.Series("", index=detalle.index)).isin(ESTADOS_AUSENCIA)
    elif clave == "llegadas_tempranas":
        mascara = _mascara_llegada_temprana(detalle)
    else:
        raise ValueError(f"Filtro KPI desconocido: {clave}")
    return detalle.loc[mascara].copy()


def construir_reporte_novedades(detalle: pd.DataFrame) -> dict[str, pd.DataFrame]:
    """Clasifica el detalle en las seis hojas del reporte de novedades."""
    datos = detalle.copy() if detalle is not None else pd.DataFrame()
    for columna in (
        "fecha", "id_empleado", "nombre_empleado", "turno",
        "hora_entrada_teorica", "hora_entrada_real", "hora_salida_teorica",
        "hora_salida_real", "minutos_tardanza", "minutos_salida_anticipada",
        "horas_extra", "ED", "EN", "EF", "END", "RN", "RND", "RF",
        "estado", "observaciones",
    ):
        if columna not in datos:
            datos[columna] = pd.NA

    entrada_real = pd.to_datetime(datos["hora_entrada_real"], errors="coerce")
    entrada_teorica = pd.to_datetime(datos["hora_entrada_teorica"], errors="coerce")
    salida_real = pd.to_datetime(datos["hora_salida_real"], errors="coerce")
    salida_teorica = pd.to_datetime(datos["hora_salida_teorica"], errors="coerce")
    datos["minutos_anticipacion"] = (
        (entrada_teorica - entrada_real).dt.total_seconds().floordiv(60).where(
            entrada_real.notna() & entrada_teorica.notna() & (entrada_real < entrada_teorica)
        )
    )
    datos["minutos_despues_turno"] = (
        (salida_real - salida_teorica).dt.total_seconds().floordiv(60).where(
            salida_real.notna() & salida_teorica.notna() & (salida_real > salida_teorica)
        )
    )
    extras = _numeros(datos, "horas_extra")
    tardanza = _numeros(datos, "minutos_tardanza")
    salida_anticipada = _numeros(datos, "minutos_salida_anticipada")
    estados = datos["estado"].astype(str)

    entrada_temprana = entrada_real.notna() & entrada_teorica.notna() & (entrada_real < entrada_teorica)
    tardanzas = tardanza > 0
    salidas_anticipadas = salida_anticipada > 0
    salidas_a_tiempo = (
        salida_real.notna()
        & salida_teorica.notna()
        & (salida_real > salida_teorica)
        & (
            salida_real
            <= salida_teorica + pd.to_timedelta(TOLERANCIA_SALIDA_MINUTOS, unit="min")
        )
        & extras.le(0)
    )
    ausencias = estados.isin(ESTADOS_AUSENCIA)

    columnas = {
        "Llegadas Tempranas": (
            "fecha", "id_empleado", "nombre_empleado", "turno",
            "hora_entrada_teorica", "hora_entrada_real", "minutos_anticipacion", "estado",
        ),
        "Llegadas Tardes": (
            "fecha", "id_empleado", "nombre_empleado", "turno",
            "hora_entrada_teorica", "hora_entrada_real", "minutos_tardanza", "estado",
        ),
        "Salidas Anticipadas": (
            "fecha", "id_empleado", "nombre_empleado", "turno",
            "hora_salida_teorica", "hora_salida_real", "minutos_salida_anticipada", "estado",
        ),
        "Salidas a Tiempo": (
            "fecha", "id_empleado", "nombre_empleado", "turno",
            "hora_salida_teorica", "hora_salida_real", "minutos_despues_turno", "estado",
        ),
        "Salidas con Hora Extra": (
            "fecha", "id_empleado", "nombre_empleado", "turno",
            "hora_salida_teorica", "hora_salida_real", "horas_extra",
            "ED", "EN", "EF", "END", "RN", "RND", "RF", "estado", "observaciones",
        ),
        "Ausencias": (
            "fecha", "id_empleado", "nombre_empleado", "turno", "estado", "observaciones",
        ),
    }
    mascaras = {
        "Llegadas Tempranas": entrada_temprana,
        "Llegadas Tardes": tardanzas,
        "Salidas Anticipadas": salidas_anticipadas,
        "Salidas a Tiempo": salidas_a_tiempo,
        "Salidas con Hora Extra": extras > 0,
        "Ausencias": ausencias,
    }
    return {
        nombre: datos.loc[mascaras[nombre], list(columnas[nombre])].copy().reset_index(drop=True)
        for nombre in HOJAS_NOVEDADES
    }

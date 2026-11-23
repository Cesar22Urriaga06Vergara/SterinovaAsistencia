from __future__ import annotations

from datetime import date, datetime, timedelta
import math
from typing import Iterable


TOLERANCIA_SALIDA_MINUTOS = 10
HORA_INICIO_NOCTURNA = 19
HORA_FIN_NOCTURNA = 6


def _hora(dt: datetime) -> float:
    return dt.hour + dt.minute / 60 + dt.second / 3600


def _dia_es_nocturno(dt: datetime) -> bool:
    hora = _hora(dt)
    return hora >= HORA_INICIO_NOCTURNA or hora < HORA_FIN_NOCTURNA


def _es_festivo(
    dt: datetime,
    es_domingo_festivo: bool,
    fechas_festivas: Iterable[date] | None,
) -> bool:
    fechas = set(fechas_festivas or [])
    if dt.date() in fechas:
        return True
    if es_domingo_festivo and dt.weekday() == 6:
        return True
    if es_domingo_festivo and dt.hour < 6:
        return (dt.date() - timedelta(days=1)).weekday() == 6
    return False


def _intervalos_horario(inicio: datetime, fin: datetime):
    cursor = inicio
    while cursor < fin:
        dia = cursor.date()
        limites = [
            datetime.combine(dia, datetime.min.time()),
            datetime.combine(dia, datetime.strptime(f"{HORA_FIN_NOCTURNA:02d}:00", "%H:%M").time()),
            datetime.combine(dia, datetime.strptime(f"{HORA_INICIO_NOCTURNA:02d}:00", "%H:%M").time()),
            datetime.combine(dia + timedelta(days=1), datetime.min.time()),
        ]
        siguiente = min(
            (limite for limite in limites if limite > cursor),
            key=lambda limite: limite,
            default=fin,
        )
        siguiente = min(fin, siguiente)
        if siguiente > cursor:
            yield cursor, siguiente
        cursor = siguiente


def _diferencia_intervalos(
    inicio: datetime,
    fin: datetime,
    inicio_teorico: datetime,
    fin_teorico: datetime,
) -> list[tuple[datetime, datetime]]:
    piezas = [(inicio, fin)]
    if fin_teorico <= inicio_teorico:
        return piezas

    resultado = []
    for pieza_inicio, pieza_fin in piezas:
        if pieza_fin <= inicio_teorico or pieza_inicio >= fin_teorico:
            resultado.append((pieza_inicio, pieza_fin))
            continue
        if pieza_inicio < inicio_teorico:
            resultado.append((pieza_inicio, inicio_teorico))
        if pieza_fin > fin_teorico:
            resultado.append((fin_teorico, pieza_fin))
    return resultado


def _horas(piezas: Iterable[tuple[datetime, datetime]]) -> float:
    segundos = sum(
        max(0, (fin - inicio).total_seconds())
        for inicio, fin in piezas
    )
    # Nómina presenta las horas en centésimas truncadas (70 min -> 1.16).
    return math.floor(segundos / 36) / 100


def _restar_intervalo(
    piezas: list[tuple[datetime, datetime]],
    descanso_inicio: datetime,
    descanso_fin: datetime,
) -> list[tuple[datetime, datetime]]:
    """Resta de los intervalos la porción que se solapa con el descanso."""
    resultado = []
    for inicio, fin in piezas:
        if fin <= descanso_inicio or inicio >= descanso_fin:
            resultado.append((inicio, fin))
            continue
        if inicio < descanso_inicio:
            resultado.append((inicio, descanso_inicio))
        if fin > descanso_fin:
            resultado.append((descanso_fin, fin))
    return resultado


def descomponer_recargos(
    entrada_real: datetime,
    salida_real: datetime,
    turno,
    es_domingo_festivo: bool = False,
    fechas_festivas: Iterable[date] | None = None,
    descanso_min: float = 0,
) -> dict[str, float]:
    resultado = {
        "ED": 0.0,
        "EN": 0.0,
        "EF": 0.0,
        "END": 0.0,
        "RN": 0.0,
        "RND": 0.0,
        "RF": 0.0,
    }
    if not entrada_real or not salida_real or salida_real <= entrada_real:
        return resultado

    entrada_hora = datetime.strptime(turno.hora_entrada, "%H:%M").time()
    salida_hora = datetime.strptime(turno.hora_salida, "%H:%M").time()
    entrada_teorica = datetime.combine(entrada_real.date(), entrada_hora)
    if salida_hora < entrada_hora:
        salida_teorica = datetime.combine(entrada_real.date() + timedelta(days=1), salida_hora)
    else:
        salida_teorica = datetime.combine(entrada_real.date(), salida_hora)

    tolerancia = timedelta(minutes=TOLERANCIA_SALIDA_MINUTOS)
    # La marcación temprana nunca adelanta el inicio remunerable del turno.
    entrada_efectiva = max(entrada_real, entrada_teorica)
    salida_efectiva = (
        salida_teorica
        if salida_real <= salida_teorica + tolerancia
        else salida_real
    )

    ordinario_inicio = max(entrada_efectiva, entrada_teorica)
    ordinario_fin = min(salida_efectiva, salida_teorica)
    ordinarias = (
        [(ordinario_inicio, ordinario_fin)]
        if ordinario_fin > ordinario_inicio
        else []
    )
    extras = _diferencia_intervalos(
        entrada_efectiva,
        salida_efectiva,
        entrada_teorica,
        salida_teorica,
    )

    # Las marcaciones no deben añadir tiempo por fuera de la jornada programada
    # si ocurrieron antes de la entrada teórica. Ya se recortó ese tramo arriba.
    descanso_segundos = max(0, int(float(descanso_min or 0) * 60))
    if descanso_segundos:
        descanso_inicio = entrada_teorica
        descanso_fin = descanso_inicio + timedelta(seconds=descanso_segundos)
        ordinarias = _restar_intervalo(ordinarias, descanso_inicio, descanso_fin)
        extras = _restar_intervalo(extras, descanso_inicio, descanso_fin)

    acumulados = {clave: [] for clave in resultado}
    # El tipo de categoría depende primero de si el intervalo cae dentro del
    # turno programado (recargo) o fuera de él (hora extra), y luego de la
    # franja diurna/nocturna y de si la fecha es domingo o festivo.
    for inicio, fin in ordinarias:
        for pieza_inicio, pieza_fin in _intervalos_horario(inicio, fin):
            es_df = _es_festivo(
                pieza_inicio,
                es_domingo_festivo,
                fechas_festivas,
            )
            if _dia_es_nocturno(pieza_inicio):
                acumulados["RND" if es_df else "RN"].append((pieza_inicio, pieza_fin))
            elif es_df:
                acumulados["RF"].append((pieza_inicio, pieza_fin))

    for inicio, fin in extras:
        for pieza_inicio, pieza_fin in _intervalos_horario(inicio, fin):
            es_df = _es_festivo(
                pieza_inicio,
                es_domingo_festivo,
                fechas_festivas,
            )
            nocturna = _dia_es_nocturno(pieza_inicio)
            if es_df:
                clave = "END" if nocturna else "EF"
            else:
                clave = "EN" if nocturna else "ED"
            acumulados[clave].append((pieza_inicio, pieza_fin))

    for clave, piezas in acumulados.items():
        resultado[clave] = _horas(piezas)
    return resultado


def descomponer_horas_no_programadas(
    entrada_real: datetime,
    salida_real: datetime,
    fechas_festivas: Iterable[date] | None = None,
) -> dict[str, float]:
    """Clasifica toda la presencia como extra, sin turno base ni tolerancias."""
    resultado = {
        "ED": 0.0,
        "EN": 0.0,
        "EF": 0.0,
        "END": 0.0,
        "RN": 0.0,
        "RND": 0.0,
        "RF": 0.0,
    }
    if entrada_real is None or salida_real is None or salida_real <= entrada_real:
        return resultado

    festivos = set(fechas_festivas or ())
    acumulados = {clave: [] for clave in resultado}
    for inicio, fin in _intervalos_horario(entrada_real, salida_real):
        es_festivo_o_domingo = inicio.date() in festivos or inicio.weekday() == 6
        nocturna = _dia_es_nocturno(inicio)
        if es_festivo_o_domingo:
            clave = "END" if nocturna else "EF"
        else:
            clave = "EN" if nocturna else "ED"
        acumulados[clave].append((inicio, fin))

    for clave, piezas in acumulados.items():
        resultado[clave] = _horas(piezas)
    return resultado

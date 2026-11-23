from __future__ import annotations

from datetime import date, timedelta


def _pascua(anio: int) -> date:
    """Calcula el Domingo de Pascua mediante el algoritmo de Meeus/Jones/Butcher."""
    a = anio % 19
    b = anio // 100
    c = anio % 100
    d = b // 4
    e = b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i = c // 4
    k = c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    mes = (h + l - 7 * m + 114) // 31
    dia = ((h + l - 7 * m + 114) % 31) + 1
    return date(anio, mes, dia)


def _siguiente_lunes(fecha: date) -> date:
    if fecha.weekday() == 0:
        return fecha
    return fecha + timedelta(days=(7 - fecha.weekday()))


def festivos_colombia(anio: int) -> list[tuple[date, str]]:
    """Devuelve las fechas festivas nacionales de Colombia del año indicado (Ley Emiliani)."""
    try:
        import holidays

        co_holidays = holidays.Colombia(years=anio)
        return sorted(
            ((fecha, str(descripcion)) for fecha, descripcion in co_holidays.items()),
            key=lambda elemento: elemento[0],
        )
    except ImportError:
        pascua = _pascua(anio)
        fijos = [
            (date(anio, 1, 1), "Año Nuevo"),
            (date(anio, 5, 1), "Día del Trabajo"),
            (date(anio, 7, 20), "Día de la Independencia"),
            (date(anio, 8, 7), "Batalla de Boyacá"),
            (date(anio, 12, 8), "Inmaculada Concepción"),
            (date(anio, 12, 25), "Navidad"),
        ]
        emiliani = [
            (_siguiente_lunes(date(anio, 1, 6)), "Reyes Magos"),
            (_siguiente_lunes(date(anio, 3, 19)), "Día de San José"),
            (_siguiente_lunes(date(anio, 6, 29)), "San Pedro y San Pablo"),
            (_siguiente_lunes(date(anio, 8, 15)), "La Asunción"),
            (_siguiente_lunes(date(anio, 10, 12)), "Día de la Raza"),
            (_siguiente_lunes(date(anio, 11, 1)), "Todos los Santos"),
            (_siguiente_lunes(date(anio, 11, 11)), "Independencia de Cartagena"),
        ]
        religiosos = [
            (pascua - timedelta(days=3), "Jueves Santo"),
            (pascua - timedelta(days=2), "Viernes Santo"),
            (_siguiente_lunes(pascua + timedelta(days=39)), "Ascensión del Señor"),
            (_siguiente_lunes(pascua + timedelta(days=60)), "Corpus Christi"),
            (_siguiente_lunes(pascua + timedelta(days=68)), "Sagrado Corazón de Jesús"),
        ]
        return sorted(fijos + emiliani + religiosos, key=lambda elemento: elemento[0])


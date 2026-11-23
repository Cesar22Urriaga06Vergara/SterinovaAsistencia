from __future__ import annotations

from datetime import date, timedelta

from models import Asignacion


def fechas_por_patron(
    inicio: date,
    fin: date,
    dias_semana: set[int],
) -> list[date]:
    """Lista fechas inclusivas cuyo weekday está seleccionado (lunes=0)."""
    if fin < inicio:
        raise ValueError("La fecha final debe ser igual o posterior a la inicial.")
    if not dias_semana:
        raise ValueError("Seleccione al menos un día de la semana.")
    if any(dia < 0 or dia > 6 for dia in dias_semana):
        raise ValueError("Los días de semana deben estar entre 0 y 6.")
    resultado = []
    fecha = inicio
    while fecha <= fin:
        if fecha.weekday() in dias_semana:
            resultado.append(fecha)
        fecha += timedelta(days=1)
    return resultado


def resumir_patron(
    empleados: list[str],
    fechas: list[date],
    asignaciones_existentes: list[Asignacion],
) -> dict[str, int]:
    """Resume altas y reemplazos antes de persistir un patrón de turnos."""
    claves_existentes = {
        (str(item.id_empleado).strip(), item.fecha)
        for item in asignaciones_existentes
    }
    claves_solicitadas = {
        (str(id_empleado).strip(), fecha)
        for id_empleado in empleados
        for fecha in fechas
    }
    total = len(claves_solicitadas)
    reemplazos = len(claves_solicitadas & claves_existentes)
    return {
        "empleados": len({str(id_empleado).strip() for id_empleado in empleados}),
        "fechas": len(set(fechas)),
        "total": total,
        "nuevas": total - reemplazos,
        "reemplazos": reemplazos,
    }


def resumen_calendario_grupo(
    asignaciones: list[Asignacion],
    id_empleados: set[str],
    turnos_por_id: dict[int, str],
) -> dict[date, str]:
    """Representación breve de asignaciones por día para una selección grupal."""
    total_empleados = len(id_empleados)
    por_fecha: dict[date, list[Asignacion]] = {}
    for asignacion in asignaciones:
        if str(asignacion.id_empleado).strip() in id_empleados:
            por_fecha.setdefault(asignacion.fecha, []).append(asignacion)

    resumen = {}
    for fecha, items in por_fecha.items():
        etiquetas = {
            "DESCANSO" if item.es_descanso else turnos_por_id.get(item.id_turno, "Sin turno")
            for item in items
        }
        etiqueta = next(iter(etiquetas)) if len(etiquetas) == 1 else "Varios turnos"
        empleados_asignados = len({str(item.id_empleado).strip() for item in items})
        resumen[fecha] = f"{etiqueta}\n{empleados_asignados}/{total_empleados}"
    return resumen

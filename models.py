from dataclasses import dataclass
from datetime import date, datetime
from typing import Optional


@dataclass
class Turno:
    id: Optional[int]
    nombre: str
    hora_entrada: str
    hora_salida: str
    tolerancia_min: int = 10
    descanso_min: int = 0
    cruza_medianoche: bool = False
    recargo_nocturno_pct: float = 0.0
    activo: bool = True

    @classmethod
    def from_row(cls, row: dict) -> "Turno":
        return cls(
            id=row["id"],
            nombre=row["nombre"],
            hora_entrada=row["hora_entrada"],
            hora_salida=row["hora_salida"],
            tolerancia_min=row["tolerancia_min"],
            descanso_min=row["descanso_min"],
            cruza_medianoche=bool(row["cruza_medianoche"]),
            recargo_nocturno_pct=row["recargo_nocturno_pct"],
            activo=bool(row["activo"]),
        )


@dataclass
class Asignacion:
    id: Optional[int]
    id_empleado: str
    fecha: date
    id_turno: Optional[int]
    es_descanso: bool = False
    observaciones: str = ""


@dataclass
class Marcacion:
    id_empleado: str
    fecha_hora: datetime
    tipo: Optional[str] = None


@dataclass
class Resultado:
    id_empleado: str
    fecha_turno: datetime
    estado: str

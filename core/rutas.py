from __future__ import annotations

import os
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

PETROLEO = "#005A66"
NARANJA = "#E64A19"
FONDO = "#F4F7F8"
TEXTO = "#18343A"


def directorio_aplicacion() -> Path:
    return Path(__file__).resolve().parent.parent


def directorio_datos() -> Path:
    configurado = os.getenv("ASISTENCIA_DATA_DIR")
    return Path(configurado).expanduser().resolve() if configurado else directorio_aplicacion() / "data"


def recurso_data(nombre: str) -> Path:
    return directorio_aplicacion() / "data" / nombre


ZONA_BOGOTA = ZoneInfo("America/Bogota")


def ahora_bogota() -> datetime:
    return datetime.now(ZONA_BOGOTA)


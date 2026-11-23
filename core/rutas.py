from __future__ import annotations

from pathlib import Path

PETROLEO = "#005A66"
NARANJA = "#E64A19"
FONDO = "#F4F7F8"
TEXTO = "#18343A"


def directorio_aplicacion() -> Path:
    return Path(__file__).resolve().parent.parent


def directorio_datos() -> Path:
    return directorio_aplicacion() / "data"


def recurso_data(nombre: str) -> Path:
    return directorio_datos() / nombre


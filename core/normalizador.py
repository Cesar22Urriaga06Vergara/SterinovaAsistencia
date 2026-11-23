from __future__ import annotations

import re
import unicodedata
from datetime import datetime, time
from pathlib import Path
from typing import Any

import pandas as pd
from dateutil import parser


_COLUMNAS_RESPALDO = {
    "id": 0,
    "nombre": 1,
    "fecha": 2,
    "hora": 3,
}
_ALIAS_COLUMNAS = {
    "id": {"id", "idempleado", "employeeid", "employee"},
    "nombre": {"nombre", "name", "employeename"},
    "fecha": {"fecha", "date", "fechamarcacion", "marcationdate"},
    "hora": {"hora", "time", "horamarcacion", "marcationtime"},
}


def _normalizar_nombre_columna(valor: object) -> str:
    texto = unicodedata.normalize("NFKD", str(valor))
    texto = "".join(caracter for caracter in texto if not unicodedata.combining(caracter))
    return re.sub(r"[^a-z0-9]", "", texto.lower())


def limpiar_id_empleado(valor: object) -> str:
    if pd.isna(valor):
        return ""
    texto = str(valor).strip()
    if texto.startswith("'"):
        texto = texto[1:]
    return texto.strip()


def _parsear_fecha(valor: object) -> datetime:
    if pd.isna(valor):
        raise ValueError("Fecha vacía")
    if isinstance(valor, (datetime, pd.Timestamp)):
        return pd.Timestamp(valor).to_pydatetime()
    if isinstance(valor, str):
        texto = valor.strip().lower()
        # ISO es inequívoco y debe leerse antes de dayfirst=True; dateutil
        # puede interpretar el mes ISO como día cuando ambos son <= 12.
        if re.match(r"^\d{4}-\d{2}-\d{2}(?:[ t].*)?$", texto):
            try:
                return datetime.fromisoformat(texto.replace("z", "+00:00"))
            except ValueError:
                pass
        # dateutil reconoce nombres ingleses; el reloj biométrico exporta
        # abreviaturas españolas con puntos (p. ej. "15-oct.-2026").
        meses = {
            "ene": "jan", "enero": "january", "feb": "feb", "febrero": "february",
            "mar": "mar", "marzo": "march", "abr": "apr", "abril": "april",
            "may": "may", "mayo": "may", "jun": "jun", "junio": "june",
            "jul": "jul", "julio": "july", "ago": "aug", "agosto": "august",
            "sep": "sep", "sept": "sep", "septiembre": "september",
            "oct": "oct", "octubre": "october", "nov": "nov", "noviembre": "november",
            "dic": "dec", "diciembre": "december",
        }
        texto = re.sub(r"(?<=[\w])\.(?=[-\s])", "", texto)
        texto = re.sub(
            r"\b(" + "|".join(sorted(meses, key=len, reverse=True)) + r")\.?\b",
            lambda coincidencia: meses[coincidencia.group(1)],
            texto,
        )
        return parser.parse(texto, dayfirst=True)
    raise ValueError(f"Tipo de fecha no reconocido: {type(valor).__name__}")


def _parsear_hora(valor: object) -> time:
    if pd.isna(valor):
        raise ValueError("Hora vacía")
    if isinstance(valor, time):
        return valor
    if isinstance(valor, (datetime, pd.Timestamp)):
        return valor.time()
    texto = re.sub(r"\s+", "", str(valor).strip())
    texto = re.sub(r"^(\d):", r"0\1:", texto)
    for formato in ("%H:%M:%S", "%H:%M", "%I:%M:%S%p", "%I:%M%p"):
        try:
            return datetime.strptime(texto, formato).time()
        except ValueError:
            continue
    return parser.parse(texto).time()


def _resolver_columnas(
    frame: pd.DataFrame,
    columna_id: str,
    columna_fecha: str,
    columna_hora: str,
) -> tuple[dict[str, int], int]:
    solicitadas = {
        "id": _normalizar_nombre_columna(columna_id) if columna_id.strip() else "",
        "nombre": "",
        "fecha": _normalizar_nombre_columna(columna_fecha) if columna_fecha.strip() else "",
        "hora": _normalizar_nombre_columna(columna_hora) if columna_hora.strip() else "",
    }

    filas_candidatas = []
    for fila in frame.head(20).itertuples(index=True, name=None):
        indice = fila[0]
        nombres = [_normalizar_nombre_columna(valor) for valor in fila[1:]]
        coincidencias: dict[str, int] = {}
        for tipo, aliases in _ALIAS_COLUMNAS.items():
            posibles = aliases | ({solicitadas[tipo]} if solicitadas[tipo] else set())
            for columna_indice, nombre in enumerate(nombres):
                if nombre and nombre in posibles:
                    coincidencias[tipo] = columna_indice
                    break
        if coincidencias:
            filas_candidatas.append((len(coincidencias), int(indice), coincidencias, nombres))

    if filas_candidatas:
        coincidencias, fila_encabezados, columnas, nombres = max(
            filas_candidatas, key=lambda candidato: (candidato[0], -candidato[1])
        )
        encabezado_generico = all(
            not nombre or re.fullmatch(r"column\d+", nombre)
            for nombre in nombres
        )
        if coincidencias >= 2 or (coincidencias == 1 and not encabezado_generico):
            resueltas = dict(_COLUMNAS_RESPALDO)
            resueltas.update(columnas)
            return resueltas, fila_encabezados + 1

    matriz = frame.to_numpy(dtype=object, copy=False)
    for indice, fila in enumerate(matriz):
        if any(not pd.isna(valor) and str(valor).strip() for valor in fila):
            if all(
                not str(valor).strip()
                or re.fullmatch(r"column\d+", _normalizar_nombre_columna(valor))
                for valor in fila
            ):
                return dict(_COLUMNAS_RESPALDO), indice + 1
            break
    return dict(_COLUMNAS_RESPALDO), 0


def _leer_filas(
    frame: pd.DataFrame,
    columna_id: str,
    columna_fecha: str,
    columna_hora: str,
) -> tuple[list[dict[str, Any]], dict[str, int], int]:
    columnas, primera_fila = _resolver_columnas(frame, columna_id, columna_fecha, columna_hora)
    registros = []
    ultimo_id = ""
    ultimo_nombre = ""
    id_pendiente = ""
    nombre_pendiente = ""
    ancho_requerido = max(columnas.values()) + 1
    if frame.shape[1] < ancho_requerido:
        frame = frame.reindex(columns=range(ancho_requerido))
    matriz = frame.iloc[primera_fila:].to_numpy(dtype=object, copy=False)
    for fila in matriz:
        valores = fila
        if max(columnas.values()) >= len(valores):
            continue
        id_empleado = limpiar_id_empleado(valores[columnas["id"]])
        valor_nombre = valores[columnas["nombre"]]
        nombre = "" if pd.isna(valor_nombre) else str(valor_nombre).strip()

        # Algunas exportaciones parten el registro en dos filas: la primera
        # trae ID + nombre parcial; la siguiente desplaza nombre/fecha/hora
        # una columna a la izquierda y deja vacía la columna de hora.
        try:
            fecha_desplazada = _parsear_fecha(valores[columnas["nombre"]])
            hora_desplazada = _parsear_hora(valores[columnas["fecha"]])
            hora_original_vacia = pd.isna(valores[columnas["hora"]]) or not str(
                valores[columnas["hora"]]
            ).strip()
        except (TypeError, ValueError, OverflowError):
            fecha_desplazada = hora_desplazada = None
            hora_original_vacia = False

        if fecha_desplazada is not None and hora_desplazada is not None and hora_original_vacia:
            if id_pendiente:
                nombre_completo = " ".join(
                    parte for parte in (nombre_pendiente, id_empleado) if parte
                )
                registros.append({
                    "id_empleado": id_pendiente,
                    "nombre": nombre_completo,
                    "fecha": datetime.combine(fecha_desplazada.date(), time.min),
                    "hora": hora_desplazada,
                    "fecha_hora": datetime.combine(fecha_desplazada.date(), hora_desplazada),
                })
                ultimo_id, ultimo_nombre = id_pendiente, nombre_completo
                id_pendiente = nombre_pendiente = ""
            elif ultimo_id:
                nombre_completo = " ".join(parte for parte in (ultimo_nombre, id_empleado) if parte)
                registros.append({
                    "id_empleado": ultimo_id,
                    "nombre": nombre_completo,
                    "fecha": datetime.combine(fecha_desplazada.date(), time.min),
                    "hora": hora_desplazada,
                    "fecha_hora": datetime.combine(fecha_desplazada.date(), hora_desplazada),
                })
                ultimo_nombre = nombre_completo
            continue

        if not id_empleado:
            # Filas sin ID se ignoran salvo que sean la continuación desplazada
            # reconocida arriba; no se hace un ffill indiscriminado.
            continue
        try:
            fecha = _parsear_fecha(valores[columnas["fecha"]])
            hora = _parsear_hora(valores[columnas["hora"]])
        except (TypeError, ValueError, OverflowError):
            # Guardar contexto cuando la fila contiene solo la cabecera del
            # empleado; la fila siguiente puede contener la marcación corrida.
            vacios_fecha_hora = all(
                pd.isna(valores[indice]) or not str(valores[indice]).strip()
                for indice in (columnas["fecha"], columnas["hora"])
            )
            if vacios_fecha_hora:
                id_pendiente, nombre_pendiente = id_empleado, nombre
            continue
        registros.append(
            {
                "id_empleado": id_empleado,
                "nombre": nombre,
                "fecha": datetime.combine(fecha.date(), time.min),
                "hora": hora,
                "fecha_hora": datetime.combine(fecha.date(), hora),
            }
        )
        ultimo_id, ultimo_nombre = id_empleado, nombre
        id_pendiente = nombre_pendiente = ""
    return registros, columnas, primera_fila


def normalizar_huellero(
    ruta_excel: str,
    columna_id: str = "ID_Empleado",
    columna_fecha: str = "Fecha",
    columna_hora: str = "Hora",
) -> pd.DataFrame:
    try:
        libro = pd.ExcelFile(ruta_excel)
    except (FileNotFoundError, OSError, ImportError, ValueError) as error:
        raise ValueError(
            f"No se pudo abrir '{Path(ruta_excel).name}': el archivo no existe, está abierto "
            "en otro programa o tiene un formato no válido."
        ) from error
    mejor_hoja = None
    mejores_registros: list[dict[str, Any]] = []
    mejores_columnas = dict(_COLUMNAS_RESPALDO)
    try:
        for nombre_hoja in libro.sheet_names:
            try:
                frame = libro.parse(
                    sheet_name=nombre_hoja,
                    header=None,
                    dtype=object,
                )
            except Exception as error:
                raise ValueError(
                    f"No se pudo leer la hoja '{nombre_hoja}' de '{Path(ruta_excel).name}'."
                ) from error
            if frame.empty:
                continue
            registros, columnas, _ = _leer_filas(
                frame,
                columna_id or "",
                columna_fecha or "",
                columna_hora or "",
            )
            if registros:
                if len(registros) > len(mejores_registros):
                    mejor_hoja = nombre_hoja
                    mejores_registros = registros
                    mejores_columnas = columnas
    finally:
        libro.close()

    nombre_hoja = mejor_hoja
    registros = mejores_registros
    columnas = mejores_columnas

    columnas_salida = ["id_empleado", "nombre", "fecha", "hora", "fecha_hora"]
    normalizado = pd.DataFrame(registros, columns=columnas_salida)
    if not normalizado.empty:
        normalizado["fecha"] = pd.to_datetime(normalizado["fecha"]).dt.normalize()
        normalizado = normalizado.sort_values(["id_empleado", "fecha_hora"]).reset_index(drop=True)
    normalizado.attrs["hoja_origen"] = nombre_hoja
    normalizado.attrs["columnas_origen"] = columnas
    return normalizado

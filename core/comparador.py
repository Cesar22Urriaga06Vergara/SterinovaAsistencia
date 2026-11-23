from __future__ import annotations

from datetime import date, datetime, timedelta

import pandas as pd

from core.calculadora_nomina import descomponer_horas_no_programadas, descomponer_recargos
from db import Database


TOLERANCIA_ENTRADA_MINUTOS = 10


def filtrar_marcaciones_locales(db: Database, marcaciones: pd.DataFrame) -> pd.DataFrame:
    if marcaciones is None or marcaciones.empty:
        return marcaciones

    ids_locales = pd.Index(
        [
            str(id_empleado).strip()
            for id_empleado, _nombre in db.listar_empleados()
            if str(id_empleado).strip()
        ]
    )
    if ids_locales.empty:
        return marcaciones.iloc[0:0].copy()

    ids_marcacion = marcaciones["id_empleado"].astype(str).str.strip()
    filtradas = marcaciones.loc[ids_marcacion.isin(ids_locales)].copy()
    filtradas.attrs.update(marcaciones.attrs)
    filtradas.attrs["ids_locales"] = len(ids_locales)
    filtradas.attrs["marcaciones_ignoradas"] = len(marcaciones) - len(filtradas)
    return filtradas


def minutos_entre(inicio: datetime, fin: datetime) -> float:
    return (fin - inicio).total_seconds() / 60


def _turno_a_datetime(fecha: date, hora: str, dia_siguiente: bool = False) -> datetime:
    hora_obj = datetime.strptime(hora, "%H:%M").time()
    dia = fecha + timedelta(days=1) if dia_siguiente else fecha
    return datetime.combine(dia, hora_obj)


def _fila_no_programado(
    empleado: str,
    fecha_turno: date,
    entrada_real: datetime | None,
    salida_real: datetime | None,
    fechas_festivas: set[date],
) -> dict:
    festivo_o_domingo = fecha_turno in fechas_festivas or fecha_turno.weekday() == 6
    recargos = descomponer_horas_no_programadas(
        entrada_real,
        salida_real,
        fechas_festivas=fechas_festivas,
    )
    extras = sum(recargos[clave] for clave in ("ED", "EN", "EF", "END"))
    completo = (
        entrada_real is not None
        and salida_real is not None
        and salida_real > entrada_real
    )
    return {
        "id_empleado": empleado,
        "fecha": fecha_turno,
        "turno": "NO PROGRAMADO",
        "hora_entrada_teorica": None,
        "hora_salida_teorica": None,
        "hora_entrada_real": entrada_real,
        "hora_salida_real": salida_real,
        "fuente_entrada": "Huellero" if entrada_real is not None else "Sin fuente",
        "fuente_salida": "Huellero" if salida_real is not None else "Sin fuente",
        "minutos_tardanza": 0,
        "minutos_salida_anticipada": 0,
        "horas_trabajadas": round(extras, 2),
        "horas_normales": 0.0,
        "horas_extra": round(extras, 2),
        "horas_nocturnas": round(recargos["EN"] + recargos["END"], 2),
        **recargos,
        "estado": "NO PROGRAMADO" if completo else "SIN MARCACIÓN",
        "observaciones": (
            "FESTIVO NO PROGRAMADO" if festivo_o_domingo else "TRABAJO NO PROGRAMADO"
        ),
    }


def comparar(
    db: Database,
    marcaciones: pd.DataFrame,
    fecha_inicio: date | None = None,
    fecha_fin: date | None = None,
    ids_empleados: set[str] | None = None,
) -> pd.DataFrame:
    if fecha_inicio and fecha_fin and fecha_inicio > fecha_fin:
        raise ValueError("La fecha inicial del período no puede ser posterior a la fecha final.")

    asignaciones = db.listar_asignaciones(
        fecha_inicio=fecha_inicio,
        fecha_fin=fecha_fin,
    )
    turnos = db.listar_turnos(incluir_inactivos=False)
    fechas_festivas = {fecha for fecha, _descripcion in db.listar_dias_festivos()}

    asignacion_df = pd.DataFrame(
        [
            {
                "id_empleado": str(asignacion.id_empleado).strip(),
                "fecha": asignacion.fecha,
                "id_turno": asignacion.id_turno,
                "es_descanso": asignacion.es_descanso,
                "observaciones": asignacion.observaciones or "",
            }
            for asignacion in asignaciones
        ],
        columns=("id_empleado", "fecha", "id_turno", "es_descanso", "observaciones"),
    )

    turno_df = pd.DataFrame(
        [
            {
                "id_turno": turno.id,
                "turno": turno.nombre,
                "hora_entrada": turno.hora_entrada,
                "hora_salida": turno.hora_salida,
                "cruza_medianoche": turno.cruza_medianoche,
                "descanso_min": turno.descanso_min,
            }
            for turno in turnos
        ]
    )
    asignacion_df["fecha"] = pd.to_datetime(asignacion_df["fecha"], errors="coerce").dt.normalize()
    ids_filtrados = (
        {str(valor).strip() for valor in ids_empleados}
        if ids_empleados is not None
        else None
    )
    if ids_filtrados is not None:
        asignacion_df = asignacion_df.loc[
            asignacion_df["id_empleado"].isin(ids_filtrados)
        ].copy()
    if turno_df.empty:
        for columna in ("turno", "hora_entrada", "hora_salida", "cruza_medianoche", "descanso_min"):
            asignacion_df[columna] = pd.Series(index=asignacion_df.index, dtype="object")
    else:
        asignacion_df = asignacion_df.merge(
            turno_df,
            left_on="id_turno",
            right_on="id_turno",
            how="left",
        )

    if marcaciones is not None and not marcaciones.empty:
        marcas = marcaciones[["id_empleado", "fecha", "fecha_hora"]].copy()
        marcas["id_empleado"] = marcas["id_empleado"].astype(str).str.strip()
        marcas["fecha"] = pd.to_datetime(marcas["fecha"], errors="coerce").dt.normalize()
        marcas["fecha_hora"] = pd.to_datetime(marcas["fecha_hora"], errors="coerce")
        marcas = marcas.dropna(subset=["fecha_hora"])
        if ids_filtrados is not None:
            marcas = marcas.loc[marcas["id_empleado"].isin(ids_filtrados)].copy()
        if fecha_inicio is not None:
            marcas = marcas.loc[marcas["fecha"] >= pd.Timestamp(fecha_inicio)]
        if fecha_fin is not None:
            marcas = marcas.loc[marcas["fecha"] <= pd.Timestamp(fecha_fin)]
    else:
        marcas = pd.DataFrame(
            {
                "id_empleado": pd.Series(dtype="string"),
                "fecha": pd.Series(dtype="datetime64[ns]"),
                "fecha_hora": pd.Series(dtype="datetime64[ns]"),
            }
        )

    primera = (
        marcas.sort_values("fecha_hora")
        .groupby(["id_empleado", "fecha"], sort=False)["fecha_hora"]
        .first()
        .rename("entrada_real")
        .reset_index()
    )
    asignacion_df = asignacion_df.merge(
        primera,
        on=["id_empleado", "fecha"],
        how="left",
    )

    salida_df = marcas.copy()
    salida_df["fecha_salida"] = salida_df["fecha"]
    salida_df["id_empleado_salida"] = salida_df["id_empleado"]

    normal = salida_df.sort_values("fecha_hora").groupby(
        ["id_empleado", "fecha"],
        sort=False,
    )["fecha_hora"].last().rename("salida_real").reset_index()
    asignacion_df = asignacion_df.merge(
        normal,
        on=["id_empleado", "fecha"],
        how="left",
    )

    claves_asignadas = {
        (str(fila.id_empleado).strip(), pd.Timestamp(fila.fecha).date())
        for fila in asignacion_df[["id_empleado", "fecha"]].itertuples(index=False)
        if pd.notna(fila.fecha)
    }
    claves_salida_turno_nocturno = {
        (
            str(fila.id_empleado).strip(),
            pd.Timestamp(fila.fecha).date() + timedelta(days=1),
        )
        for fila in asignacion_df.loc[
            asignacion_df["cruza_medianoche"].fillna(False).eq(True),
            ["id_empleado", "fecha"],
        ].itertuples(index=False)
    }

    overnight = asignacion_df.loc[
        asignacion_df["cruza_medianoche"].fillna(False).eq(True),
        ["id_empleado", "fecha"],
    ].copy()
    overnight["id_empleado_salida"] = overnight["id_empleado"]
    overnight["fecha_salida"] = overnight["fecha"].map(
        lambda valor: pd.Timestamp(pd.Timestamp(valor).date() + timedelta(days=1))
    )
    marcas_salida = marcas.rename(
        columns={
            "id_empleado": "id_empleado_salida",
            "fecha": "fecha_salida",
        }
    )
    salida_noche = (
        marcas_salida.sort_values("fecha_hora")
        .groupby(["id_empleado_salida", "fecha_salida"], sort=False)["fecha_hora"]
        .last()
        .rename("salida_real_noche")
        .reset_index()
    )
    overnight = overnight.merge(
        salida_noche,
        on=["id_empleado_salida", "fecha_salida"],
        how="left",
    )
    if not overnight.empty:
        asignacion_df = asignacion_df.merge(
            overnight[
                ["id_empleado", "fecha", "salida_real_noche"]
            ],
            on=["id_empleado", "fecha"],
            how="left",
        )
        asignacion_df["salida_real"] = asignacion_df["salida_real"].where(
            asignacion_df["cruza_medianoche"].fillna(False).eq(False),
            asignacion_df["salida_real_noche"],
        )
        asignacion_df.drop(columns=["salida_real_noche"], inplace=True)

    filas = []
    if not marcas.empty:
        marcas_por_dia = (
            marcas.groupby(["id_empleado", "fecha"], sort=False)["fecha_hora"]
            .agg(entrada_real="min", salida_real="max")
            .reset_index()
        )
        for marca in marcas_por_dia.itertuples(index=False):
            fecha_marca = pd.Timestamp(marca.fecha).date()
            empleado_marca = str(marca.id_empleado).strip()
            if (
                (empleado_marca, fecha_marca) in claves_asignadas
                or (empleado_marca, fecha_marca) in claves_salida_turno_nocturno
            ):
                continue
            entrada = pd.Timestamp(marca.entrada_real).to_pydatetime()
            salida = pd.Timestamp(marca.salida_real).to_pydatetime()
            filas.append(
                _fila_no_programado(
                    empleado_marca,
                    fecha_marca,
                    entrada,
                    salida,
                    fechas_festivas,
                )
            )

    for fila in asignacion_df.itertuples(index=False, name=None):
        valores = dict(zip(asignacion_df.columns, fila))
        empleado = valores["id_empleado"]
        fecha_turno = pd.Timestamp(valores["fecha"]).date()
        if valores["es_descanso"]:
            entrada_real = valores.get("entrada_real")
            salida_real = valores.get("salida_real")
            entrada_real = pd.Timestamp(entrada_real).to_pydatetime() if pd.notna(entrada_real) else None
            salida_real = pd.Timestamp(salida_real).to_pydatetime() if pd.notna(salida_real) else None
            if entrada_real is not None or salida_real is not None:
                filas.append(
                    _fila_no_programado(
                        empleado,
                        fecha_turno,
                        entrada_real,
                        salida_real,
                        fechas_festivas,
                    )
                )
                continue
            descanso_festivo = fecha_turno in fechas_festivas
            filas.append(
                {
                    "id_empleado": empleado,
                    "fecha": fecha_turno,
                    "turno": "DESCANSO",
                    "hora_entrada_teorica": None,
                    "hora_salida_teorica": None,
                    "hora_entrada_real": None,
                    "hora_salida_real": None,
                    "fuente_entrada": "Huellero",
                    "fuente_salida": "Huellero",
                    "minutos_tardanza": 0,
                    "minutos_salida_anticipada": 0,
                    "horas_trabajadas": 0.0,
                    "horas_normales": 0.0,
                    "horas_extra": 0.0,
                    "horas_nocturnas": 0.0,
                    "ED": 0.0,
                    "EN": 0.0,
                    "EF": 0.0,
                    "END": 0.0,
                    "RN": 0.0,
                    "RND": 0.0,
                    "RF": 0.0,
                    "estado": "DESCANSO FESTIVO" if descanso_festivo else "OK",
                    "observaciones": (
                        "DESCANSO FESTIVO" if descanso_festivo else "Descanso asignado"
                    ),
                }
            )
            continue

        if pd.isna(valores.get("turno")):
            continue

        cruce = bool(valores["cruza_medianoche"])
        entrada_teorica = _turno_a_datetime(fecha_turno, valores["hora_entrada"])
        salida_teorica = _turno_a_datetime(
            fecha_turno,
            valores["hora_salida"],
            dia_siguiente=cruce,
        )

        entrada_real = valores.get("entrada_real")
        salida_real = valores.get("salida_real")
        entrada_real = pd.Timestamp(entrada_real).to_pydatetime() if pd.notna(entrada_real) else None
        salida_real = pd.Timestamp(salida_real).to_pydatetime() if pd.notna(salida_real) else None

        if entrada_real is None and salida_real is None:
            estado = "AUSENCIA"
        elif entrada_real is None or salida_real is None:
            estado = "SIN MARCACIÓN"
        else:
            estado = "OK"

        festivo_asignado_sin_marca = (
            fecha_turno in fechas_festivas
            and entrada_real is None
            and salida_real is None
        )
        if festivo_asignado_sin_marca:
            estado = "AUSENCIA FESTIVO"

        if entrada_real is not None and salida_real is not None:
            tardanza_bruta = max(0, int(minutos_entre(entrada_teorica, entrada_real)))
            # La tolerancia es de gracia: dentro de ella no se registra tardanza.
            tardanza = (
                tardanza_bruta
                if tardanza_bruta > TOLERANCIA_ENTRADA_MINUTOS
                else 0
            )
            salida_anticipada = max(
                0,
                int(round(minutos_entre(salida_real, salida_teorica))),
            )
            if tardanza > 0:
                estado = "TARDANZA"
            if salida_anticipada > 0:
                estado = "SALIDA ANTICIPADA" if estado == "OK" else estado + " / SALIDA ANTICIPADA"

            trabajadas_fisicas = max(
                0.0,
                (minutos_entre(max(entrada_real, entrada_teorica), salida_real)
                 - float(valores["descanso_min"] or 0)) / 60,
            )
            teoricas = max(
                0.0,
                (minutos_entre(entrada_teorica, salida_teorica)
                 - float(valores["descanso_min"] or 0)) / 60,
            )
            normales = min(trabajadas_fisicas, teoricas)
            recargos = descomponer_recargos(
                entrada_real,
                salida_real,
                type(
                    "TurnoComparador",
                    (),
                    {
                        "hora_entrada": valores["hora_entrada"],
                        "hora_salida": valores["hora_salida"],
                    },
                )(),
                es_domingo_festivo=(fecha_turno.weekday() == 6),
                fechas_festivas=fechas_festivas,
                descanso_min=float(valores["descanso_min"] or 0),
            )
            # Los recargos determinan las extras: la tolerancia de salida no
            # paga los minutos de gracia, pero al excederla se cuenta desde el
            # fin oficial del turno. Las categorías se presentan truncadas.
            claves_extra = ("ED", "EN", "EF", "END")
            extra = sum(recargos[clave] for clave in claves_extra)
            trabajadas = normales + extra
            nocturnas = round(recargos["RN"] + recargos["RND"], 2)
            fuente_entrada = "Huellero"
            fuente_salida = "Huellero"
        else:
            tardanza = 0
            salida_anticipada = 0
            trabajadas = normales = extra = nocturnas = 0.0
            recargos = {
                "ED": 0.0,
                "EN": 0.0,
                "EF": 0.0,
                "END": 0.0,
                "RN": 0.0,
                "RND": 0.0,
                "RF": 0.0,
            }
            fuente_entrada = "Huellero" if entrada_real is not None else "Sin fuente"
            fuente_salida = "Huellero" if salida_real is not None else "Sin fuente"

        if festivo_asignado_sin_marca:
            observacion = "AUSENCIA FESTIVO"
        elif estado.startswith("TARDANZA"):
            observacion = f"TARDANZA ({tardanza} min)"
            if "SALIDA ANTICIPADA" in estado:
                observacion += " / SALIDA ANTICIPADA"
        elif estado in ("AUSENCIA", "SIN MARCACIÓN"):
            observacion = estado
        else:
            observacion = valores.get("observaciones", "") or ""
        filas.append(
            {
                "id_empleado": empleado,
                "fecha": fecha_turno,
                "turno": valores["turno"],
                "hora_entrada_teorica": entrada_teorica,
                "hora_salida_teorica": salida_teorica,
                "hora_entrada_real": entrada_real,
                "hora_salida_real": salida_real,
                "fuente_entrada": fuente_entrada,
                "fuente_salida": fuente_salida,
                "minutos_tardanza": tardanza,
                "minutos_salida_anticipada": salida_anticipada,
                "horas_trabajadas": round(trabajadas, 2),
                "horas_normales": round(normales, 2),
                "horas_extra": round(extra, 2),
                "horas_nocturnas": nocturnas,
                "ED": recargos["ED"],
                "EN": recargos["EN"],
                "EF": recargos["EF"],
                "END": recargos["END"],
                "RN": recargos["RN"],
                "RND": recargos["RND"],
                "RF": recargos["RF"],
                "estado": estado,
                "observaciones": observacion,
            }
        )

    resultado = pd.DataFrame(filas)
    if not resultado.empty:
        resultado = resultado.sort_values(
            ["id_empleado", "fecha"], kind="stable"
        ).reset_index(drop=True)
    return resultado

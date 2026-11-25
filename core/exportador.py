from datetime import date, datetime, timedelta
from pathlib import Path
import sys
import os

import pandas as pd
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl import load_workbook
import re
import calendar
from copy import copy
import os
from zipfile import ZIP_DEFLATED, ZipFile
from xml.etree import ElementTree as ET
from core.calculadora_nomina import descomponer_recargos
from core.metricas import HOJAS_NOVEDADES, construir_reporte_novedades
from core.rutas import PETROLEO, recurso_data


def _insertar_logo(hoja) -> None:
    # La imagen se agrega al paquete XLSX después de guardarlo. Así se evita
    # depender de Pillow y se mantiene el fallback si el archivo no existe.
    return


def _incrustar_logo_xlsx(ruta_archivo: Path) -> None:
    """Agrega el PNG a cada hoja mediante OOXML, sin dependencia de Pillow."""
    try:
        ruta_logo = recurso_data("logo.png")
        if not ruta_logo.is_file():
            return

        ns_main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
        ns_rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
        ns_pkg_rel = "http://schemas.openxmlformats.org/package/2006/relationships"
        ns_ct = "http://schemas.openxmlformats.org/package/2006/content-types"
        ns_xdr = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
        ns_a = "http://schemas.openxmlformats.org/drawingml/2006/main"
        ns = {"main": ns_main, "rel": ns_rel, "pkg": ns_pkg_rel, "ct": ns_ct,
              "xdr": ns_xdr, "a": ns_a}
        for prefix, uri in (("r", ns_rel), ("xdr", ns_xdr), ("a", ns_a), ("ct", ns_ct), ("rel", ns_pkg_rel)):
            ET.register_namespace(prefix, uri)

        temporal = ruta_archivo.with_name(ruta_archivo.stem + ".logo.tmp.xlsx")
        with ZipFile(ruta_archivo, "r") as fuente:
            miembros = {info.filename: fuente.read(info.filename) for info in fuente.infolist()}

        tipos = ET.fromstring(miembros["[Content_Types].xml"])
        if not any(elemento.attrib.get("Extension") == "png" for elemento in tipos):
            ET.SubElement(tipos, f"{{{ns_ct}}}Default", {
                "Extension": "png", "ContentType": "image/png"
            })

        hojas = sorted(
            (nombre for nombre in miembros
             if nombre.startswith("xl/worksheets/sheet") and nombre.endswith(".xml")),
            key=lambda nombre: int(nombre.rsplit("/", 1)[1][5:-4]),
        )
        if not hojas:
            return

        for numero, hoja_nombre in enumerate(hojas, start=1):
            hoja_xml = ET.fromstring(miembros[hoja_nombre])
            if hoja_xml.find("main:drawing", ns) is not None:
                continue

            carpeta_hoja, archivo_hoja = hoja_nombre.rsplit("/", 1)
            rels_nombre = f"{carpeta_hoja}/_rels/{archivo_hoja}.rels"
            if rels_nombre in miembros:
                rels = ET.fromstring(miembros[rels_nombre])
            else:
                rels = ET.Element(f"{{{ns_pkg_rel}}}Relationships")
            ids = [
                int(elemento.attrib["Id"][3:])
                for elemento in rels
                if elemento.attrib.get("Id", "").startswith("rId")
                and elemento.attrib["Id"][3:].isdigit()
            ]
            rid = f"rId{max(ids, default=0) + 1}"
            ET.SubElement(rels, f"{{{ns_pkg_rel}}}Relationship", {
                "Id": rid,
                "Type": f"{ns_rel}/drawing",
                "Target": f"../drawings/drawing{numero}.xml",
            })
            referencia_dibujo = ET.Element(f"{{{ns_main}}}drawing", {f"{{{ns_rel}}}id": rid})
            extension_lista = hoja_xml.find("main:extLst", ns)
            if extension_lista is None:
                hoja_xml.append(referencia_dibujo)
            else:
                hoja_xml.insert(list(hoja_xml).index(extension_lista), referencia_dibujo)

            dibujo = ET.Element(f"{{{ns_xdr}}}wsDr")
            ancla = ET.SubElement(dibujo, f"{{{ns_xdr}}}oneCellAnchor")
            desde = ET.SubElement(ancla, f"{{{ns_xdr}}}from")
            for etiqueta, valor in (("col", 0), ("colOff", 0), ("row", 0), ("rowOff", 0)):
                ET.SubElement(desde, f"{{{ns_xdr}}}{etiqueta}").text = str(valor)
            ET.SubElement(ancla, f"{{{ns_xdr}}}ext", {"cx": "1476375", "cy": "381000"})
            imagen = ET.SubElement(ancla, f"{{{ns_xdr}}}pic")
            no_visual = ET.SubElement(imagen, f"{{{ns_xdr}}}nvPicPr")
            ET.SubElement(no_visual, f"{{{ns_xdr}}}cNvPr", {"id": "2", "name": "Sterinova"})
            ET.SubElement(no_visual, f"{{{ns_xdr}}}cNvPicPr")
            relleno = ET.SubElement(imagen, f"{{{ns_xdr}}}blipFill")
            ET.SubElement(relleno, f"{{{ns_a}}}blip", {f"{{{ns_rel}}}embed": "rId1"})
            estirar = ET.SubElement(relleno, f"{{{ns_a}}}stretch")
            ET.SubElement(estirar, f"{{{ns_a}}}fillRect")
            forma = ET.SubElement(imagen, f"{{{ns_xdr}}}spPr")
            transformacion = ET.SubElement(forma, f"{{{ns_a}}}xfrm")
            ET.SubElement(transformacion, f"{{{ns_a}}}off", {"x": "0", "y": "0"})
            ET.SubElement(transformacion, f"{{{ns_a}}}ext", {"cx": "1476375", "cy": "381000"})
            geometria = ET.SubElement(forma, f"{{{ns_a}}}prstGeom", {"prst": "rect"})
            ET.SubElement(geometria, f"{{{ns_a}}}avLst")
            ET.SubElement(ancla, f"{{{ns_xdr}}}clientData")

            dibujo_nombre = f"xl/drawings/drawing{numero}.xml"
            dibujo_rels_nombre = f"xl/drawings/_rels/drawing{numero}.xml.rels"
            dibujo_rels = ET.Element(f"{{{ns_pkg_rel}}}Relationships")
            ET.SubElement(dibujo_rels, f"{{{ns_pkg_rel}}}Relationship", {
                "Id": "rId1", "Type": f"{ns_rel}/image", "Target": "../media/sterinova_logo.png"
            })
            miembros[dibujo_nombre] = ET.tostring(dibujo, encoding="utf-8", xml_declaration=True)
            miembros[dibujo_rels_nombre] = ET.tostring(dibujo_rels, encoding="utf-8", xml_declaration=True)
            miembros[rels_nombre] = ET.tostring(rels, encoding="utf-8", xml_declaration=True)
            miembros[hoja_nombre] = ET.tostring(hoja_xml, encoding="utf-8", xml_declaration=True)
            ET.SubElement(tipos, f"{{{ns_ct}}}Override", {
                "PartName": f"/{dibujo_nombre}",
                "ContentType": "application/vnd.openxmlformats-officedocument.drawing+xml",
            })

        miembros["[Content_Types].xml"] = ET.tostring(tipos, encoding="utf-8", xml_declaration=True)
        miembros["xl/media/sterinova_logo.png"] = ruta_logo.read_bytes()
        with ZipFile(temporal, "w", ZIP_DEFLATED) as destino:
            for nombre, contenido in miembros.items():
                destino.writestr(nombre, contenido)
        temporal.replace(ruta_archivo)
    except Exception:
        try:
            if "temporal" in locals() and temporal.exists():
                temporal.unlink()
        except OSError:
            pass


def _estilizar_hoja_turnos(hoja, ultima_fila: int) -> None:
    encabezado = PatternFill("solid", fgColor=PETROLEO.lstrip("#"))
    blanco_negrita = Font(name="Calibri", bold=True, color="FFFFFF")
    borde_fino = Side(style="thin", color="AAB9BC")
    borde = Border(left=borde_fino, right=borde_fino, top=borde_fino, bottom=borde_fino)
    for celda in hoja[8][:9]:
        celda.fill = encabezado
        celda.font = blanco_negrita
        celda.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    for fila in hoja.iter_rows(min_row=8, max_row=ultima_fila, min_col=1, max_col=9):
        for celda in fila:
            celda.border = borde
            if celda.row > 8:
                celda.alignment = Alignment(vertical="center", horizontal="center")
    hoja.row_dimensions[8].height = 30
    hoja["C7"].font = Font(name="Calibri", size=12, bold=True, color=PETROLEO.lstrip("#"))
    hoja["C7"].alignment = Alignment(horizontal="left", vertical="center")
    _insertar_logo(hoja)


def _carpeta_descargas() -> Path:
    """Devuelve la carpeta Downloads del perfil del usuario actual."""
    return Path.home() / "Downloads"


def obtener_carpeta_reportes(
    fecha_periodo: date | datetime | None = None,
    base_descargas: Path | None = None,
) -> Path:
    """Crea y devuelve Descargas/Reportes_Nomina/AAAA/MM_Mes del período."""
    if fecha_periodo is None:
        fecha_periodo = date.today()
    if isinstance(fecha_periodo, datetime):
        fecha_periodo = fecha_periodo.date()
    descargas = Path(base_descargas) if base_descargas is not None else _carpeta_descargas()
    meses = (
        "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
        "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
    )
    carpeta = descargas / "Reportes_Nomina" / f"{fecha_periodo.year}" / (
        f"{fecha_periodo.month:02d}_{meses[fecha_periodo.month - 1]}"
    )
    carpeta.mkdir(parents=True, exist_ok=True)
    return carpeta


def _es_domingo(fecha: datetime) -> bool:
    return fecha.weekday() == 6


def _suma_horas(piezas: list[tuple[datetime, datetime]]) -> float:
    segundos = sum(
        max(0, (fin - inicio).total_seconds())
        for inicio, fin in piezas
    )
    return round(segundos / 3600, 2)


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


def _piezas_nocturnas(inicio: datetime, fin: datetime) -> list[tuple[datetime, datetime]]:
    if fin <= inicio:
        return []
    piezas = []
    cursor = inicio
    while cursor < fin:
        dia = cursor.date()
        noche_inicio = datetime.combine(dia, datetime.strptime("22:00", "%H:%M").time())
        noche_fin = datetime.combine(dia + timedelta(days=1), datetime.strptime("06:00", "%H:%M").time())
        manana_inicio = datetime.combine(dia, datetime.strptime("06:00", "%H:%M").time())

        limites = (
            (noche_inicio, noche_fin),
            (datetime.combine(dia - timedelta(days=1), datetime.strptime("22:00", "%H:%M").time()), manana_inicio),
        )
        for limite_inicio, limite_fin in limites:
            inter_inicio = max(cursor, limite_inicio)
            inter_fin = min(fin, limite_fin)
            if inter_fin > inter_inicio:
                piezas.append((inter_inicio, inter_fin))
        if cursor.date() == fin.date():
            break
        cursor = datetime.combine(dia + timedelta(days=1), datetime.min.time())
    return piezas


def _clasificar_piezas(
    piezas: list[tuple[datetime, datetime]],
) -> tuple[list[tuple[datetime, datetime]], list[tuple[datetime, datetime]]]:
    diurnas = []
    nocturnas = []
    for inicio, fin in piezas:
        cursor = inicio
        while cursor < fin:
            dia = cursor.date()
            noche_inicio = datetime.combine(dia, datetime.strptime("22:00", "%H:%M").time())
            noche_fin = datetime.combine(dia + timedelta(days=1), datetime.strptime("06:00", "%H:%M").time())
            manana_inicio = datetime.combine(dia, datetime.strptime("06:00", "%H:%M").time())
            noche_anterior_inicio = datetime.combine(dia - timedelta(days=1), datetime.strptime("22:00", "%H:%M").time())
            noche_anterior_fin = manana_inicio

            limites = (
                (noche_anterior_inicio, noche_anterior_fin),
                (noche_inicio, noche_fin),
            )
            siguiente = fin
            for limite_inicio, limite_fin in limites:
                inter_inicio = max(cursor, limite_inicio)
                inter_fin = min(fin, limite_fin)
                if inter_fin > inter_inicio:
                    nocturnas.append((inter_inicio, inter_fin))
                    siguiente = min(siguiente, inter_inicio)
            if not any(
                max(cursor, limite_inicio) < min(fin, limite_fin)
                for limite_inicio, limite_fin in limites
            ):
                siguiente_minuto = datetime.combine(dia + timedelta(days=1), datetime.min.time())
                siguiente = min(fin, siguiente_minuto)
                diurnas.append((cursor, siguiente))
            cursor = max(siguiente, cursor + timedelta(minutes=1))
    return diurnas, nocturnas


def _partes_horario(
    inicio: datetime,
    fin: datetime,
) -> tuple[list[tuple[datetime, datetime]], list[tuple[datetime, datetime]]]:
    diurnas = []
    nocturnas = []
    cursor = inicio
    while cursor < fin:
        dia = cursor.date()
        limites = [
            datetime.combine(dia, datetime.min.time()),
            datetime.combine(dia, datetime.strptime("06:00", "%H:%M").time()),
            datetime.combine(dia, datetime.strptime("22:00", "%H:%M").time()),
            datetime.combine(dia + timedelta(days=1), datetime.min.time()),
        ]
        siguientes = [limite for limite in limites if limite > cursor]
        if not siguientes:
            siguiente = fin
        else:
            siguiente = min(fin, min(siguientes))
        if siguiente > cursor:
            hora = cursor.hour + cursor.minute / 60
            if hora < 6 or hora >= 22:
                nocturnas.append((cursor, siguiente))
            else:
                diurnas.append((cursor, siguiente))
        cursor = siguiente
    return diurnas, nocturnas


def calcular_recargos(
    entrada_real: datetime,
    salida_real: datetime,
    entrada_teorica: datetime,
    salida_teorica: datetime,
) -> dict[str, float]:
    if entrada_real is None or salida_real is None:
        return {"ED": 0.0, "EN": 0.0, "EF": 0.0, "END": 0.0, "RN": 0.0, "RND": 0.0, "RF": 0.0}
    turno = type(
        "TurnoExportacion",
        (),
        {
            "hora_entrada": entrada_teorica.strftime("%H:%M") if entrada_teorica is not None else entrada_real.strftime("%H:%M"),
            "hora_salida": salida_teorica.strftime("%H:%M") if salida_teorica is not None else salida_real.strftime("%H:%M"),
        },
    )()
    return descomponer_recargos(
        entrada_real,
        salida_real,
        turno,
        es_domingo_festivo=_es_domingo(entrada_real),
    )


def exportar_comparativo(detalle: pd.DataFrame, ruta_salida: str) -> str:
    if detalle is None or detalle.empty:
        raise ValueError(
            "No hay asignaciones ni marcaciones para generar el comparativo."
        )
    columnas_requeridas = {"id_empleado", "horas_normales", "horas_extra", "horas_nocturnas"}
    faltantes = columnas_requeridas.difference(detalle.columns)
    if faltantes:
        raise ValueError(
            "El comparativo no contiene las columnas requeridas: "
            + ", ".join(sorted(faltantes))
        )
    ruta = Path(ruta_salida)
    ruta.parent.mkdir(parents=True, exist_ok=True)

    resumen = (
        detalle.groupby("id_empleado", as_index=False)
        .agg(
            {
                "horas_normales": "sum",
                "horas_extra": "sum",
                "horas_nocturnas": "sum",
                "minutos_tardanza": "sum",
                "minutos_salida_anticipada": "sum",
            }
        )
        .rename(columns={"id_empleado": "ID_Empleado"})
    )
    resumen["ausencias"] = (
        detalle.assign(es_ausencia=detalle["estado"].eq("AUSENCIA"))
        .groupby("id_empleado")["es_ausencia"]
        .sum()
        .reindex(resumen["ID_Empleado"])
        .fillna(0)
        .astype(int)
        .values
    )
    tardanzas = detalle.loc[
        detalle["estado"].astype(str).str.startswith("TARDANZA")
    ].copy()
    if not tardanzas.empty:
        tardanzas["novedad_tardanza"] = tardanzas["minutos_tardanza"].map(
            lambda minutos: f"TARDANZA ({int(minutos)} min)"
        )
        if "fecha" in tardanzas.columns:
            fechas = pd.to_datetime(tardanzas["fecha"], errors="coerce")
            tardanzas["novedad_tardanza"] = (
                fechas.dt.strftime("%d/%m/%Y")
                + ": "
                + tardanzas["novedad_tardanza"]
            )
        resumen_novedades = tardanzas.groupby("id_empleado")["novedad_tardanza"].agg(
            "; ".join
        )
        resumen["observaciones"] = (
            resumen["ID_Empleado"].map(resumen_novedades).fillna("")
        )
    else:
        resumen["observaciones"] = ""
    with pd.ExcelWriter(ruta, engine="openpyxl") as writer:
        detalle.to_excel(writer, sheet_name="Detalle", index=False)
        resumen.to_excel(writer, sheet_name="Resumen por empleado", index=False)

        workbook = writer.book
        for worksheet in workbook.worksheets:
            worksheet.freeze_panes = "A2"
            worksheet.auto_filter.ref = worksheet.dimensions
            for cell in worksheet[1]:
                cell.font = Font(bold=True)
            for column_cells in worksheet.columns:
                length = max(len(str(cell.value or "")) for cell in column_cells)
                worksheet.column_dimensions[get_column_letter(column_cells[0].column)].width = min(
                    max(length + 2, 12), 45
                )
            for row in worksheet.iter_rows():
                for cell in row:
                    cell.alignment = Alignment(vertical="top")

            totals_row = worksheet.max_row + 1
            if worksheet.title in ("Detalle", "Resumen por empleado"):
                worksheet.cell(totals_row, 1, "TOTAL")
                worksheet.cell(totals_row, 1).font = Font(bold=True)

    return str(ruta)


def exportar_reporte_novedades(detalle: pd.DataFrame, ruta_salida: str) -> str:
    """Exporta las seis categorías de novedades con el filtro recibido aplicado."""
    ruta = Path(ruta_salida)
    ruta.parent.mkdir(parents=True, exist_ok=True)
    novedades = construir_reporte_novedades(detalle)
    with pd.ExcelWriter(ruta, engine="openpyxl") as writer:
        for nombre_hoja in HOJAS_NOVEDADES:
            novedades[nombre_hoja].to_excel(writer, sheet_name=nombre_hoja, index=False)
        for hoja in writer.book.worksheets:
            hoja.freeze_panes = "A2"
            hoja.auto_filter.ref = hoja.dimensions
            hoja.row_dimensions[1].height = 30
            for celda in hoja[1]:
                celda.fill = PatternFill("solid", fgColor=PETROLEO.lstrip("#"))
                celda.font = Font(bold=True, color="FFFFFF")
                celda.alignment = Alignment(vertical="center", wrap_text=True)
            for columna in hoja.columns:
                encabezado = str(columna[0].value or "")
                largo = max((len(str(celda.value or "")) for celda in columna), default=10)
                hoja.column_dimensions[get_column_letter(columna[0].column)].width = min(
                    max(largo + 2, 12), 40
                )
                if encabezado.startswith("hora_"):
                    for celda in columna[1:]:
                        celda.number_format = "hh:mm"
                elif encabezado in ("horas_extra", "ED", "EN", "EF", "END", "RN", "RND", "RF"):
                    for celda in columna[1:]:
                        celda.number_format = "0.00"
    return str(ruta)


def exportar_auditoria_no_programados(
    detalle: pd.DataFrame,
    ruta_salida: str,
    nombres_empleados: dict[str, str] | None = None,
) -> str:
    """Escribe en una sola hoja las jornadas marcadas sin turno asignado."""
    if detalle is None or detalle.empty:
        raise ValueError("No hay marcaciones no programadas para exportar.")
    auditoria = detalle.loc[
        detalle["turno"].astype(str).str.upper().eq("NO PROGRAMADO")
    ].copy()
    if auditoria.empty:
        raise ValueError("No hay marcaciones no programadas para exportar.")
    nombres = nombres_empleados or {}
    auditoria["empleado"] = auditoria["id_empleado"].astype(str).map(nombres).fillna("")
    columnas = [
        "fecha", "id_empleado", "empleado", "turno", "hora_entrada_real",
        "hora_salida_real", "horas_extra", "ED", "EN", "EF", "END", "observaciones",
    ]
    columnas = [columna for columna in columnas if columna in auditoria.columns]
    auditoria = auditoria[columnas].sort_values(
        [columna for columna in ("fecha", "id_empleado") if columna in columnas]
    )
    ruta = Path(ruta_salida)
    ruta.parent.mkdir(parents=True, exist_ok=True)
    auditoria.to_excel(ruta, sheet_name="No programados", index=False, engine="openpyxl")
    workbook = load_workbook(ruta)
    hoja = workbook["No programados"]
    hoja.freeze_panes = "A2"
    hoja.auto_filter.ref = hoja.dimensions
    hoja.row_dimensions[1].height = 30
    for celda in hoja[1]:
        celda.fill = PatternFill("solid", fgColor=PETROLEO.lstrip("#"))
        celda.font = Font(name="Calibri", bold=True, color="FFFFFF")
        celda.alignment = Alignment(vertical="center", wrap_text=True)
    for columna in hoja.columns:
        encabezado = str(columna[0].value or "")
        ancho = max((len(str(celda.value or "")) for celda in columna), default=10)
        hoja.column_dimensions[get_column_letter(columna[0].column)].width = min(
            max(ancho + 2, 12), 38
        )
        if encabezado == "fecha":
            for celda in columna[1:]:
                celda.number_format = "dd/mm/yyyy"
        elif encabezado.startswith("hora_"):
            for celda in columna[1:]:
                celda.number_format = "hh:mm"
        elif encabezado in {"horas_extra", "ED", "EN", "EF", "END"}:
            for celda in columna[1:]:
                celda.number_format = "0.00"
    workbook.save(ruta)
    workbook.close()
    _incrustar_logo_xlsx(ruta)
    return str(ruta)


def _limpiar_nombre_archivo(nombre: str) -> str:
    limpio = re.sub(r'[<>:"/\\|?*]', "", str(nombre)).strip()
    limpio = re.sub(r"\s+", "_", limpio)
    return limpio or "Empleado"


def _formato_hora_excel(valor: object) -> str:
    if valor is None or pd.isna(valor):
        return ""
    if isinstance(valor, pd.Timestamp):
        return valor.strftime("%H:%M")
    if isinstance(valor, datetime):
        return valor.strftime("%H:%M")
    if hasattr(valor, "strftime"):
        return valor.strftime("%H:%M")
    return str(valor)


def _mes_legible(mes: date) -> str:
    nombres = (
        "ENERO", "FEBRERO", "MARZO", "ABRIL", "MAYO", "JUNIO",
        "JULIO", "AGOSTO", "SEPTIEMBRE", "OCTUBRE", "NOVIEMBRE", "DICIEMBRE",
    )
    return f"{nombres[mes.month - 1]} {mes.year}"


def _resolver_periodo(
    mes: date,
    fecha_inicio: date | None = None,
    fecha_fin: date | None = None,
) -> tuple[date, date]:
    inicio_mes = date(mes.year, mes.month, 1)
    fin_mes = date(mes.year, mes.month, calendar.monthrange(mes.year, mes.month)[1])
    inicio = fecha_inicio or inicio_mes
    fin = fecha_fin or fin_mes
    if inicio > fin:
        raise ValueError("La fecha inicial del período no puede ser posterior a la fecha final.")
    if (fin - inicio).days >= 31:
        raise ValueError("La plantilla de turnos admite períodos de máximo 31 días.")
    return inicio, fin


def _titulo_periodo(inicio: date, fin: date) -> str:
    titulo = f"HOJA DE TURNOS - {_mes_legible(inicio)}"
    fin_mes = date(inicio.year, inicio.month, calendar.monthrange(inicio.year, inicio.month)[1])
    if inicio == date(inicio.year, inicio.month, 1) and fin == fin_mes:
        return titulo
    if inicio.year == fin.year and inicio.month == fin.month:
        rango = f"{inicio.day:02d} AL {fin.day:02d}"
    else:
        rango = f"{inicio:%d/%m} AL {fin:%d/%m}"
    return f"{titulo} ({rango})"


def _nombre_hoja(nombre: str) -> str:
    limpio = re.sub(r"[\[\]:*?/\\]", "", str(nombre).strip())
    limpio = re.sub(r"\s+", " ", limpio)
    return (limpio[:31] or "Empleado")


def _escribir_detalle_periodo(
    hoja,
    id_empleado: str,
    nombre_empleado: str,
    mes: date,
    detalle: pd.DataFrame,
    fecha_inicio: date | None,
    fecha_fin: date | None,
) -> int:
    inicio, fin = _resolver_periodo(mes, fecha_inicio, fecha_fin)
    base = _nombre_hoja(nombre_empleado)
    ocupados = {otra.title.casefold() for otra in hoja.parent.worksheets if otra is not hoja}
    titulo = base
    indice = 2
    while titulo.casefold() in ocupados:
        sufijo = f" {indice}"
        titulo = base[:31 - len(sufijo)] + sufijo
        indice += 1
    hoja.title = titulo
    hoja["E1"] = _titulo_periodo(inicio, fin)
    hoja["C7"] = str(nombre_empleado).strip()
    hoja["A42"] = "TOTAL DE HORAS EXTRAS"
    hoja["J8"] = "Observaciones"

    detalle_empleado = detalle[
        detalle["id_empleado"].astype(str).str.strip() == str(id_empleado).strip()
    ].copy()
    detalle_empleado["fecha"] = pd.to_datetime(detalle_empleado["fecha"], errors="coerce")
    detalle_empleado = detalle_empleado[
        (detalle_empleado["fecha"].dt.date >= inicio)
        & (detalle_empleado["fecha"].dt.date <= fin)
    ].sort_values("fecha")
    filas_por_fecha = {}
    for fila in detalle_empleado.itertuples(index=False, name=None):
        fila_dict = dict(zip(detalle_empleado.columns, fila))
        fecha_valor = pd.to_datetime(fila_dict.get("fecha"), errors="coerce")
        if pd.notna(fecha_valor):
            filas_por_fecha[pd.Timestamp(fecha_valor).date()] = fila_dict

    fechas_periodo = [inicio + timedelta(days=offset) for offset in range((fin - inicio).days + 1)]
    for indice in range(31):
        fila_excel = 9 + indice
        if indice >= len(fechas_periodo):
            for columna in range(1, 11):
                hoja.cell(fila_excel, columna, None)
            continue
        fecha = fechas_periodo[indice]
        hoja.cell(fila_excel, 1, fecha.strftime("%d/%m/%Y"))
        fila_detalle = filas_por_fecha.get(fecha)
        if fila_detalle is None:
            entrada = salida_hora = observaciones = ""
            recargos = {clave: 0.0 for clave in ("ED", "EN", "EF", "END", "RN", "RND", "RF")}
        else:
            observaciones = str(fila_detalle.get("observaciones", "") or "")
            estado = str(fila_detalle.get("estado", "") or "")
            if estado == "DESCANSO FESTIVO":
                entrada = salida_hora = ""
                observaciones = "DESCANSO FESTIVO"
            else:
                entrada = _formato_hora_excel(
                    fila_detalle.get("hora_entrada_real", fila_detalle.get("hora_entrada_teorica"))
                )
                salida_hora = _formato_hora_excel(
                    fila_detalle.get("hora_salida_real", fila_detalle.get("hora_salida_teorica"))
                )
            recargos = {
                clave: float(fila_detalle.get(clave, 0) or 0)
                for clave in ("ED", "EN", "EF", "END", "RN", "RND", "RF")
            }

        for columna, valor in (
            (2, entrada), (3, salida_hora), (4, recargos["ED"]),
            (5, recargos["EN"]), (6, recargos["EF"]), (7, recargos["END"]),
            (8, recargos["RN"]), (9, recargos["RND"]), (10, observaciones),
        ):
            hoja.cell(fila_excel, columna, valor)

    ultima_fila = 8 + len(fechas_periodo)
    hoja["D42"] = (
        f'=SUM(D9:D{ultima_fila})+SUM(E9:E{ultima_fila})'
        f'+SUM(F9:F{ultima_fila})+SUM(G9:G{ultima_fila})'
    )
    _estilizar_hoja_turnos(hoja, ultima_fila)

    # Los recargos son conceptos distintos de las horas extra. Se resumen
    # aparte para evitar sumarlos al total de E.D/E.N/E.F/E.N.D.
    totales = {}
    for clave in ("ED", "EN", "EF", "END", "RN", "RND", "RF"):
        valores = (
            pd.to_numeric(detalle_empleado[clave], errors="coerce").fillna(0)
            if clave in detalle_empleado
            else pd.Series(dtype="float64")
        )
        totales[clave] = float(valores.sum())
    etiquetas = {
        "ED": "E.D", "EN": "E.N", "EF": "E.F", "END": "E.N.D",
        "RN": "R.N", "RND": "R.N.D", "RF": "R.F",
    }
    resumen = "RESUMEN DE HORAS | " + " | ".join(
        f"{etiquetas[clave]}: {totales[clave]:.2f}"
        for clave in ("ED", "EN", "EF", "END", "RN", "RND", "RF")
    )
    hoja.merge_cells("A43:J43")
    hoja["A43"] = resumen
    hoja["A43"].fill = PatternFill("solid", fgColor="E8F0F1")
    hoja["A43"].font = Font(name="Calibri", size=9, bold=True, color=PETROLEO.lstrip("#"))
    hoja["A43"].alignment = Alignment(horizontal="left", vertical="center", shrink_to_fit=True)
    hoja["A43"].border = Border(
        left=Side(style="thin", color="AAB9BC"),
        right=Side(style="thin", color="AAB9BC"),
        top=Side(style="thin", color="AAB9BC"),
        bottom=Side(style="thin", color="AAB9BC"),
    )
    hoja.row_dimensions[43].height = 22
    return len(fechas_periodo)


def _llenar_hoja_formato(
    hoja,
    id_empleado: str,
    nombre_empleado: str,
    mes: date,
    detalle: pd.DataFrame,
    fecha_inicio: date | None = None,
    fecha_fin: date | None = None,
) -> None:
    _escribir_detalle_periodo(
        hoja, id_empleado, nombre_empleado, mes, detalle, fecha_inicio, fecha_fin
    )


def generar_hoja_turnos(
    id_empleado: str,
    nombre_empleado: str,
    mes: date,
    detalle: pd.DataFrame,
    ruta_salida: str | None = None,
    fecha_inicio: date | None = None,
    fecha_fin: date | None = None,
) -> str:
    inicio, fin = _resolver_periodo(mes, fecha_inicio, fecha_fin)
    plantilla = recurso_data("FORMATO DE SALIDA.xlsx")
    if not plantilla.exists():
        raise FileNotFoundError(f"No se encontró la plantilla física: {plantilla}")

    salida = Path(ruta_salida) if ruta_salida else (
        obtener_carpeta_reportes(fecha_inicio or mes)
        / f"Hoja_Turnos_{_limpiar_nombre_archivo(nombre_empleado)}_{inicio:%Y%m%d}_{fin:%Y%m%d}.xlsx"
    )
    salida.parent.mkdir(parents=True, exist_ok=True)

    workbook = load_workbook(plantilla)
    hoja = workbook[workbook.sheetnames[0]]
    for fila in range(9, 40):
        rango = f"G{fila}:H{fila}"
        if rango in {str(valor) for valor in hoja.merged_cells.ranges}:
            hoja.unmerge_cells(rango)

    _escribir_detalle_periodo(
        hoja,
        id_empleado,
        nombre_empleado,
        mes,
        detalle,
        fecha_inicio,
        fecha_fin,
    )

    workbook.save(salida)
    workbook.close()
    _incrustar_logo_xlsx(salida)
    return str(salida)


def generar_hojas_turnos(
    db,
    detalle: pd.DataFrame,
    mes: date,
    salida: str | None = None,
    fecha_inicio: date | None = None,
    fecha_fin: date | None = None,
    sufijo_archivo: str = "",
) -> list[str]:
    if detalle is None or detalle.empty:
        return []

    inicio, fin = _resolver_periodo(mes, fecha_inicio, fecha_fin)
    salida_dir = Path(salida) if salida else obtener_carpeta_reportes(inicio)
    salida_dir.mkdir(parents=True, exist_ok=True)
    empleados = db.listar_empleados()
    ids_detalle = {
        str(valor) for valor in detalle["id_empleado"].dropna().tolist()
    }
    seleccionados = [
        (id_empleado, nombre)
        for id_empleado, nombre in empleados
        if str(id_empleado) in ids_detalle
    ]
    if not seleccionados:
        return []

    plantilla = recurso_data("FORMATO DE SALIDA.xlsx")
    if not plantilla.exists():
        raise FileNotFoundError(f"No se encontró la plantilla física: {plantilla}")

    workbook = load_workbook(plantilla)
    plantilla_hoja = workbook[workbook.sheetnames[0]]
    rangos_unmerges = {str(valor) for valor in plantilla_hoja.merged_cells.ranges}
    for fila in range(9, 40):
        rango = f"G{fila}:H{fila}"
        if rango in rangos_unmerges:
            plantilla_hoja.unmerge_cells(rango)

    for indice, (id_empleado, nombre) in enumerate(seleccionados):
        hoja = plantilla_hoja if indice == 0 else workbook.copy_worksheet(plantilla_hoja)
        _llenar_hoja_formato(
            hoja,
            str(id_empleado),
            str(nombre),
            mes,
            detalle,
            fecha_inicio,
            fecha_fin,
        )

    sufijo = f"_{sufijo_archivo}" if sufijo_archivo else ""
    ruta = salida_dir / f"Horas_Por_Empleado_{inicio:%Y%m%d}_{fin:%Y%m%d}{sufijo}.xlsx"
    workbook.save(ruta)
    workbook.close()
    _incrustar_logo_xlsx(ruta)
    return [str(ruta)]

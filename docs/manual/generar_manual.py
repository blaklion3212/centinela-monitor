#!/usr/bin/env python3
"""Genera el PDF del manual de Centinela a partir de docs/manual/manual.md.

Uso:
    python3 docs/manual/generar_manual.py [--entrada ruta.md] [--salida ruta.pdf]

Requiere python3-reportlab y las fuentes DejaVu (ver docs/manual/README.md).
"""
import argparse
import os
import re
import sys
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.utils import ImageReader, simpleSplit
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate, Frame, KeepTogether, NextPageTemplate, PageBreak,
    PageTemplate, Paragraph, Preformatted, XPreformatted, Spacer, Table, TableStyle, Image,
)
from reportlab.platypus.tableofcontents import TableOfContents

RAIZ = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DIR_MANUAL = os.path.join(RAIZ, "docs", "manual")
ENTRADA_DEF = os.path.join(DIR_MANUAL, "manual.md")
SALIDA_DEF = os.path.join(RAIZ, "docs", "Centinela-Manual-de-usuario.pdf")
DIR_FUENTES = "/usr/share/fonts/truetype/dejavu/"

# Paleta (muestreada del manual original)
NAVY = colors.HexColor("#0f1b2d")
AZUL = colors.HexColor("#1e6bd4")
AZUL_CLARO = colors.HexColor("#689ee7")
TEXTO = colors.HexColor("#1b2a3d")
GRIS = colors.HexColor("#6b7686")
FILA_ALT = colors.HexColor("#eef3fa")
BORDE = colors.HexColor("#c9d2de")
FONDO_CODIGO = colors.HexColor("#f1f3f6")

PAG_W, PAG_H = letter
MARGEN_X = 57
MARGEN_SUP = 62
MARGEN_INF = 62
ANCHO_UTIL = PAG_W - 2 * MARGEN_X

# Cajas de aviso: (fondo, borde)
CAJAS = {
    "nota": (colors.HexColor("#e8f0fd"), AZUL),
    "importante": (colors.HexColor("#fff4dc"), colors.HexColor("#d98a00")),
    "consejo": (colors.HexColor("#e5f6ec"), colors.HexColor("#1f9d55")),
}


class ErrorManual(Exception):
    """Error de contenido o de entorno con mensaje claro para el usuario."""


# --------------------------------------------------------------- fuentes
def registrar_fuentes():
    archivos = {
        "DV": "DejaVuSansCondensed.ttf",
        "DV-B": "DejaVuSansCondensed-Bold.ttf",
        "DV-I": "DejaVuSansCondensed-Oblique.ttf",
        "DV-BI": "DejaVuSansCondensed-BoldOblique.ttf",
        "DVM": "DejaVuSansMono.ttf",
        "DVM-B": "DejaVuSansMono-Bold.ttf",
    }
    for nombre, arch in archivos.items():
        ruta = DIR_FUENTES + arch
        if not os.path.isfile(ruta):
            raise ErrorManual(f"Falta la fuente {ruta}. Instala fonts-dejavu-core / fonts-dejavu-extra.")
        pdfmetrics.registerFont(TTFont(nombre, ruta))
    pdfmetrics.registerFontFamily("DV", normal="DV", bold="DV-B", italic="DV-I", boldItalic="DV-BI")
    pdfmetrics.registerFontFamily("DVM", normal="DVM", bold="DVM-B", italic="DVM", boldItalic="DVM-B")


# --------------------------------------------------------------- estilos
def crear_estilos():
    e = {}
    e["cuerpo"] = ParagraphStyle("cuerpo", fontName="DV", fontSize=9, leading=13.2, textColor=TEXTO, spaceAfter=6)
    e["h1"] = ParagraphStyle("h1", parent=e["cuerpo"], fontName="DV-B", fontSize=20.5, leading=26, textColor=NAVY, spaceAfter=12)
    e["h2"] = ParagraphStyle("h2", parent=e["cuerpo"], fontName="DV-B", fontSize=14, leading=18, textColor=AZUL, spaceBefore=14, spaceAfter=7, keepWithNext=1)
    e["h3"] = ParagraphStyle("h3", parent=e["cuerpo"], fontName="DV-B", fontSize=10.5, leading=14, textColor=NAVY, spaceBefore=8, spaceAfter=4, keepWithNext=1)
    e["lista"] = ParagraphStyle("lista", parent=e["cuerpo"], spaceAfter=2.5)
    e["celda"] = ParagraphStyle("celda", parent=e["cuerpo"], fontSize=8, leading=11, spaceAfter=0)
    e["celda_cab"] = ParagraphStyle("celda_cab", parent=e["celda"], fontName="DV-B", textColor=colors.white)
    e["pie_fig"] = ParagraphStyle("pie_fig", parent=e["cuerpo"], fontName="DV-I", fontSize=8, leading=10.5, textColor=GRIS, alignment=TA_CENTER, spaceBefore=3, spaceAfter=10)
    e["caja"] = ParagraphStyle("caja", parent=e["cuerpo"], fontSize=8.8, leading=12.5, spaceAfter=0)
    e["codigo"] = ParagraphStyle("codigo", fontName="DVM", fontSize=7.4, leading=9.8, textColor=TEXTO)
    e["toc_titulo"] = ParagraphStyle("toc_titulo", parent=e["h1"], spaceAfter=14)
    e["toc0"] = ParagraphStyle("toc0", parent=e["cuerpo"], fontName="DV-B", fontSize=9, leading=12, spaceBefore=8, spaceAfter=0)
    e["toc1"] = ParagraphStyle("toc1", parent=e["cuerpo"], fontSize=7.8, leading=10, leftIndent=12, spaceBefore=5.5, spaceAfter=0)
    return e


# ------------------------------------------------------- markdown en línea
# Las fuentes DejaVu no tienen emojis: los de los avisos se dibujan como un círculo o una marca de color.
EMOJIS = {
    "🔴": '<font face="DV" color="#d32f2f">●</font>',
    "🟠": '<font face="DV" color="#ef6c00">●</font>',
    "🟢": '<font face="DV" color="#2e7d32">●</font>',
    "✅": '<font face="DV" color="#2e7d32">✔</font>',
}


def emojis(marcado):
    """Sustituye los emojis por su equivalente con fuente DejaVu (sobre texto ya escapado)."""
    for k, v in EMOJIS.items():
        marcado = marcado.replace(k, v)
    return marcado


def inline(texto):
    """Convierte Markdown en línea (negrita, cursiva, código) a marcado de Paragraph."""
    partes = re.split(r"(`[^`]+`)", texto)
    salida = []
    for p in partes:
        if len(p) > 1 and p.startswith("`") and p.endswith("`"):
            salida.append('<font face="DVM" size="8" color="#0b4fa8">%s</font>' % emojis(escape(p[1:-1])))
            continue
        p = emojis(escape(p))
        p = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", p)
        p = re.sub(r"(?<![\*\w])\*(?!\s)(.+?)(?<!\s)\*(?![\*\w])", r"<i>\1</i>", p)
        salida.append(p)
    return "".join(salida)


def texto_plano(texto):
    """Quita marcas Markdown (para títulos del índice y marcadores)."""
    return re.sub(r"[`*]", "", texto)


# ------------------------------------------------------------- documento
class Documento(BaseDocTemplate):
    def __init__(self, ruta, meta, **kw):
        super().__init__(ruta, pagesize=letter, leftMargin=MARGEN_X, rightMargin=MARGEN_X,
                         topMargin=MARGEN_SUP, bottomMargin=MARGEN_INF,
                         title=meta.get("title", "Manual"), author="Centinela",
                         subject=meta.get("subject", "Documentación del dashboard de monitoreo"), **kw)
        self.meta = meta
        marco_portada = Frame(MARGEN_X, MARGEN_INF, ANCHO_UTIL, 20, id="portada", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
        marco = Frame(MARGEN_X, MARGEN_INF, ANCHO_UTIL, PAG_H - MARGEN_SUP - MARGEN_INF, id="normal",
                      leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
        self.addPageTemplates([
            PageTemplate(id="portada", frames=[marco_portada], onPage=self.dibujar_portada),
            PageTemplate(id="normal", frames=[marco], onPage=self.dibujar_pagina),
        ])

    # Notifica al índice y crea marcadores/esquema PDF de cada título
    def afterFlowable(self, flowable):
        nivel = getattr(flowable, "_nivel_toc", None)
        if nivel is None:
            return
        texto = flowable.getPlainText()
        clave = flowable._clave  # estable entre pasadas
        self.canv.bookmarkPage(clave)
        self.canv.addOutlineEntry(texto, clave, level=nivel)
        self.notify("TOCEntry", (nivel, texto, self.page - 1, clave))

    def dibujar_pagina(self, c, doc):
        c.saveState()
        y = PAG_H - 36
        c.setFont("DV-B", 7.5)
        c.setFillColor(TEXTO)
        c.drawString(MARGEN_X, y, "Centinela")
        w = pdfmetrics.stringWidth("Centinela", "DV-B", 7.5)
        c.setFont("DV", 7.5)
        c.setFillColor(GRIS)
        c.drawString(MARGEN_X + w + 4, y, "· " + self.meta.get("title", "Manual de usuario y configuración"))
        c.setStrokeColor(BORDE)
        c.setLineWidth(0.6)
        c.line(MARGEN_X, y - 6, PAG_W - MARGEN_X, y - 6)
        c.line(MARGEN_X, 40, PAG_W - MARGEN_X, 40)
        c.setFont("DV", 7.5)
        c.setFillColor(GRIS)
        c.drawRightString(PAG_W - MARGEN_X, 28, "Página %d" % (doc.page - 1))
        c.restoreState()

    def dibujar_portada(self, c, doc):
        m = self.meta
        c.saveState()
        corte = PAG_H - 446
        c.setFillColor(NAVY)
        c.rect(0, corte, PAG_W, PAG_H - corte, stroke=0, fill=1)
        c.setFillColor(AZUL)
        c.rect(0, corte - 3.5, PAG_W, 3.5, stroke=0, fill=1)
        # Logo + nombre
        dibujar_logo(c, MARGEN_X, PAG_H - 58 - 40, 40)
        c.setFillColor(colors.white)
        c.setFont("DV-B", 11)
        c.drawString(MARGEN_X + 40 + 14, PAG_H - 58 - 24, "CENTINELA")
        # Título
        y = PAG_H - 180
        c.setFont("DV-B", 32)
        for linea in simpleSplit(m.get("title", ""), "DV-B", 32, 300):
            c.drawString(MARGEN_X, y, linea)
            y -= 38
        y -= 8
        c.setFont("DV", 10.5)
        c.setFillColor(colors.HexColor("#a9b6c8"))
        for linea in simpleSplit(m.get("subtitle", ""), "DV", 10.5, 270):
            c.drawString(MARGEN_X, y, linea)
            y -= 15
        c.setFont("DV", 9)
        c.setFillColor(colors.HexColor("#8fa0b6"))
        info = " · ".join(x for x in ["Versión " + m["version"] if m.get("version") else "", m.get("date", "")] if x)
        c.drawString(MARGEN_X, PAG_H - 326, info)
        # Captura inferior
        ruta = m.get("portada_img")
        if ruta:
            iw, ih = ImageReader(ruta).getSize()
            ancho = 436
            alto = ancho * ih / iw
            maxalto = corte - 3.5 - 30
            if alto > maxalto:
                alto, ancho = maxalto, maxalto * iw / ih
            c.drawImage(ruta, (PAG_W - ancho) / 2, corte - 3.5 - 18 - alto, ancho, alto)
        c.restoreState()


def dibujar_logo(c, x, y, s):
    """Logo de assets/img/logo.svg (viewBox 32x32) con primitivas de ReportLab."""
    k = s / 32.0
    c.saveState()
    c.translate(x, y)
    c.scale(k, k)
    # Cuadro redondeado con degradado diagonal (azul -> turquesa)
    p = c.beginPath()
    p.roundRect(0, 0, 32, 32, 8)
    c.clipPath(p, stroke=0, fill=0)
    c.linearGradient(0, 32, 32, 0, [colors.HexColor("#4f8cff"), colors.HexColor("#2dd4bf")], extend=True)
    c.restoreState()
    c.saveState()
    c.translate(x, y)
    c.scale(k, k)
    # Pulso: coordenadas SVG con eje Y invertido (y' = 32 - y)
    ruta = [(5, 18), (10, 18), (13, 10), (17, 24), (20, 15), (22, 18), (27, 18)]
    c.setStrokeColor(colors.HexColor("#0a1020"))
    c.setLineWidth(2.4)
    c.setLineCap(1)
    c.setLineJoin(1)
    q = c.beginPath()
    q.moveTo(*(ruta[0][0], 32 - ruta[0][1]))
    for px, py in ruta[1:]:
        q.lineTo(px, 32 - py)
    c.drawPath(q, stroke=1, fill=0)
    c.restoreState()


# ----------------------------------------------------------- Markdown -> flowables
class Titulo(Paragraph):
    """Párrafo de título que avisa al índice (ver Documento.afterFlowable)."""

    _contador = 0

    def __init__(self, texto, estilo, nivel):
        super().__init__(inline(texto), estilo)
        self._nivel_toc = nivel
        Titulo._contador += 1
        self._clave = "h%d" % Titulo._contador


def parsear_meta(lineas):
    meta = {}
    if lineas and lineas[0].strip() == "---":
        for i in range(1, len(lineas)):
            if lineas[i].strip() == "---":
                for ln in lineas[1:i]:
                    if ":" in ln:
                        k, v = ln.split(":", 1)
                        meta[k.strip().lower()] = v.strip().strip('"').strip("'")
                return meta, lineas[i + 1:]
        raise ErrorManual("Los metadatos iniciales no tienen la marca de cierre '---'.")
    return meta, lineas


def celdas_fila(ln):
    ln = ln.strip()
    if ln.startswith("|"):
        ln = ln[1:]
    if ln.endswith("|") and not ln.endswith("\\|"):
        ln = ln[:-1]
    return [c.strip().replace("\\|", "|") for c in re.split(r"(?<!\\)\|", ln)]


def construir_tabla(filas, est):
    ncol = len(filas[0])
    filas = [(f + [""] * ncol)[:ncol] for f in filas]
    # Anchos proporcionales al contenido (raíz de la longitud, con mínimo)
    pesos = []
    for j in range(ncol):
        mx = max(len(texto_plano(f[j])) for f in filas)
        mean = sum(len(texto_plano(f[j])) for f in filas[1:] or filas) / max(1, len(filas[1:] or filas))
        pesos.append(max(6.0, min(mx, 0.5 * mx + 0.5 * mean * 1.5)) ** 0.8)
    total = sum(pesos)
    anchos = [ANCHO_UTIL * p / total for p in pesos]
    # Mínimo por columna: que quepa la palabra más larga sin partirla
    minimos = []
    for j in range(ncol):
        mw = 0
        for i, f in enumerate(filas):
            fuente = "DV-B" if i == 0 else "DV"
            for palabra in texto_plano(f[j]).split():
                mw = max(mw, pdfmetrics.stringWidth(palabra, fuente, 8) + 14)
        minimos.append(mw)
    for _ in range(ncol):
        bajos = [j for j in range(ncol) if anchos[j] < minimos[j]]
        if not bajos:
            break
        falta = sum(minimos[j] - anchos[j] for j in bajos)
        for j in bajos:
            anchos[j] = minimos[j]
        otros = [j for j in range(ncol) if j not in bajos]
        resto = sum(anchos[j] for j in otros)
        for j in otros:
            anchos[j] -= falta * anchos[j] / resto
    datos = []
    for i, f in enumerate(filas):
        estilo = est["celda_cab"] if i == 0 else est["celda"]
        datos.append([Paragraph(inline(c), estilo) for c in f])
    t = Table(datos, colWidths=anchos, repeatRows=1)
    cmds = [
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BOX", (0, 0), (-1, -1), 0.5, BORDE),
        ("INNERGRID", (0, 0), (-1, -1), 0.4, BORDE),
        ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]
    for i in range(2, len(filas), 2):
        cmds.append(("BACKGROUND", (0, i), (-1, i), FILA_ALT))
    t.setStyle(TableStyle(cmds))
    t.spaceAfter = 9
    t.spaceBefore = 3
    return t


def construir_caja(tipo, marcado, est):
    """Caja de aviso; `marcado` ya viene convertido a marcado de Paragraph."""
    fondo, borde = CAJAS[tipo]
    t = Table([[Paragraph(marcado, est["caja"])]], colWidths=[ANCHO_UTIL])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), fondo),
        ("LINEBEFORE", (0, 0), (0, -1), 3, borde),
        ("LEFTPADDING", (0, 0), (-1, -1), 10), ("RIGHTPADDING", (0, 0), (-1, -1), 9),
        ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    t.spaceBefore = 3
    t.spaceAfter = 9
    return t


def construir_codigo(lineas, est):
    ancho_car = int((ANCHO_UTIL - 16) / pdfmetrics.stringWidth("M", "DVM", est["codigo"].fontSize))
    salida = []
    for ln in lineas:
        ln = ln.replace("\t", "    ")
        while len(ln) > ancho_car:
            salida.append(ln[:ancho_car])
            ln = "  " + ln[ancho_car:]
        salida.append(ln)
    pre = XPreformatted(emojis(escape("\n".join(salida))), est["codigo"])
    t = Table([[pre]], colWidths=[ANCHO_UTIL])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), FONDO_CODIGO),
        ("BOX", (0, 0), (-1, -1), 0.5, BORDE),
        ("LEFTPADDING", (0, 0), (-1, -1), 8), ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    t.spaceBefore = 2
    t.spaceAfter = 9
    return t


def cargar_imagen(ruta_rel, dir_base, n_linea, ancho_max, alto_max):
    """Devuelve un Image a tamaño natural (~200 dpi), limitado a ancho_max y alto_max."""
    ruta = os.path.normpath(os.path.join(dir_base, ruta_rel))
    if not os.path.isfile(ruta):
        raise ErrorManual(f"Línea {n_linea}: no se encuentra la imagen '{ruta_rel}' (buscada en {ruta}).")
    iw, ih = ImageReader(ruta).getSize()
    k = min(72.0 / 200.0, ancho_max / iw, alto_max / ih)
    img = Image(ruta, width=iw * k, height=ih * k)
    img.hAlign = "CENTER"
    return img


def numerar_pie(pie, n_fig):
    if not re.match(r"(?i)figura\s+\d+", pie):
        return "Figura %d. %s" % (n_fig, pie) if pie else "Figura %d." % n_fig
    return pie


def construir_figura(grupo, dir_base, n_fig, est):
    """`grupo` es una lista de (pie, ruta, n_linea); varias imágenes seguidas van lado a lado."""
    alto_max = (0.45 if len(grupo) == 1 else 0.6) * (PAG_H - MARGEN_SUP - MARGEN_INF)
    if len(grupo) == 1:
        pie, ruta, nl = grupo[0]
        img = cargar_imagen(ruta, dir_base, nl, ANCHO_UTIL, alto_max)
        img.spaceBefore = 3
        return KeepTogether([img, Paragraph(inline(numerar_pie(pie, n_fig)), est["pie_fig"])])
    sep = 10
    ancho_col = (ANCHO_UTIL - sep * (len(grupo) - 1)) / len(grupo)
    imgs = [cargar_imagen(r, dir_base, nl, ancho_col, alto_max) for _, r, nl in grupo]
    t = Table([imgs], colWidths=[ancho_col] * len(imgs))
    t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                           ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0)]))
    t.spaceBefore = 3
    # Un único pie: el primero, más lo que aporten los siguientes (sin su rótulo "Figura N (continuación).")
    pie = grupo[0][0]
    for p, _, _ in grupo[1:]:
        extra = re.sub(r"(?i)^figura\s+\d+\s*(\([^)]*\))?\.?\s*", "", p)
        if extra:
            pie += " " + extra
    return KeepTogether([t, Paragraph(inline(numerar_pie(pie, n_fig)), est["pie_fig"])])


RE_LISTA = re.compile(r"^(\s*)(-|\*|\+|\d+[.)])\s+(.*)$")
RE_IMG = re.compile(r"^!\[(.*?)\]\((.+?)\)\s*$")
RE_CAJA = re.compile(r"^\*\*(nota|importante|consejo)\s*:?\*\*\s*:?\s*(.*)$", re.I)


def construir_historia(lineas, dir_base, est, desfase=0):
    """Recorre el Markdown línea a línea y devuelve la lista de flowables."""
    h = []
    i, n = 0, len(lineas)
    n_fig = 0
    parrafo = []

    def vaciar():
        if parrafo:
            h.append(Paragraph(inline(" ".join(parrafo)), est["cuerpo"]))
            parrafo.clear()

    while i < n:
        ln = lineas[i].rstrip()
        s = ln.strip()
        if s == "":
            vaciar(); i += 1; continue
        if s.startswith("```"):
            vaciar()
            i += 1
            bloque = []
            while i < n and not lineas[i].strip().startswith("```"):
                bloque.append(lineas[i].rstrip("\n").rstrip())
                i += 1
            if i >= n:
                raise ErrorManual("Bloque de código sin cierre ``` .")
            i += 1
            h.append(construir_codigo(bloque or [""], est))
            continue
        if re.match(r"^<!--\s*pagina\s*-->$", s):
            vaciar()
            if h and not isinstance(h[-1], PageBreak):
                h.append(PageBreak())
            i += 1; continue
        if s.startswith("<!--"):  # otros comentarios: se ignoran
            while i < n and "-->" not in lineas[i]:
                i += 1
            i += 1; continue
        m = re.match(r"^(#{1,3})\s+(.*)$", s)
        if m:
            vaciar()
            nivel, texto = len(m.group(1)), m.group(2).strip()
            if nivel == 1:
                if h and not isinstance(h[-1], PageBreak):  # evita páginas en blanco
                    h.append(PageBreak())
                h.append(Titulo(texto, est["h1"], 0))
            elif nivel == 2:
                h.append(Titulo(texto, est["h2"], 1))
            else:
                h.append(Paragraph(inline(texto), est["h3"]))
            i += 1; continue
        m = RE_IMG.match(s)
        if m:
            vaciar()
            n_fig += 1
            grupo = [(m.group(1), m.group(2), i + 1 + desfase)]
            i += 1
            # Imágenes consecutivas (solo líneas en blanco entre ellas) se agrupan
            while True:
                j = i
                while j < n and lineas[j].strip() == "":
                    j += 1
                mm = RE_IMG.match(lineas[j].strip()) if j < n else None
                if not mm:
                    break
                grupo.append((mm.group(1), mm.group(2), j + 1 + desfase))
                i = j + 1
            h.append(construir_figura(grupo, dir_base, n_fig, est))
            continue
        if s.startswith(">"):
            vaciar()
            cita = []
            while i < n and lineas[i].strip().startswith(">"):
                cita.append(lineas[i].strip()[1:].strip())
                i += 1
            primera = cita[0] if cita else ""
            mc = RE_CAJA.match(primera)
            tipo = mc.group(1).lower() if mc else "nota"
            if mc:
                marcado = "<b>%s:</b> %s" % (mc.group(1).capitalize(), inline(" ".join([mc.group(2)] + cita[1:])))
            else:
                marcado = inline(" ".join(c for c in cita if c))
            caja = construir_caja(tipo, marcado, est)
            h.append(caja)
            continue
        if s.startswith("|") and i + 1 < n and re.match(r"^\s*\|?\s*:?-{2,}", lineas[i + 1]):
            vaciar()
            filas = [celdas_fila(s)]
            i += 2
            while i < n and lineas[i].strip().startswith("|"):
                filas.append(celdas_fila(lineas[i]))
                i += 1
            h.append(construir_tabla(filas, est))
            continue
        m = RE_LISTA.match(ln)
        if m:
            vaciar()
            sangria = len(m.group(1).replace("\t", "    "))
            nivel = 1 if sangria >= 2 else 0
            marca = "•" if m.group(2) in "-*+" else m.group(2)
            if nivel == 1 and marca == "•":
                marca = "–"
            base = 14 + nivel * 14
            estilo = ParagraphStyle("li%d" % nivel, parent=est["lista"], leftIndent=base + 2, bulletIndent=base - 12 + 2)
            if marca[0].isdigit():
                estilo.bulletIndent = base - 14 + 2
            texto = m.group(3)
            i += 1
            # Continuaciones indentadas del mismo ítem
            while i < n and lineas[i].strip() and lineas[i].startswith("  ") and not RE_LISTA.match(lineas[i]):
                texto += " " + lineas[i].strip()
                i += 1
            h.append(Paragraph(inline(texto), estilo, bulletText=marca))
            if i >= n or not RE_LISTA.match(lineas[i]):
                h[-1].style = ParagraphStyle("lif", parent=estilo, spaceAfter=7)
            continue
        parrafo.append(s)
        i += 1
    vaciar()
    return h


def generar(entrada, salida):
    if not os.path.isfile(entrada):
        raise ErrorManual(f"No existe el archivo de entrada: {entrada}")
    registrar_fuentes()
    with open(entrada, encoding="utf-8") as f:
        lineas = f.read().splitlines()
    meta, cuerpo = parsear_meta(lineas)
    meta.setdefault("title", "Manual de usuario y configuración")
    ruta_portada = os.path.join(DIR_MANUAL, "img", "p01-fig-000.jpg")
    if os.path.isfile(ruta_portada):
        meta["portada_img"] = ruta_portada
    else:
        print("Aviso: no se encontró la captura de portada img/p01-fig-000.jpg; se omite.", file=sys.stderr)
    est = crear_estilos()
    historia_cuerpo = construir_historia(cuerpo, os.path.dirname(os.path.abspath(entrada)), est, len(lineas) - len(cuerpo))

    toc = TableOfContents(dotsMinLevel=0)
    toc.levelStyles = [est["toc0"], est["toc1"]]
    historia = [
        NextPageTemplate("normal"), PageBreak(),
        Paragraph("Contenido", est["toc_titulo"]), toc, PageBreak(),
    ] + historia_cuerpo

    os.makedirs(os.path.dirname(os.path.abspath(salida)), exist_ok=True)
    doc = Documento(salida, meta)
    doc.multiBuild(historia)
    return doc.page


def main():
    ap = argparse.ArgumentParser(description="Genera el PDF del manual de Centinela desde Markdown.")
    ap.add_argument("--entrada", default=ENTRADA_DEF, help="Markdown de origen (por defecto docs/manual/manual.md)")
    ap.add_argument("--salida", default=SALIDA_DEF, help="PDF de salida (por defecto docs/Centinela-Manual-de-usuario.pdf)")
    a = ap.parse_args()
    try:
        paginas = generar(a.entrada, a.salida)
    except ErrorManual as exc:
        print("Error: %s" % exc, file=sys.stderr)
        return 1
    print("PDF generado: %s (%d páginas)" % (a.salida, paginas))
    return 0


if __name__ == "__main__":
    sys.exit(main())

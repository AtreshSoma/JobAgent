"""How long a resume is: an estimate that reads the document's own styles,
and a measurement through LibreOffice when it is installed (audit R6).

THE ESTIMATE used to read only a paragraph's direct formatting and its own
style's font size, with constants fitted to one Calibri 11 template. Spacing,
line height and fonts set on a style, on Normal or in the document defaults
were invisible: the python-docx template's 10 pt after every paragraph and
1.15 line spacing, a Georgia 12 resume at 1.15. Measured against LibreOffice it
was up to 0.65 pages short, so a three-page document passed as two.

It now resolves every paragraph's font, size, line spacing, space before and
after (with Word's contextual spacing), indents and list indent through the
paragraph, its style chain, the document defaults and the theme font, and uses
per-font width and line-height factors. The factors are CALIBRATED against
LibreOffice renders of the resume corpus (tests/python/test_pagefit.py records
the fit). It stays the offline fallback and the first guess for the fit.

THE MEASUREMENT converts the document with LibreOffice and counts pages, so the
page fit can check the real file instead of trusting the estimate.
"""
from __future__ import annotations

import os
import subprocess
import tempfile
from functools import lru_cache
from pathlib import Path
from typing import Dict, Optional

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"

# Letter page, in twips (1/1440 inch), used when a document declares no size.
DEFAULT_PAGE = {"width": 12240, "height": 15840, "left": 1440, "right": 1440, "top": 1440, "bottom": 1440}

#: Glyph advances in thousandths of an em: the standard Helvetica metrics, the
#: common shape every proportional font follows closely enough for wrapping.
#: Each font scales them by FONT_WIDTH. Lines are wrapped word by word with
#: these, because "characters / characters per line" missed every break by a
#: line on bullets that sit near one (a 171-character bullet is 2 or 3 lines).
_HELVETICA = {
    " ": 278, "!": 278, '"': 355, "#": 556, "$": 556, "%": 889, "&": 667, "'": 191, "(": 333, ")": 333,
    "*": 389, "+": 584, ",": 278, "-": 333, ".": 278, "/": 278, ":": 278, ";": 278, "<": 584, "=": 584,
    ">": 584, "?": 556, "@": 1015, "[": 278, "]": 278, "_": 556, "|": 260, "–": 556, "—": 1000, "•": 350,
    "A": 667, "B": 667, "C": 722, "D": 722, "E": 667, "F": 611, "G": 778, "H": 722, "I": 278, "J": 500,
    "K": 667, "L": 556, "M": 833, "N": 722, "O": 778, "P": 667, "Q": 778, "R": 722, "S": 667, "T": 611,
    "U": 722, "V": 667, "W": 944, "X": 667, "Y": 667, "Z": 611,
    "a": 556, "b": 556, "c": 500, "d": 556, "e": 556, "f": 278, "g": 556, "h": 556, "i": 222, "j": 222,
    "k": 500, "l": 222, "m": 833, "n": 556, "o": 556, "p": 556, "q": 556, "r": 333, "s": 500, "t": 278,
    "u": 556, "v": 500, "w": 722, "x": 500, "y": 500, "z": 500,
}
_DEFAULT_GLYPH = 556


def _advance(text: str) -> int:
    return sum(_HELVETICA.get(c, 556 if c.isdigit() else _DEFAULT_GLYPH) for c in text)


def wrapped_lines(text: str, width_pt: float, size_pt: float, font: str) -> int:
    """Lines ``text`` takes at ``width_pt``, wrapped at spaces like a word processor."""
    if not text.strip():
        return 1
    scale = size_pt * FONT_WIDTH.get(font, FONT_WIDTH['calibri']) / 1000
    space = _HELVETICA[" "] * scale
    lines, used = 1, 0.0
    for word in text.split():
        w = _advance(word) * scale
        if used and used + space + w > width_pt:
            lines += 1
            used = 0.0
        while w > width_pt:  # a word longer than the line breaks across lines
            lines += 1
            w -= width_pt
        used = w if not used else used + space + w
    return lines


#: Single line height as a multiple of the point size, by font, and each
#: font's glyph width relative to Helvetica. Fitted against LibreOffice 26.8.3
#: on 22 resume variants (2026-11-15; tests/python/pagefit_fixtures.py): Calibri,
#: Cambria and Arial widths and every listed line height. Georgia and Times
#: widths are published ratios (the variants could not pin them); the rest are
#: published ratios too.
DEFAULT_LINE = 1.22
FONT_LINE = {"calibri": 1.22, "carlito": 1.22, "cambria": 1.24, "caladea": 1.24, "aptos": 1.22,
             "georgia": 1.22, "arial": 1.20, "helvetica": 1.20, "liberation sans": 1.20,
             "times new roman": 1.20, "liberation serif": 1.20, "garamond": 1.18, "verdana": 1.21, "tahoma": 1.21}
FONT_WIDTH = {"calibri": 0.81, "carlito": 0.81, "cambria": 0.92, "caladea": 0.92, "aptos": 0.86,
              "georgia": 1.0, "arial": 0.93, "helvetica": 0.93, "liberation sans": 0.93,
              "times new roman": 0.86, "liberation serif": 0.86, "garamond": 0.80, "verdana": 1.10, "tahoma": 0.92}
DEFAULT_SIZE_HALF_POINTS = 20  # Word's built-in default when nothing states one: 10 pt
#: Share of a proportional line spacing above single ("1.15") that takes
#: effect. Fitted at 1.0 (all of it) on the calibration set; kept as a named
#: factor so a recalibration against another renderer can move it.
PROPORTIONAL_EFFECT = 1.0


def _twips(value) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


class _Styles:
    """The document's styles, defaults, theme font and numbering, read once."""

    def __init__(self, document):
        part = document.part
        root = document.styles.element
        self.styles = {s.get(f"{W}styleId"): s for s in root.findall(f"{W}style")}
        self.default_para = next((sid for sid, s in self.styles.items()
                                  if s.get(f"{W}type") == "paragraph" and s.get(f"{W}default") in ("1", "true")), None)
        defaults = root.find(f"{W}docDefaults")
        self.rpr_default = defaults.find(f"{W}rPrDefault/{W}rPr") if defaults is not None else None
        self.ppr_default = defaults.find(f"{W}pPrDefault/{W}pPr") if defaults is not None else None
        self.theme_minor = self._theme_font(part, "minorFont") or "Calibri"
        self.theme_major = self._theme_font(part, "majorFont") or self.theme_minor
        self.numbering = self._numbering(part)

    @staticmethod
    def _theme_font(part, which):
        for rel in part.rels.values():
            if rel.reltype.endswith("/theme"):
                try:
                    from lxml import etree
                    theme = etree.fromstring(rel.target_part.blob)
                except Exception:  # noqa: BLE001
                    return None
                node = theme.find(f".//{A}{which}/{A}latin")
                return node.get("typeface") if node is not None else None
        return None

    @staticmethod
    def _numbering(part):
        """numId -> {ilvl: left indent in twips}."""
        try:
            numbering = part.numbering_part.element
        except Exception:  # noqa: BLE001
            return {}
        abstract = {}
        for node in numbering.findall(f"{W}abstractNum"):
            levels = {}
            for lvl in node.findall(f"{W}lvl"):
                ind = lvl.find(f"{W}pPr/{W}ind")
                if ind is not None:
                    levels[lvl.get(f"{W}ilvl")] = _twips(ind.get(f"{W}left") or ind.get(f"{W}start")) or 0
            abstract[node.get(f"{W}abstractNumId")] = levels
        out = {}
        for num in numbering.findall(f"{W}num"):
            ref = num.find(f"{W}abstractNumId")
            if ref is not None:
                out[num.get(f"{W}numId")] = abstract.get(ref.get(f"{W}val"), {})
        return out

    def chain(self, style_id):
        seen = set()
        while style_id and style_id in self.styles and style_id not in seen:
            seen.add(style_id)
            style = self.styles[style_id]
            yield style
            based = style.find(f"{W}basedOn")
            style_id = based.get(f"{W}val") if based is not None else None


def _first(nodes, path, attr):
    """The first node in ``nodes`` with ``path`` carrying ``attr``, and that value."""
    for node in nodes:
        if node is None:
            continue
        found = node.find(path)
        if found is not None and found.get(attr) is not None:
            return found.get(attr)
    return None


class _Para:
    """One paragraph's resolved layout facts, in twips and points."""

    def __init__(self, paragraph, styles: _Styles):
        ppr = paragraph._p.pPr
        style_el = ppr.find(f"{W}pStyle") if ppr is not None else None
        style_id = style_el.get(f"{W}val") if style_el is not None else styles.default_para
        self.style_id = style_id
        chain = list(styles.chain(style_id))
        if styles.default_para and styles.default_para not in [s.get(f"{W}styleId") for s in chain]:
            chain += list(styles.chain(styles.default_para))
        pprs = [ppr] + [s.find(f"{W}pPr") for s in chain] + [styles.ppr_default]
        rprs_style = [s.find(f"{W}rPr") for s in chain] + [styles.rpr_default]
        run_rprs = [r.find(f"{W}rPr") for r in paragraph._p.iter(f"{W}r")]

        size = _first(run_rprs, f"{W}sz", f"{W}val") or _first(rprs_style, f"{W}sz", f"{W}val")
        self.size_pt = (_twips(size) or DEFAULT_SIZE_HALF_POINTS) / 2
        font = _first(run_rprs, f"{W}rFonts", f"{W}ascii") or _first(rprs_style, f"{W}rFonts", f"{W}ascii")
        if not font:
            theme = _first(run_rprs + rprs_style, f"{W}rFonts", f"{W}asciiTheme") or "minorHAnsi"
            font = styles.theme_major if theme.startswith("major") else styles.theme_minor
        self.font = font.lower()

        self.before = _twips(_first(pprs, f"{W}spacing", f"{W}before")) or 0
        self.after = _twips(_first(pprs, f"{W}spacing", f"{W}after")) or 0
        self.line = _twips(_first(pprs, f"{W}spacing", f"{W}line"))
        self.line_rule = _first(pprs, f"{W}spacing", f"{W}lineRule") or "auto"
        self.contextual = any(p is not None and p.find(f"{W}contextualSpacing") is not None
                              and p.find(f"{W}contextualSpacing").get(f"{W}val") not in ("0", "false")
                              for p in pprs[:-1])
        left = _first(pprs, f"{W}ind", f"{W}left") or _first(pprs, f"{W}ind", f"{W}start")
        right = _first(pprs, f"{W}ind", f"{W}right") or _first(pprs, f"{W}ind", f"{W}end")
        num_id = _first(pprs, f"{W}numPr/{W}numId", f"{W}val")
        ilvl = _first(pprs, f"{W}numPr/{W}ilvl", f"{W}val") or "0"
        numbered_left = styles.numbering.get(num_id, {}).get(ilvl, 0) if num_id and num_id != "0" else 0
        self.indent = max(0, _twips(left) if left is not None else numbered_left) + max(0, _twips(right) or 0)
        self.text = paragraph.text or ""

    def height(self, width: int, *, after: Optional[int] = None, before: Optional[int] = None) -> int:
        key = self.font
        usable_pt = max(self.size_pt * 4, (width - self.indent) / 20)
        lines = wrapped_lines(self.text, usable_pt, self.size_pt, key)
        natural = self.size_pt * 20 * FONT_LINE.get(key, DEFAULT_LINE)
        if self.line_rule == "exact" and self.line:
            line_h = self.line
        elif self.line_rule == "atLeast" and self.line:
            line_h = max(self.line, natural)
        else:
            line_h = natural * (1 + ((self.line or 240) / 240 - 1) * PROPORTIONAL_EFFECT)
        return int(lines * line_h + (self.before if before is None else before) + (self.after if after is None else after))


def page_metrics(document) -> Dict[str, int]:
    section = document.sections[0] if document.sections else None
    metrics = dict(DEFAULT_PAGE)
    if section is not None:
        for key, value in (
            ("width", section.page_width), ("height", section.page_height),
            ("left", section.left_margin), ("right", section.right_margin),
            ("top", section.top_margin), ("bottom", section.bottom_margin),
        ):
            if value is not None:
                metrics[key] = int(value.twips)
    metrics["usable_width"] = max(1, metrics["width"] - metrics["left"] - metrics["right"])
    metrics["usable_height"] = max(1, metrics["height"] - metrics["top"] - metrics["bottom"])
    return metrics


def estimate_page_count(document) -> float:
    """Estimated pages as a float (1.4 means "spills onto a second page")."""
    metrics = page_metrics(document)
    styles = _Styles(document)
    paras = [_Para(p, styles) for p in document.paragraphs]
    total = 0
    for index, para in enumerate(paras):
        after = para.after
        before = para.before
        # Word's "don't add space between paragraphs of the same style".
        nxt = paras[index + 1] if index + 1 < len(paras) else None
        prev = paras[index - 1] if index else None
        if para.contextual and nxt is not None and nxt.style_id == para.style_id:
            after = 0
        if para.contextual and prev is not None and prev.style_id == para.style_id:
            before = 0
        total += para.height(metrics["usable_width"], after=after, before=before)
    for table in document.tables:
        for row in table.rows:
            cells = {id(c._tc): c for c in row.cells}.values()
            width = metrics["usable_width"] // max(1, len(cells))
            total += max((sum(_Para(p, styles).height(width) for p in cell.paragraphs) for cell in cells), default=0)
    return total / metrics["usable_height"]


# ── measurement ─────────────────────────────────────────────────────────────

LIBREOFFICE_MEASURE_TIMEOUT_S = 60


@lru_cache(maxsize=1)
def libreoffice() -> Optional[str]:
    """The LibreOffice binary, or None (the estimate is then the only measure)."""
    from pdfExport import find_soffice
    return find_soffice()


def _profile_url() -> str:
    """One LibreOffice profile per process, kept for its lifetime.

    A fresh profile per conversion made every call pay LibreOffice's first-start
    setup (measured: minutes while the font cache was rebuilt), and one profile
    shared between processes makes a second instance wait on the first. One per
    process is set up once and never contended.
    """
    path = Path(tempfile.gettempdir()) / f"jobagent-libreoffice-{os.getpid()}"
    return path.as_uri()


def measure_pages(docx_path: str | Path, *, timeout: int = LIBREOFFICE_MEASURE_TIMEOUT_S) -> Optional[int]:
    """Pages of ``docx_path`` as LibreOffice lays it out, or None when it cannot say."""
    soffice = libreoffice()
    if not soffice:
        return None
    from pdfExport import pdf_page_count
    docx_path = Path(docx_path)
    with tempfile.TemporaryDirectory(prefix="jobagent-measure-") as out:
        try:
            subprocess.run(  # noqa: S603
                [soffice, f"-env:UserInstallation={_profile_url()}", "--headless", "--norestore",
                 "--convert-to", "pdf", "--outdir", out, str(docx_path)],
                capture_output=True, timeout=timeout, check=False,
            )
        except (subprocess.TimeoutExpired, OSError):
            return None
        produced = Path(out) / (docx_path.stem + ".pdf")
        return pdf_page_count(produced) if produced.exists() else None


def measure_document(document, *, timeout: int = LIBREOFFICE_MEASURE_TIMEOUT_S) -> Optional[int]:
    """Pages of an in-memory python-docx document, via a temporary file."""
    if not libreoffice():
        return None
    with tempfile.TemporaryDirectory(prefix="jobagent-fit-") as scratch:
        path = Path(scratch) / "candidate.docx"
        document.save(str(path))
        return measure_pages(path, timeout=timeout)


def measurement_available() -> bool:
    return libreoffice() is not None

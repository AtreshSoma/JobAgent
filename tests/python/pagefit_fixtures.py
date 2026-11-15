"""Resume variants the page estimate was calibrated on (audit R6).

MEASURED holds LibreOffice 26.8.3's page count for each, as a fraction (how
far down the last page the text reaches), recorded on 2026-11-15 with the
fonts macOS ships (Calibri and Cambria resolve to the metric-compatible
Carlito and Caladea). test_pagefit.py checks the estimate against these
without needing LibreOffice, and re-measures a few when it is installed.
"""
from __future__ import annotations

from docx import Document
from docx.shared import Inches, Pt

BULLET = ("Built and operated data pipelines for finance reporting across twelve business units, "
          "cutting the nightly refresh from six hours to forty minutes and saving 30% of compute.")
SHORT = "Maintained SQL Server reporting for 12 regional teams."


def build_repeat(bullets):
    """The tailor suite's dense resume: one bullet repeated, near a line break."""
    doc = Document()
    for text in ("CANDIDATE NAME", "PROFESSIONAL EXPERIENCE", "Senior Data Engineer", "Acme - Remote - March 2022 - Present"):
        doc.add_paragraph(text)
    for i in range(bullets):
        doc.add_paragraph(f"Delivered a measurable SQL and Python outcome number {i}. " * 3, style="List Bullet")
    return doc


def build(font=None, size=None, spacing=None, after=None, margin=None, bullets=12, short_every=3):
    doc = Document()
    normal = doc.styles["Normal"]
    if font:
        normal.font.name = font
    if size:
        normal.font.size = Pt(size)
    if spacing is not None:
        normal.paragraph_format.line_spacing = spacing
    if after is not None:
        normal.paragraph_format.space_after = Pt(after)
    if margin is not None:
        section = doc.sections[0]
        section.left_margin = section.right_margin = section.top_margin = section.bottom_margin = Inches(margin)
    doc.add_paragraph("Jordan Example")
    doc.add_paragraph("Springfield, IL | 555-010-0000 | jordan@example.com")
    doc.add_paragraph("PROFESSIONAL SUMMARY")
    doc.add_paragraph("Data engineer with ten years building reporting platforms for finance and operations "
                      "teams, from source systems to dashboards.")
    doc.add_paragraph("PROFESSIONAL EXPERIENCE")
    for i in range(bullets):
        if i % 6 == 0:
            doc.add_paragraph(f"Data Engineer | Example Corp {i} | Jan 2019 - Present")
        doc.add_paragraph(SHORT if (short_every and i % short_every == 2) else BULLET, style="List Bullet")
    doc.add_paragraph("EDUCATION")
    doc.add_paragraph("B.S. Computer Science, Example University")
    return doc


VARIANTS = {}
for b in (6, 14, 22, 30, 40):
    VARIANTS[f"default b{b}"] = dict(bullets=b)
for b in (10, 20, 30):
    VARIANTS[f"calibri11 single 0after b{b}"] = dict(font="Calibri", size=11, spacing=1.0, after=0, margin=0.75, bullets=b)
    VARIANTS[f"georgia12 1.15 6after b{b}"] = dict(font="Georgia", size=12, spacing=1.15, after=6, margin=0.8, bullets=b)
    VARIANTS[f"arial10 single 2after b{b}"] = dict(font="Arial", size=10, spacing=1.0, after=2, margin=0.6, bullets=b)
    VARIANTS[f"times12 single 0after b{b}"] = dict(font="Times New Roman", size=12, spacing=1.0, after=0, margin=1.0, bullets=b)

# name -> (fractional pages, whole pages), LibreOffice 26.8.3, 2026-11-15.
MEASURED = {
    "default b6": (0.570, 1), "default b14": (1.021, 2), "default b22": (1.420, 2), "default b30": (1.791, 2),
    "default b40": (2.324, 3),
    "calibri11 single 0after b10": (0.528, 1), "georgia12 1.15 6after b10": (0.736, 1),
    "arial10 single 2after b10": (0.486, 1), "times12 single 0after b10": (0.595, 1),
    "calibri11 single 0after b20": (0.901, 1), "georgia12 1.15 6after b20": (1.274, 2),
    "arial10 single 2after b20": (0.824, 1), "times12 single 0after b20": (1.021, 2),
    "calibri11 single 0after b30": (1.252, 2), "georgia12 1.15 6after b30": (1.710, 2),
    "arial10 single 2after b30": (1.126, 2), "times12 single 0after b30": (1.425, 2),
    "example master": (1.906, 2),
    "repeat b4": (0.435, 1), "repeat b12": (1.069, 2), "repeat b24": (1.920, 2), "repeat b40": (3.069, 4),
}

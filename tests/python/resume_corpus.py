"""A corpus of resume layouts for the tailor (audit 2026-11-14, P2).

Each layout is built at test time with python-docx from fictional content, so
no real resume (and no binary fixture) enters the repository. The layouts are
the ones that broke the tailor in the audit: hyperlinks, typed bullets,
education above experience, tables, text boxes, page headers, other fonts and
other heading words. ``EXPECT`` records what a correct tailor sees in each one,
and ``KNOWN`` names the checks that fail today with the audit ID of the bug.

The tests mark every KNOWN entry as a strict xfail: the suite stays green, and
the moment a fix lands the xfail turns into a failure that says to delete the
entry here. Nothing in this file may describe a real person.
"""
from __future__ import annotations

from pathlib import Path
from typing import Callable, Dict, List

from docx import Document
from docx.opc.constants import RELATIONSHIP_TYPE as RT
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import qn
from docx.shared import Inches, Pt

NAME = "Jordan Example"
EMAIL = "jordan@example.com"
PHONE = "555-010-0000"
CONTACT = f"Springfield, IL | {PHONE} | {EMAIL}"
SUMMARY = ("Data engineer with ten years building reporting platforms for finance and "
           "operations teams, from source systems to dashboards.")
ROLE_1 = "Senior Data Engineer | Example Corp | Jan 2019 - Present"
ROLE_2 = "Data Engineer | Sample LLC | Jun 2015 - Dec 2018"
EDUCATION = "B.S. Computer Science, Example University"
DATED_EDUCATION = "B.S. Computer Science, Example University, 2011 - 2015"
BULLETS_1 = [
    "Built data pipelines in Airflow for finance reporting, cutting refresh time by 40%.",
    "Moved 30 nightly batch jobs to Spark on a shared cluster.",
    "Wrote data quality checks that caught 95% of bad loads before reporting.",
]
BULLETS_2 = [
    "Maintained SQL Server reporting for 12 regional teams.",
    "Documented 40 source systems for the analytics group.",
]


# ── low-level helpers ────────────────────────────────────────────────────────

def add_hyperlink(paragraph, url: str, text: str) -> None:
    """Append a real w:hyperlink run, the way Word stores a clicked link."""
    r_id = paragraph.part.relate_to(url, RT.HYPERLINK, is_external=True)
    link = OxmlElement("w:hyperlink")
    link.set(qn("r:id"), r_id)
    run = OxmlElement("w:r")
    t = OxmlElement("w:t")
    t.text = text
    t.set(qn("xml:space"), "preserve")
    run.append(t)
    link.append(run)
    paragraph._p.append(link)


def add_text_box(paragraph, text: str) -> None:
    """Append a VML text box holding ``text`` (how Word 2007-era boxes are stored)."""
    paragraph._p.append(parse_xml(
        '<w:r xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
        'xmlns:v="urn:schemas-microsoft-com:vml"><w:pict>'
        '<v:shape style="width:300pt;height:60pt"><v:textbox><w:txbxContent>'
        f'<w:p><w:r><w:t xml:space="preserve">{text}</w:t></w:r></w:p>'
        '</w:txbxContent></v:textbox></v:shape></w:pict></w:r>'
    ))


def _bullets(doc, items: List[str], style: str = "List Bullet", prefix: str = "") -> None:
    for item in items:
        if prefix:
            doc.add_paragraph(f"{prefix}{item}")
        else:
            doc.add_paragraph(item, style=style)


def _top(doc, contact: bool = True) -> None:
    doc.add_paragraph(NAME)
    if contact:
        doc.add_paragraph(CONTACT)


def _summary(doc, text: str = SUMMARY, heading: str = "PROFESSIONAL SUMMARY") -> None:
    doc.add_paragraph(heading)
    doc.add_paragraph(text)


def _experience(doc, *, heading: str = "PROFESSIONAL EXPERIENCE", prefix: str = "",
                roles=(ROLE_1, ROLE_2), first=BULLETS_1, second=BULLETS_2) -> None:
    doc.add_paragraph(heading)
    doc.add_paragraph(roles[0])
    _bullets(doc, first, prefix=prefix)
    doc.add_paragraph(roles[1])
    _bullets(doc, second, prefix=prefix)


def _education(doc, line: str = EDUCATION, heading: str = "EDUCATION") -> None:
    doc.add_paragraph(heading)
    doc.add_paragraph(line)


# ── the layouts ──────────────────────────────────────────────────────────────

def baseline(doc):
    _top(doc)
    _summary(doc)
    _experience(doc)
    _education(doc)


def hyperlinked_email(doc):
    doc.add_paragraph(NAME)
    contact = doc.add_paragraph(f"Springfield, IL | {PHONE} | ")
    add_hyperlink(contact, f"mailto:{EMAIL}", EMAIL)
    _summary(doc)
    _experience(doc)
    _education(doc)


def hyperlinked_profile_line(doc):
    _top(doc)
    links = doc.add_paragraph("LinkedIn: ")
    add_hyperlink(links, "https://www.linkedin.com/in/jordan-example-fictional/", "linkedin.com/in/jordan-example-fictional")
    _summary(doc)
    _experience(doc)
    _education(doc)


def education_first(doc):
    _top(doc)
    _summary(doc)
    _education(doc, line=DATED_EDUCATION)
    _experience(doc)


def dated_education_last(doc):
    _top(doc)
    _summary(doc)
    _experience(doc)
    _education(doc, line=DATED_EDUCATION)


def dash_bullets(doc):
    _top(doc)
    _summary(doc)
    _experience(doc, prefix="- ")
    _education(doc)


def dash_bullet_with_date(doc):
    _top(doc)
    _summary(doc)
    _experience(doc, first=[*BULLETS_1[:2], "Led the March 2021 migration to Airflow."])
    # Replace the list-style bullets of role 1 with typed "- " ones.
    for paragraph in doc.paragraphs:
        if paragraph.text.startswith("Led the March 2021"):
            paragraph.style = doc.styles["Normal"]
            paragraph.runs[0].text = "- " + paragraph.runs[0].text
    _education(doc)


def other_typed_glyphs(doc):
    _top(doc)
    _summary(doc)
    doc.add_paragraph("PROFESSIONAL EXPERIENCE")
    doc.add_paragraph(ROLE_1)
    for glyph, text in zip(["– ", "* ", "● "], BULLETS_1):
        doc.add_paragraph(glyph + text)
    doc.add_paragraph(ROLE_2)
    for glyph, text in zip(["■ ", "➢ "], BULLETS_2):
        doc.add_paragraph(glyph + text)
    _education(doc)


def supported_typed_glyph(doc):
    _top(doc)
    _summary(doc)
    _experience(doc, prefix="• ")
    _education(doc)


def skills_table(doc):
    _top(doc)
    _summary(doc)
    doc.add_paragraph("CORE COMPETENCIES")
    table = doc.add_table(rows=2, cols=2)
    table.cell(0, 0).text = "Platforms"
    table.cell(0, 1).text = "SQL Server, Spark, Airflow, Snowflake"
    table.cell(1, 0).text = "Languages"
    table.cell(1, 1).text = "Python, SQL, Scala"
    _experience(doc)
    _education(doc)


def role_rows_in_table(doc):
    _top(doc)
    _summary(doc)
    doc.add_paragraph("PROFESSIONAL EXPERIENCE")
    for role, bullets in ((ROLE_1, BULLETS_1), (ROLE_2, BULLETS_2)):
        title, company, dates = [part.strip() for part in role.split("|")]
        table = doc.add_table(rows=1, cols=2)
        table.cell(0, 0).text = f"{title} | {company}"
        table.cell(0, 1).text = dates
        _bullets(doc, bullets)
    _education(doc)


def table_cell_text_and_link(doc):
    _top(doc)
    _summary(doc)
    _experience(doc)
    doc.add_paragraph("ADDITIONAL INFORMATION")
    table = doc.add_table(rows=1, cols=2)
    table.cell(0, 0).text = "Links"
    cell = table.cell(0, 1).paragraphs[0]
    cell.add_run("Portfolio: ")
    add_hyperlink(cell, "https://example.com/portfolio", "example.com/portfolio")
    _education(doc)


def contact_in_header(doc):
    header = doc.sections[0].header.paragraphs[0]
    header.text = f"{NAME} | {CONTACT}"
    _summary(doc)
    _experience(doc)
    _education(doc)


def text_box_summary(doc):
    _top(doc)
    doc.add_paragraph("PROFESSIONAL SUMMARY")
    add_text_box(doc.add_paragraph(), SUMMARY)
    _experience(doc)
    _education(doc)


def other_heading_words(doc):
    _top(doc)
    _summary(doc, heading="ABOUT ME")
    _experience(doc, heading="CAREER HISTORY")
    _education(doc, heading="ACADEMIC BACKGROUND")


def combined_heading(doc):
    _top(doc)
    _summary(doc)
    _experience(doc)
    _education(doc, heading="EDUCATION & CERTIFICATIONS")


def abbreviated_dates(doc):
    _top(doc)
    _summary(doc)
    _experience(doc, roles=("Senior Data Engineer | Example Corp | Jan 2019 – Present",
                            "Data Engineer | Sample LLC | Jun 2015 – Dec 2018"))
    _education(doc)


def numeric_dates(doc):
    _top(doc)
    _summary(doc)
    _experience(doc, roles=("Senior Data Engineer | Example Corp | 01/2019 - Present",
                            "Data Engineer | Sample LLC | 06/2015 - 12/2018"))
    _education(doc)


def georgia_spaced(doc):
    normal = doc.styles["Normal"]
    normal.font.name = "Georgia"
    normal.font.size = Pt(12)
    normal.paragraph_format.line_spacing = 1.15
    normal.paragraph_format.space_after = Pt(6)
    section = doc.sections[0]
    section.left_margin = section.right_margin = Inches(0.8)
    baseline(doc)


def link_in_bullet(doc):
    _top(doc)
    _summary(doc)
    doc.add_paragraph("PROFESSIONAL EXPERIENCE")
    doc.add_paragraph(ROLE_1)
    bullet = doc.add_paragraph(style="List Bullet")
    bullet.add_run("Published the pipeline design at ")
    add_hyperlink(bullet, "https://example.com/post", "example.com/post")
    _bullets(doc, BULLETS_1[1:])
    doc.add_paragraph(ROLE_2)
    _bullets(doc, BULLETS_2)
    _education(doc)


def everyday_words(doc):
    _top(doc)
    _summary(doc, text=("Owned the go-live of three platforms and partnered with R&D. "
                        "I excel at turning messy sources into reliable reporting."))
    _experience(doc)
    _education(doc)


def plural_terms(doc):
    _top(doc)
    _summary(doc)
    _experience(doc, first=["Built data pipelines for finance reporting, cutting refresh time by 40%.", *BULLETS_1[1:]])
    _education(doc)


LAYOUTS: Dict[str, Callable] = {
    fn.__name__: fn for fn in (
        baseline, hyperlinked_email, hyperlinked_profile_line, education_first, dated_education_last, dash_bullets,
        dash_bullet_with_date, other_typed_glyphs, supported_typed_glyph, skills_table,
        role_rows_in_table, table_cell_text_and_link, contact_in_header, text_box_summary,
        other_heading_words, combined_heading, abbreviated_dates, numeric_dates, georgia_spaced,
        link_in_bullet, everyday_words, plural_terms,
    )
}

# What a correct tailor reads in each layout: the role headings (in order) and
# how many bullets sit under roles. Layouts not listed use the default.
DEFAULT_ROLES = [ROLE_1, ROLE_2]
DEFAULT_BULLETS = len(BULLETS_1) + len(BULLETS_2)
EXPECT: Dict[str, Dict] = {
    "abbreviated_dates": {"roles": ["Senior Data Engineer | Example Corp | Jan 2019 – Present",
                                    "Data Engineer | Sample LLC | Jun 2015 – Dec 2018"]},
    "numeric_dates": {"roles": ["Senior Data Engineer | Example Corp | 01/2019 - Present",
                                "Data Engineer | Sample LLC | 06/2015 - 12/2018"]},
    # Role lines live in table cells; tables are not body paragraphs.
    "role_rows_in_table": {"roles": None},
    "dash_bullet_with_date": {"bullets": DEFAULT_BULLETS},
}

# Checks that fail today, by audit ID. Remove an entry when its fix lands.
KNOWN: Dict[tuple, str] = {
}


def build(name: str, directory: Path) -> Path:
    """Write layout ``name`` to ``directory`` and return its path."""
    doc = Document()
    LAYOUTS[name](doc)
    path = Path(directory) / f"{name}.docx"
    doc.save(str(path))
    return path


def visible_texts(path: Path) -> List[str]:
    """Every line a reader sees: body, tables, page headers/footers, text boxes."""
    document = Document(str(path))
    texts = [p.text for p in document.paragraphs]
    for table in document.tables:
        for row in table.rows:
            for cell in row.cells:
                texts.extend(p.text for p in cell.paragraphs)
    for section in document.sections:
        for part in (section.header, section.footer):
            if not part.is_linked_to_previous:
                texts.extend(p.text for p in part.paragraphs)
    for node in document.element.body.iter(qn("w:txbxContent")):
        texts.extend("".join(t.text or "" for t in p.iter(qn("w:t"))) for p in node.iter(qn("w:p")))
    return [" ".join(t.split()) for t in texts if t and t.strip()]

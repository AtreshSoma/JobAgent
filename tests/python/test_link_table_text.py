"""Link, header and table text (audit R1, R10, R16/N3, N4, N8, N9).

One cause behind all of them: code that read a paragraph through
``paragraph.runs``, which in python-docx 1.2 leaves out runs inside a
``w:hyperlink``, and a PDF renderer that read body paragraphs only, so page
headers and tables were invisible to it and to its own completeness check.
The corpus (test_resume_corpus.py) pins the text-level failures; these pin the
specifics a corpus check cannot see.
"""
from __future__ import annotations

from docx import Document
from docx.enum.text import WD_TAB_ALIGNMENT
from docx.oxml.ns import qn

import resume_corpus as corpus
import tailor

JOB = {"company": "Example Co", "title": "Data Engineer",
       "jd_text": "Required: Airflow, Spark, SQL, data quality and reporting."}
KEYWORDS = ["airflow", "spark", "sql", "data quality", "reporting"]


def _tailor(name, tmp_path, **kwargs):
    master = corpus.build(name, tmp_path)
    return master, tailor.tailor_resume(master, tmp_path / "out", JOB, KEYWORDS, {}, **kwargs)


# ── the PDF rendering (docx_to_html) ─────────────────────────────────────────

def test_a_linked_email_is_on_the_page_and_still_a_link(tmp_path):
    rendering = tailor.docx_to_html(corpus.build("hyperlinked_email", tmp_path))
    assert corpus.EMAIL in rendering["html"]
    assert f'<a href="mailto:{corpus.EMAIL}">{corpus.EMAIL}</a>' in rendering["html"]


def test_only_web_and_mail_links_become_links(tmp_path):
    doc = Document()
    paragraph = doc.add_paragraph("See ")
    corpus.add_hyperlink(paragraph, "javascript:alert(1)", "this")
    path = tmp_path / "odd_link.docx"
    doc.save(str(path))
    html = tailor.docx_to_html(path)["html"]
    assert "this" in html
    assert "javascript:" not in html


def test_page_header_text_is_printed_first(tmp_path):
    rendering = tailor.docx_to_html(corpus.build("contact_in_header", tmp_path))
    body = rendering["html"].split("<body>", 1)[1]
    assert body.index(corpus.EMAIL) < body.index("PROFESSIONAL SUMMARY")
    assert any(corpus.EMAIL in text for text in rendering["texts"])


def test_a_table_row_prints_its_cells_with_a_space_between(tmp_path):
    rendering = tailor.docx_to_html(corpus.build("skills_table", tmp_path))
    assert "SQL Server, Spark, Airflow, Snowflake" in rendering["texts"]
    # Cells are separate words to a reader and to text extraction, not "PlatformsSQL".
    assert "PlatformsSQL" not in rendering["html"].replace("</span>", "").replace('<span class="cell">', "")


def test_typed_bullet_glyph_is_the_list_marker_not_text(tmp_path):
    rendering = tailor.docx_to_html(corpus.build("supported_typed_glyph", tmp_path))
    assert f"<li>{corpus.BULLETS_1[0]}</li>" in rendering["html"]
    assert corpus.BULLETS_1[0] in rendering["texts"]
    assert not any(text.startswith("• ") for text in rendering["texts"])


# ── table flattening (R10) ───────────────────────────────────────────────────

def test_a_cell_mixing_text_and_a_link_is_flattened_with_the_link_kept(tmp_path):
    _master, result = _tailor("table_cell_text_and_link", tmp_path)
    out = Document(result["output_path"])
    row = next(p for p in out.paragraphs if p.text.startswith("Links"))
    assert "Portfolio: example.com/portfolio" in row.text
    links = row._p.findall(qn("w:hyperlink"))
    assert len(links) == 1
    assert out.part.rels[links[0].get(qn("r:id"))].target_ref == "https://example.com/portfolio"


def test_a_two_cell_row_keeps_its_right_aligned_dates(tmp_path):
    _master, result = _tailor("role_rows_in_table", tmp_path)
    out = Document(result["output_path"])
    row = next(p for p in out.paragraphs if p.text.startswith("Senior Data Engineer | Example Corp"))
    assert row.text == "Senior Data Engineer | Example Corp\tJan 2019 - Present"
    stops = list(row.paragraph_format.tab_stops)
    assert len(stops) == 1 and stops[0].alignment == WD_TAB_ALIGNMENT.RIGHT
    section = out.sections[0]
    assert stops[0].position == section.page_width - section.left_margin - section.right_margin


# ── accepted rewrites on a line with a link (R16/N3) ─────────────────────────

def test_a_rewrite_of_a_linked_bullet_says_the_link_is_not_kept(tmp_path):
    master = corpus.build("link_in_bullet", tmp_path)
    original = next(p.text for p in Document(str(master)).paragraphs if p.text.startswith("Published"))
    rewrite = "Published the Airflow pipeline design for the analytics group."
    result = tailor.tailor_resume(master, tmp_path / "out", JOB, KEYWORDS, {},
                                  accepted_rewrites=[{"original": original, "rewrite": rewrite}])
    texts = [p.text for p in Document(result["output_path"]).paragraphs]
    assert rewrite in texts
    assert not any("example.com/post" in t for t in texts)
    change = next(c for c in result["changes"] if c["type"] == "rewrite")
    assert change["after"] == rewrite
    assert "example.com/post" in change["formatting_note"]


# ── skills lines that hold a link (R16, the rest of it) ──────────────────────

def _skills_master(tmp_path, build):
    doc = Document()
    doc.add_paragraph("CORE COMPETENCIES")
    build(doc)
    doc.add_paragraph("PROFESSIONAL EXPERIENCE")
    doc.add_paragraph(corpus.ROLE_1)
    doc.add_paragraph("Moved batch jobs to Snowflake.", style="List Bullet")
    path = tmp_path / "skills_link.docx"
    doc.save(str(path))
    return path


def test_a_skills_line_with_a_link_keeps_the_link_and_needs_no_rollback(tmp_path):
    # The link comes before the list, and the list sits in one run: positions
    # measured on the line's text (link included) must not be used on runs
    # that leave the link out.
    def build(doc):
        line = doc.add_paragraph()
        corpus.add_hyperlink(line, "https://example.com/tools", "Data")
        line.add_run(" Tools: SQL, Airflow, Snowflake")

    master = _skills_master(tmp_path, build)
    result = tailor.tailor_resume(master, tmp_path / "out", JOB, ["snowflake"], {})
    assert result["skipped_steps"] == []
    out = Document(result["output_path"])
    line = next(p for p in out.paragraphs if p.text.startswith("Data Tools:"))
    assert line.text == "Data Tools: Snowflake, SQL, Airflow"
    assert len(line._p.findall(qn("w:hyperlink"))) == 1


def test_a_skills_table_cell_with_a_link_is_left_as_it_is(tmp_path):
    def build(doc):
        table = doc.add_table(rows=1, cols=2)
        table.cell(0, 0).text = "Tools"
        cell = table.cell(0, 1).paragraphs[0]
        corpus.add_hyperlink(cell, "https://example.com/dash", "Tableau")
        cell.add_run(", SQL, Snowflake")

    master = _skills_master(tmp_path, build)
    result = tailor.tailor_resume(master, tmp_path / "out", JOB, ["snowflake"], {})
    assert result["skipped_steps"] == []
    assert not any(c["type"] == "reorder_skills" for c in result["changes"])
    row = next(p for p in Document(result["output_path"]).paragraphs if p.text.startswith("Tools"))
    assert "Tableau, SQL, Snowflake" in row.text
    assert len(row._p.findall(qn("w:hyperlink"))) == 1


# ── text boxes (R15) ─────────────────────────────────────────────────────────

def test_a_text_box_is_printed_where_it_sits_and_only_once(tmp_path):
    """Word stores a text box twice (a drawing and a VML fallback); print it once."""
    from docx.oxml import parse_xml

    doc = Document()
    doc.add_paragraph("PROFESSIONAL SUMMARY")
    anchor = doc.add_paragraph()
    box = ('<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:r>'
           '<w:t>Data engineer who ships reliable reporting.</w:t></w:r></w:p>')
    anchor._p.append(parse_xml(
        '<w:r xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
        'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '
        'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" '
        'xmlns:v="urn:schemas-microsoft-com:vml"><mc:AlternateContent>'
        f'<mc:Choice Requires="wps"><w:drawing><wps:txbx><w:txbxContent>{box}</w:txbxContent></wps:txbx></w:drawing></mc:Choice>'
        f'<mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent>{box}</w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback>'
        '</mc:AlternateContent></w:r>'))
    doc.add_paragraph("PROFESSIONAL EXPERIENCE")
    path = tmp_path / "box.docx"
    doc.save(str(path))
    rendering = tailor.docx_to_html(path)
    body = rendering["html"].split("<body>", 1)[1]
    assert body.count("Data engineer who ships reliable reporting.") == 1
    assert body.index("PROFESSIONAL SUMMARY") < body.index("Data engineer who ships") < body.index("PROFESSIONAL EXPERIENCE")
    assert "Data engineer who ships reliable reporting." in rendering["texts"]

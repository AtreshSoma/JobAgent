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

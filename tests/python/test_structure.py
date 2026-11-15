"""Resume structure: roles only in experience, typed bullets are bullets (audit R4, R5).

The corpus (test_resume_corpus.py) pins what each layout reads as roles and
bullets. These pin what that reading decides: the page fit's never-drop rule
protects the CURRENT ROLE's required evidence, which was an education line
when education came first (R4), and an omitted bullet names its real role,
not a typed bullet that happened to mention a date (R5).
"""
from __future__ import annotations

from docx import Document

import resume_corpus as corpus
import tailor

JOB = {"company": "Example Co", "title": "Data Engineer",
       "jd_text": "Required qualifications: Airflow, Spark and data quality. Preferred: SQL Server."}
KEYWORDS = ["airflow", "spark", "data quality", "sql server"]


FILLER = [
    "Attended weekly planning meetings with the analytics group.",
    "Kept the team wiki current for new starters.",
    "Reviewed pull requests for the reporting repository.",
]


def _fit(tmp_path, *, education_first=False, typed_dated_bullet=False):
    """A resume long enough that the page fit must leave bullets out."""
    doc = Document()
    doc.add_paragraph(corpus.NAME)
    if education_first:
        doc.add_paragraph("EDUCATION")
        doc.add_paragraph(corpus.DATED_EDUCATION)
    doc.add_paragraph("PROFESSIONAL EXPERIENCE")
    doc.add_paragraph(corpus.ROLE_1)
    for text in corpus.BULLETS_1 + FILLER:
        doc.add_paragraph(text, style="List Bullet")
    if typed_dated_bullet:
        doc.add_paragraph("- Led the March 2021 migration to Airflow.")
    doc.add_paragraph(corpus.ROLE_2)
    for text in corpus.BULLETS_2 + FILLER:
        doc.add_paragraph(text, style="List Bullet")
    path = tmp_path / "long.docx"
    doc.save(str(path))
    result = tailor.tailor_resume(path, tmp_path / "out", JOB, KEYWORDS, {}, max_pages=0.2)
    fit = next(c for c in result["changes"] if c["type"] == "fit_to_page_budget")
    return result, fit["evidence"][0]


def test_education_above_experience_is_not_the_current_role(tmp_path):
    result, fit = _fit(tmp_path, education_first=True)
    assert fit["roles_kept"] == 2
    assert fit["omitted"]
    texts = [p.text for p in Document(result["output_path"]).paragraphs]
    # The current role's bullets evidencing a REQUIRED term are never omitted.
    for bullet in corpus.BULLETS_1:
        assert bullet in texts
    assert {o["role"] for o in fit["omitted"]} <= {corpus.ROLE_1, corpus.ROLE_2}


def test_an_omitted_bullet_names_its_real_role(tmp_path):
    _result, fit = _fit(tmp_path, typed_dated_bullet=True)
    assert fit["roles_kept"] == 2
    assert fit["omitted"]
    assert {o["role"] for o in fit["omitted"]} <= {corpus.ROLE_1, corpus.ROLE_2}


def test_typed_dash_bullets_are_reordered_like_list_bullets(tmp_path):
    master = corpus.build("dash_bullets", tmp_path)
    result = tailor.tailor_resume(master, tmp_path / "out", JOB, ["data quality"], {})
    assert any(c["type"] == "reorder_experience_bullets" for c in result["changes"])


def test_typed_glyphs_print_as_list_items_without_the_glyph(tmp_path):
    html = tailor.docx_to_html(corpus.build("other_typed_glyphs", tmp_path))["html"]
    for text in corpus.BULLETS_1 + corpus.BULLETS_2:
        assert f"<li>{text}</li>" in html


def test_a_negative_number_or_a_hyphenated_word_is_not_a_bullet(tmp_path):
    doc = Document()
    for line in ("-5% churn year over year", "—", "*Required", "Well-known for reliability"):
        doc.add_paragraph(line)
    path = tmp_path / "not_bullets.docx"
    doc.save(str(path))
    assert [u["kind"] for u in tailor.master_units(path)] == ["paragraph"] * 4


def test_dated_lines_outside_experience_are_not_roles(tmp_path):
    doc = Document()
    for line in ("PROFESSIONAL EXPERIENCE", corpus.ROLE_1, "CERTIFICATIONS",
                 "AWS Certified Data Engineer, Jan 2023", "EDUCATION & CERTIFICATIONS", corpus.DATED_EDUCATION):
        doc.add_paragraph(line)
    path = tmp_path / "dated_elsewhere.docx"
    doc.save(str(path))
    roles = [u["text"] for u in tailor.master_units(path) if u["kind"] == "role"]
    assert roles == [corpus.ROLE_1]


def test_without_any_section_headings_dated_lines_are_still_roles(tmp_path):
    doc = Document()
    for line in (corpus.ROLE_1, *corpus.BULLETS_1):
        doc.add_paragraph(line)
    path = tmp_path / "no_headings.docx"
    doc.save(str(path))
    assert [u["kind"] for u in tailor.master_units(path)][0] == "role"

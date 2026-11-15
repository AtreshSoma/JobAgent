"""The resume corpus (audit 2026-11-14, P2): every layout through the tailor.

Layouts and the known failures live in resume_corpus.py. A check listed in
KNOWN is a strict xfail carrying its audit ID: it must fail today, and when
the fix lands it starts passing, which fails the suite until the KNOWN entry
is deleted. So the list of open bugs here can never silently go stale.
"""
from __future__ import annotations

import html as html_lib
import re

import pytest
from docx import Document

import resume_corpus as corpus
import tailor

JOB = {
    "company": "Example Co",
    "title": "Data Engineer",
    "jd_text": ("Required qualifications: building a data pipeline in Airflow and Spark, SQL, "
                "data quality checks, and reporting for finance."),
}
KEYWORDS = ["airflow", "spark", "sql", "data pipeline", "data quality", "reporting"]

CHECKS = (
    "structure", "tailors", "pdf_text_complete", "master_pdf_text_complete", "pdf_written",
    "no_everyday_word_matches", "plurals_match", "experience_reordered", "rewrite_exact",
    "estimate_sees_style", "emphasis_skips_headings",
)


def cases(check: str, layouts=None):
    """One pytest param per layout, marked strict-xfail when KNOWN says so."""
    params = []
    for name in layouts or corpus.LAYOUTS:
        reason = corpus.KNOWN.get((name, check))
        marks = [pytest.mark.xfail(strict=True, reason=reason)] if reason else []
        params.append(pytest.param(name, marks=marks, id=name))
    return params


def squash(text: str) -> str:
    return " ".join(str(text or "").split()).lower()


def html_text(html: str) -> str:
    """The page's text the way a browser reads it: blocks apart, inline tags joined."""
    blocks = re.sub(r"</?(?:p|li|ul|h[1-6]|body|div)\b[^>]*>", " ", html)
    return squash(html_lib.unescape(re.sub(r"<[^>]+>", "", blocks)))


# A typed bullet glyph may become the list marker, which is not page text.
LEADING_GLYPH = re.compile(r"^[•·▪◦\-–*●■➢]\s+")


def missing_lines(path, rendered):
    return [t for t in corpus.visible_texts(path) if squash(LEADING_GLYPH.sub("", t)) not in rendered]


def tailored(name, tmp_path, **kwargs):
    master = corpus.build(name, tmp_path)
    result = tailor.tailor_resume(master, tmp_path / "out", JOB, kwargs.pop("keywords", KEYWORDS), {}, **kwargs)
    return master, result


def test_known_failures_name_real_layouts_and_checks():
    for (name, check), reason in corpus.KNOWN.items():
        assert name in corpus.LAYOUTS, f"KNOWN names an unknown layout {name!r}"
        assert check in CHECKS, f"KNOWN names an unknown check {check!r}"
        assert re.match(r"^[RADPXN]\d+", reason), f"KNOWN reason must start with an audit ID: {reason!r}"


def test_corpus_has_enough_layouts():
    assert 15 <= len(corpus.LAYOUTS) <= 25


@pytest.mark.parametrize("name", cases("structure"))
def test_structure(name, tmp_path):
    """Roles are the employment lines, bullets are the bullets, nothing else."""
    expect = corpus.EXPECT.get(name, {})
    units = tailor.master_units(corpus.build(name, tmp_path))
    roles = [u["text"] for u in units if u["kind"] == "role"]
    bullets = [u for u in units if u["kind"] == "bullet"]
    expected_roles = expect.get("roles", corpus.DEFAULT_ROLES)
    if expected_roles is not None:
        assert roles == expected_roles
    assert len(bullets) == expect.get("bullets", corpus.DEFAULT_BULLETS)


@pytest.mark.parametrize("name", cases("tailors"))
def test_tailors(name, tmp_path):
    _master, result = tailored(name, tmp_path)
    assert result["output_path"]


@pytest.mark.parametrize("name", cases("pdf_text_complete"))
def test_pdf_text_complete(name, tmp_path):
    """The PDF printed from the tailored resume holds every line a reader sees."""
    _master, result = tailored(name, tmp_path)
    rendered = html_text(tailor.docx_to_html(result["output_path"])["html"])
    assert missing_lines(result["output_path"], rendered) == []


@pytest.mark.parametrize("name", cases("master_pdf_text_complete"))
def test_master_pdf_text_complete(name, tmp_path):
    """The same for the untailored master, which is what a job falls back to."""
    master = corpus.build(name, tmp_path)
    rendered = html_text(tailor.docx_to_html(master)["html"])
    assert missing_lines(master, rendered) == []


@pytest.mark.parametrize("name", cases("pdf_written"))
def test_pdf_written(name, tmp_path):
    """Chromium's own completeness check (chromiumPdf.js) lets the PDF be written.

    It refuses when a paragraph text from docx_to_html is missing from the page.
    """
    rendering = tailor.docx_to_html(corpus.build(name, tmp_path))
    rendered = html_text(rendering["html"])
    assert [t for t in rendering["texts"] if squash(t) not in rendered] == []


@pytest.mark.parametrize("name", cases("no_everyday_word_matches", ["baseline", "everyday_words"]))
def test_no_everyday_word_matches(name, tmp_path):
    _master, result = tailored(name, tmp_path, keywords=["go", "r", "excel", "airflow"])
    assert result["audit"]["present"] == ["airflow"]


@pytest.mark.parametrize("name", cases("plurals_match", ["plural_terms"]))
def test_plurals_match(name, tmp_path):
    _master, result = tailored(name, tmp_path)
    assert "data pipeline" in result["audit"]["present"]


@pytest.mark.parametrize("name", cases("experience_reordered", ["baseline", "other_heading_words"]))
def test_experience_reordered(name, tmp_path):
    """A required term in a later bullet moves that bullet up, whatever the heading is called."""
    _master, result = tailored(name, tmp_path, keywords=["data quality"])
    assert any(c["type"] == "reorder_experience_bullets" for c in result["changes"])


@pytest.mark.parametrize("name", cases("rewrite_exact", ["baseline", "link_in_bullet"]))
def test_rewrite_exact(name, tmp_path):
    """An accepted rewrite replaces the bullet's text exactly, and nothing else is left in it."""
    master = corpus.build(name, tmp_path)
    original = next(p.text for p in Document(str(master)).paragraphs if p.style.name == "List Bullet")
    rewrite = "Designed the finance reporting pipeline and shared its design with the team."
    result = tailor.tailor_resume(master, tmp_path / "out", JOB, KEYWORDS, {},
                                  accepted_rewrites=[{"original": original, "rewrite": rewrite}])
    texts = [p.text for p in Document(result["output_path"]).paragraphs]
    assert rewrite in texts


# LibreOffice 26.8.3's length for these layouts, in pages (2026-11-15). The
# check used to be "Georgia 12 at 1.15 runs 25% longer than the baseline", but
# the baseline is the python-docx default (Cambria 11, 1.15, 10 pt after, 1.25 in
# margins) and LibreOffice renders the Georgia layout SHORTER (0.467 vs 0.509).
RENDERED_PAGES = {"baseline": 0.509, "georgia_spaced": 0.467}


@pytest.mark.parametrize("name", cases("estimate_sees_style", ["baseline", "georgia_spaced"]))
def test_estimate_sees_style(name, tmp_path):
    """The estimate reads fonts and spacing set on styles and defaults (R6)."""
    estimate = tailor.estimate_page_count(Document(str(corpus.build(name, tmp_path))))
    assert abs(estimate - RENDERED_PAGES[name]) <= 0.1


@pytest.mark.parametrize("name", cases("emphasis_skips_headings", ["baseline"]))
def test_emphasis_skips_headings(name, tmp_path):
    """Bold goes on the summary, skills and bullets, never on a role line or heading."""
    _master, result = tailored(name, tmp_path, keywords=["senior data engineer", "airflow"])
    emphasis = next((c for c in result["changes"] if c["type"] == "emphasize"), {"evidence": []})
    places = [e["resume_text"] for e in emphasis["evidence"]]
    assert places and not any(p in (corpus.ROLE_1, corpus.ROLE_2) for p in places)

"""One failed step is rolled back alone (audit R11).

Any RuntimeError in tailor_resume used to throw the whole tailoring away, and
the job got the untailored master with a warning. Now a step whose result
fails a check is skipped, tailoring is rebuilt from the master without it,
and the review lists it. The truth invariants are unchanged and still run on
the final document; a failure nobody can attribute to an optional step still
fails closed.
"""
from __future__ import annotations

from collections import Counter

import pytest
from docx import Document

import tailor

JOB = {"company": "Example Co", "title": "Data Engineer",
       "jd_text": "Required: Airflow, Spark and data quality. Preferred: SQL."}
KEYWORDS = ["airflow", "spark", "data quality", "sql"]


@pytest.fixture()
def master(tmp_path):
    doc = Document()
    for text in ("Jordan Example", "PROFESSIONAL SUMMARY",
                 "Data engineer building reporting platforms with SQL and Spark.",
                 "CORE COMPETENCIES", "Data Platforms:  SQL, Airflow, Spark",
                 "PROFESSIONAL EXPERIENCE", "Senior Data Engineer | Example Corp | Jan 2019 - Present"):
        doc.add_paragraph(text)
    for text in ("Maintained the team wiki.", "Moved 30 batch jobs to Spark.",
                 "Wrote data quality checks for every load."):
        doc.add_paragraph(text, style="List Bullet")
    path = tmp_path / "master.docx"
    doc.save(str(path))
    return path


def _texts(path):
    return Counter(p.text for p in Document(str(path)).paragraphs if p.text.strip())


def _bullets(path):
    return sorted(p.text for p in Document(str(path)).paragraphs if p.style.name == "List Bullet")


def _run(master, tmp_path):
    return tailor.tailor_resume(master, tmp_path / "out", JOB, KEYWORDS, {})


def test_nothing_fails_nothing_is_skipped(master, tmp_path):
    result = _run(master, tmp_path)
    assert result["skipped_steps"] == []
    assert not any(c["type"] == "step_skipped" for c in result["changes"])


def test_a_step_that_raises_is_skipped_and_the_rest_is_kept(master, tmp_path, monkeypatch):
    def boom(*_args, **_kwargs):
        raise RuntimeError("competency list could not be split")

    monkeypatch.setattr(tailor, "_reorder_competency_paragraphs", boom)
    result = _run(master, tmp_path)
    assert [s["step"] for s in result["skipped_steps"]] == ["competency_lines"]
    assert "could not be split" in result["skipped_steps"][0]["reason"]
    types = {c["type"] for c in result["changes"]}
    assert {"reorder_experience_bullets", "emphasize", "step_skipped"} <= types
    skipped = next(c for c in result["changes"] if c["type"] == "step_skipped")
    assert skipped["before"] and skipped["after"] and skipped["evidence"] and skipped["reason"]
    assert any("skipped" in line.lower() for line in result["limitations"])
    assert _texts(result["output_path"]) == _texts(master)


def test_a_step_that_breaks_the_truth_invariant_is_caught_and_undone(master, tmp_path, monkeypatch):
    real = tailor._emphasize

    def emphasize_and_lose_a_line(document, *args, **kwargs):
        out = real(document, *args, **kwargs)
        wiki = next(p for p in document.paragraphs if p.text == "Maintained the team wiki.")
        tailor._remove_paragraph(wiki)
        return out

    monkeypatch.setattr(tailor, "_emphasize", emphasize_and_lose_a_line)
    result = _run(master, tmp_path)
    assert [s["step"] for s in result["skipped_steps"]] == ["emphasize"]
    assert "truth-preservation invariant failed" in result["skipped_steps"][0]["reason"]
    assert _bullets(result["output_path"]) == _bullets(master)
    assert result["invariants"]["text_units_preserved"] is True


def test_a_page_fit_that_drops_an_undeclared_line_is_undone(master, tmp_path, monkeypatch):
    def fit_and_lose_a_line(document, **_kwargs):
        wiki = next(p for p in document.paragraphs if p.text == "Maintained the team wiki.")
        tailor._remove_paragraph(wiki)
        return None, []

    monkeypatch.setattr(tailor, "_fit_to_pages", fit_and_lose_a_line)
    result = _run(master, tmp_path)
    assert [s["step"] for s in result["skipped_steps"]] == ["fit"]
    assert _bullets(result["output_path"]) == _bullets(master)


def test_two_failing_steps_are_both_skipped(master, tmp_path, monkeypatch):
    def boom(*_args, **_kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(tailor, "_reorder_competency_paragraphs", boom)
    monkeypatch.setattr(tailor, "_protect_headings", boom)
    result = _run(master, tmp_path)
    assert sorted(s["step"] for s in result["skipped_steps"]) == ["competency_lines", "protect_headings"]
    assert any(c["type"] == "emphasize" for c in result["changes"])


def test_table_flattening_is_not_optional_and_still_fails_closed(master, tmp_path, monkeypatch):
    def boom(*_args, **_kwargs):
        raise RuntimeError("ATS table normalization changed or duplicated resume text")

    monkeypatch.setattr(tailor, "_flatten_tables_for_ats", boom)
    with pytest.raises(RuntimeError, match="table normalization"):
        _run(master, tmp_path)

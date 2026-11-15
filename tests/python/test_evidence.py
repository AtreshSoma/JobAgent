"""One evidence check (audit R2, R3; R13/D3 shares it with the scorer).

The cases live in tests/shared/evidence_cases.json and are run by the Node
suite against the JavaScript twin too, so the two cannot drift.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

import evidence
import tailor

_SHARED = json.loads((Path(__file__).resolve().parents[1] / "shared" / "evidence_cases.json").read_text())
CASES = _SHARED["cases"]
EVIDENCE_CASES = _SHARED["evidenceCases"]


@pytest.mark.parametrize("case", CASES, ids=[f"{c['term']}|{c['line'][:40]}|{c['expect']}" for c in CASES])
def test_shared_cases(case):
    found = evidence.occurrences(case["term"], case["line"], vocabulary=case.get("vocabulary", ()),
                                 in_list=case.get("inList", False))
    assert bool(found) is case["expect"], case["why"]


@pytest.mark.parametrize("case", EVIDENCE_CASES, ids=[f"{c['term']}|{c['expect']}" for c in EVIDENCE_CASES])
def test_shared_find_evidence_cases(case):
    found = evidence.find_evidence(case["term"], case["lines"], aliases=case.get("aliases"))
    assert bool(found) is case["expect"], case["why"]


def test_an_occurrence_is_the_span_of_the_term_itself():
    line = "Built forecasting models in R and Python."
    [(start, end)] = evidence.occurrences("r", line)
    assert line[start:end] == "R"
    [(start, end)] = evidence.occurrences("data pipeline", "Built data pipelines in Airflow.")
    assert "Built data pipelines in Airflow."[start:end] == "data pipelines"


def test_everyday_terms_and_single_letters_are_the_ambiguous_ones():
    for term in ("go", "r", "c", "excel", "access", "word", "x"):
        assert evidence.is_everyday(term), term
    for term in ("python", "sql", "data pipeline", "c++", "ml", "ai"):
        assert not evidence.is_everyday(term), term


def test_find_evidence_returns_the_line_and_honours_aliases():
    lines = ["Built a Golang service for payments.", "Wrote SQL."]
    found = evidence.find_evidence("go", lines, aliases={"go": ["golang"]})
    assert found == [{"matched_term": "golang", "resume_text": "Built a Golang service for payments."}]
    assert evidence.find_evidence("go", lines) == []


# ── the tailor uses it everywhere it decides "the resume shows this" ─────────

JOB = {"company": "Example Co", "title": "Data Engineer",
       "jd_text": "Required: Go, R, Excel and Airflow for reporting."}


def _resume(tmp_path, lines):
    from docx import Document
    doc = Document()
    for line in lines:
        doc.add_paragraph(line)
    path = tmp_path / "master.docx"
    doc.save(str(path))
    return path


def test_everyday_words_in_prose_are_not_evidence_and_are_reported_as_gaps(tmp_path):
    master = _resume(tmp_path, [
        "Owned the go-live of three platforms and partnered with R&D.",
        "I excel at turning messy sources into reliable reporting.",
        "Built pipelines in Airflow.",
    ])
    result = tailor.tailor_resume(master, tmp_path / "out", JOB, ["go", "r", "excel", "airflow"], {})
    assert result["audit"]["present"] == ["airflow"]
    assert {g["keyword"] for g in result["gaps"]} == {"go", "r", "excel"}
    # Nothing in the prose was bolded as if it were the skill.
    emphasis = next((c for c in result["changes"] if c["type"] == "emphasize"), {"after": []})
    assert {a["text"].lower() for a in emphasis["after"]} <= {"airflow"}


def test_everyday_terms_in_a_skills_list_are_evidence(tmp_path):
    master = _resume(tmp_path, ["Languages: Go, R, Python", "Tools: Excel, Tableau", "Built pipelines in Airflow."])
    result = tailor.tailor_resume(master, tmp_path / "out", JOB, ["go", "r", "excel", "airflow"], {})
    assert result["audit"]["present"] == ["go", "r", "excel", "airflow"]
    assert result["gaps"] == []


def test_a_posting_that_only_says_go_live_does_not_ask_for_go(tmp_path):
    master = _resume(tmp_path, ["Built pipelines in Airflow."])
    job = {**JOB, "jd_text": "Required: Airflow. You will own the go-live of each release."}
    result = tailor.tailor_resume(master, tmp_path / "out", job, ["go", "airflow"], {})
    assert [g["keyword"] for g in result["gaps"]] == []


def test_a_plural_in_the_resume_evidences_the_singular_requirement(tmp_path):
    master = _resume(tmp_path, ["Built data pipelines in Airflow."])
    job = {**JOB, "jd_text": "Required: experience building a data pipeline."}
    result = tailor.tailor_resume(master, tmp_path / "out", job, ["data pipeline"], {})
    assert result["audit"]["present"] == ["data pipeline"]
    assert result["gaps"] == []

"""Where bold goes (audit R8).

Emphasis took the first occurrence anywhere, so a term landed in bold on a role
line ("Airflow Platform Engineer | Example Corp") or a heading, and a term Word
had split across two runs ("Tuned Sp" + "ark") was audited as present but
never bolded. Bold now goes only on the summary, skills and bullets, and runs
with identical formatting are joined before looking.
"""
from __future__ import annotations

from docx import Document

import tailor

JOB = {"company": "Example Co", "title": "Data Engineer",
       "jd_text": "Required: Airflow, Spark and SQL. Senior data engineer."}


def _bold_texts(path):
    out = []
    for paragraph in Document(str(path)).paragraphs:
        out.extend((paragraph.text, run.text) for run in paragraph.runs if run.bold and run.text.strip())
    return out


def _tailor(tmp_path, build, keywords):
    doc = Document()
    build(doc)
    path = tmp_path / "master.docx"
    doc.save(str(path))
    result = tailor.tailor_resume(path, tmp_path / "out", JOB, keywords, {})
    return result, _bold_texts(result["output_path"])


def test_a_role_line_and_the_name_are_never_bolded(tmp_path):
    def build(doc):
        doc.add_paragraph("Airflow Example")  # a name that happens to be a keyword
        doc.add_paragraph("PROFESSIONAL EXPERIENCE")
        doc.add_paragraph("Airflow Platform Engineer | Example Corp | Jan 2019 - Present")
        doc.add_paragraph("Ran Airflow for 40 teams.", style="List Bullet")

    _result, bold = _tailor(tmp_path, build, ["airflow"])
    assert bold == [("Ran Airflow for 40 teams.", "Airflow")]


def test_a_title_line_above_the_dates_is_not_bolded(tmp_path):
    def build(doc):
        doc.add_paragraph("PROFESSIONAL SUMMARY")
        doc.add_paragraph("Engineer building reporting platforms for finance.")
        doc.add_paragraph("PROFESSIONAL EXPERIENCE")
        doc.add_paragraph("Senior Data Engineer, Example Corp")
        doc.add_paragraph("Remote | Jan 2019 - Present")
        doc.add_paragraph("Moved batch jobs to Spark.", style="List Bullet")

    _result, bold = _tailor(tmp_path, build, ["senior data engineer", "spark"])
    places = {paragraph for paragraph, _run in bold}
    assert places == {"Moved batch jobs to Spark."}


def test_skills_lines_are_bolded(tmp_path):
    def build(doc):
        doc.add_paragraph("CORE COMPETENCIES")
        doc.add_paragraph("Data Platforms:  SQL, Airflow, Spark")

    _result, bold = _tailor(tmp_path, build, ["airflow"])
    assert [run for _p, run in bold] == ["Airflow"]


def test_a_term_split_across_two_runs_is_found_and_bolded(tmp_path):
    def build(doc):
        doc.add_paragraph("PROFESSIONAL EXPERIENCE")
        bullet = doc.add_paragraph(style="List Bullet")
        bullet.add_run("Tuned Sp")
        bullet.add_run("ark jobs on a shared cluster.")

    result, bold = _tailor(tmp_path, build, ["spark"])
    assert bold == [("Tuned Spark jobs on a shared cluster.", "Spark")]
    assert "spark" in result["audit"]["present"]


def test_runs_with_different_formatting_are_not_joined(tmp_path):
    def build(doc):
        doc.add_paragraph("PROFESSIONAL EXPERIENCE")
        bullet = doc.add_paragraph(style="List Bullet")
        bullet.add_run("Tuned ").italic = True
        bullet.add_run("Spark jobs on a shared cluster.")

    result, bold = _tailor(tmp_path, build, ["spark"])
    assert bold == [("Tuned Spark jobs on a shared cluster.", "Spark")]
    runs = Document(result["output_path"]).paragraphs[1].runs
    assert runs[0].text == "Tuned " and runs[0].italic is True

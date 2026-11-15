"""Headings the tailor recognises (audit R14).

Headings were a fixed English list: "Career History", "Professional
Background" or "Technical Proficiencies" were unknown, so nothing in those
sections was reordered, and nothing said so. Now: a wider built-in list, more
names from config (ats_resume.json "sectionHeadings"), a section that holds the
jobs counts as experience whatever it is called, and a line set like a heading
(capitals, bold or a Heading style) ends the section above it.
"""
from __future__ import annotations

from docx import Document

import resume_corpus as corpus
import tailor
from readiness import readiness

JOB = {"company": "Example Co", "title": "Data Engineer",
       "jd_text": "Required qualifications: data quality checks and Airflow."}


def _master(tmp_path, experience_heading, extra=()):
    doc = Document()
    doc.add_paragraph(corpus.NAME)
    doc.add_paragraph(experience_heading)
    doc.add_paragraph(corpus.ROLE_1)
    for text in corpus.BULLETS_1:
        doc.add_paragraph(text, style="List Bullet")
    for line, style in extra:
        doc.add_paragraph(line, style=style)
    path = tmp_path / "headings.docx"
    doc.save(str(path))
    return path


def _reordered(result):
    return any(c["type"] == "reorder_experience_bullets" for c in result["changes"])


def test_common_heading_words_are_known(tmp_path):
    for heading in ("CAREER HISTORY", "PROFESSIONAL BACKGROUND", "Work History", "RELEVANT EXPERIENCE"):
        result = tailor.tailor_resume(_master(tmp_path, heading), tmp_path / "out", JOB, ["data quality"], {})
        assert _reordered(result), heading


def test_more_names_come_from_config(tmp_path):
    master = _master(tmp_path, "WHERE I HAVE WORKED")
    headings = {"experience": ["where i have worked"]}
    result = tailor.tailor_resume(master, tmp_path / "out", JOB, ["data quality"], {}, section_headings=headings)
    assert _reordered(result)


def test_the_section_holding_the_jobs_is_experience_whatever_it_is_called(tmp_path):
    result = tailor.tailor_resume(_master(tmp_path, "MY JOURNEY"), tmp_path / "out", JOB, ["data quality"], {})
    assert _reordered(result)


def test_a_line_set_like_a_heading_ends_the_section_above_it(tmp_path):
    # "SIDE QUESTS" is unknown, but set in capitals: its bullets are not part of
    # the job above, so they never move into it.
    master = _master(tmp_path, "PROFESSIONAL EXPERIENCE", extra=[
        ("SIDE QUESTS", "Normal"),
        ("Ran a data quality meetup for 200 members.", "List Bullet"),
    ])
    result = tailor.tailor_resume(master, tmp_path / "out", JOB, ["data quality"], {})
    texts = [p.text for p in Document(result["output_path"]).paragraphs]
    assert texts.index("SIDE QUESTS") < texts.index("Ran a data quality meetup for 200 members.")
    assert texts[-2:] == ["SIDE QUESTS", "Ran a data quality meetup for 200 members."]


def test_the_name_line_in_capitals_is_not_a_heading(tmp_path):
    doc = Document()
    for line in ("JORDAN EXAMPLE", "PROFESSIONAL SUMMARY", corpus.SUMMARY, "EXPERIENCE", corpus.ROLE_1):
        doc.add_paragraph(line)
    doc.add_paragraph(corpus.BULLETS_1[0], style="List Bullet")
    path = tmp_path / "caps_name.docx"
    doc.save(str(path))
    assert [u["kind"] for u in tailor.master_units(path)][:2] == ["paragraph", "section"]


def test_the_resume_check_no_longer_flags_known_synonyms(tmp_path):
    report = readiness(corpus.build("other_heading_words", tmp_path))
    assert report["unrecognized_headings"] == []
    assert "career history" in report["sections"]

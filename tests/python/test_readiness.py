"""Resume readiness check on upload (audit F4).

What the tailor will be able to work with, said once when the master resume is
uploaded instead of discovered packet by packet: sections, roles, bullets and
contact details found; tables, text boxes, typed bullets and links flagged;
headings it does not recognise named; an estimated page count. It reads the
document with the tailor's own detectors, so it reports what tailoring will see.
"""
from __future__ import annotations

import resume_corpus as corpus
from readiness import readiness


def _codes(report):
    return {f["code"]: f for f in report["findings"]}


def test_a_plain_resume_is_ready(tmp_path):
    report = readiness(corpus.build("baseline", tmp_path))
    assert report["roles"] == [corpus.ROLE_1, corpus.ROLE_2]
    assert report["bullets"] == corpus.DEFAULT_BULLETS
    assert {"professional summary", "professional experience", "education"} <= set(report["sections"])
    assert report["contact"] == {"email": True, "phone": True, "linkedin": False, "in_page_header": False}
    assert report["estimated_pages"] > 0
    codes = _codes(report)
    assert codes["structure"]["level"] == "ok"
    assert not [f for f in report["findings"] if f["level"] == "warn"]


def test_education_above_experience_is_not_a_role(tmp_path):
    report = readiness(corpus.build("education_first", tmp_path))
    assert report["roles"] == [corpus.ROLE_1, corpus.ROLE_2]


def test_typed_bullets_and_links_are_noted(tmp_path):
    dashes = readiness(corpus.build("dash_bullets", tmp_path))
    assert dashes["typed_bullets"] == corpus.DEFAULT_BULLETS
    assert "typed_bullets" in _codes(dashes)
    linked = readiness(corpus.build("hyperlinked_email", tmp_path))
    assert linked["hyperlinks"] == 1
    assert linked["contact"]["email"] is True
    assert "hyperlinks" in _codes(linked)


def test_tables_text_boxes_and_header_contact_are_flagged(tmp_path):
    table = readiness(corpus.build("skills_table", tmp_path))
    assert table["tables"] == 1
    assert _codes(table)["tables"]["level"] == "note"
    box = readiness(corpus.build("text_box_summary", tmp_path))
    assert box["text_boxes"] == 1
    assert _codes(box)["text_boxes"]["level"] == "warn"
    header = readiness(corpus.build("contact_in_header", tmp_path))
    assert header["contact"]["in_page_header"] is True
    assert header["contact"]["email"] is True
    assert "contact_in_header" in _codes(header)


def test_headings_it_does_not_recognise_are_named(tmp_path):
    from docx import Document
    doc = Document()
    for line in (corpus.NAME, "PROFESSIONAL EXPERIENCE", corpus.ROLE_1, "SIDE QUESTS",
                 "Ran a data meetup for 200 members."):
        doc.add_paragraph(line)
    path = tmp_path / "unknown_heading.docx"
    doc.save(str(path))
    report = readiness(path)
    unknown = _codes(report)["unrecognized_headings"]
    assert unknown["level"] == "warn"
    assert "SIDE QUESTS" in unknown["message"]
    assert report["unrecognized_headings"] == ["SIDE QUESTS"]


def test_an_installs_own_heading_names_are_known(tmp_path):
    report = readiness(corpus.build("other_heading_words", tmp_path))
    assert report["unrecognized_headings"] == []


def test_no_contact_details_and_no_roles_are_warnings(tmp_path):
    from docx import Document
    doc = Document()
    for line in ("Jordan Example", "SUMMARY", "Data engineer building reporting platforms for finance teams."):
        doc.add_paragraph(line)
    path = tmp_path / "thin.docx"
    doc.save(str(path))
    codes = _codes(readiness(path))
    assert codes["no_roles"]["level"] == "warn"
    assert codes["no_email"]["level"] == "warn"
    assert codes["no_phone"]["level"] == "warn"


def test_every_finding_is_plain_words_with_a_level(tmp_path):
    for name in corpus.LAYOUTS:
        for finding in readiness(corpus.build(name, tmp_path))["findings"]:
            assert finding["level"] in {"ok", "note", "warn"}, (name, finding)
            assert finding["message"] and not finding["message"].startswith("{"), (name, finding)
            assert "npm" not in finding["message"] and ".json" not in finding["message"], (name, finding)

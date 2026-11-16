"""Section headings are recognised in the shapes real resumes use.

Measured 2026-11-12 on a real resume: 0 of its 6 headings were recognised, so
skills, summary and bullets were never reordered and the "tailored" copy was
effectively the master. The cause was `_norm_heading` keeping a trailing ":"
and a vocabulary too narrow for common variants. See
docs/RESUME_TAILORING_PLAN.md (P0). Examples here are generic stand-ins.
"""
import pytest
from docx import Document

from tailor import _SECTION_HEADINGS, _is_section_heading, _norm_heading, tailor_resume


@pytest.mark.parametrize("text, expected", [
    ("EDUCATION:", "education"),
    ("TECHNICAL SKILLS:", "technical skills"),
    ("Professional Summary :", "professional summary"),
    ("  PROFESSIONAL   EXPERIENCE: ", "professional experience"),
    ("Skills -", "skills"),
    # A qualifier before a known section name.
    ("Relevant Work Experience", "work experience"),
    ("Professional Skills", "skills"),
    ("Relevant Experience:", "relevant experience"),
    # Detail after a comma names the employer or the place, not the section.
    ("Projects, Example Organisation", "projects"),
    ("Education, Example University:", "education"),
])
def test_headings_are_normalised_to_a_known_name(text, expected):
    assert _norm_heading(text) == expected
    assert _norm_heading(text) in _SECTION_HEADINGS


@pytest.mark.parametrize("text", [
    "Volunteer Work Experience", "Affiliations", "Professional Affiliations", "Skills & Tools",
    "TECHNICAL SKILLS & TOOLS:", "Education & Certifications:",
])
def test_common_variants_are_section_headings(text):
    assert _is_section_heading(text)


@pytest.mark.parametrize("text", [
    "Led the migration of the reporting platform:",
    "Experience with large distributed systems and data pipelines",
    "Skills gap analysis for the support team",
    "Education, Example University, 2012 - 2016",
    "Acme Analytics, Senior Engineer, 2019 - Present",
    "",
])
def test_ordinary_lines_are_not_headings(text):
    assert not _is_section_heading(text)


def test_a_combined_heading_keeps_all_its_parts():
    # Both parts are known, so it must stay combined, not collapse to the first.
    assert _is_section_heading("Skills, Tools")
    assert _norm_heading("Education, Certifications") == "education, certifications"


def test_colon_headings_do_not_stop_tailoring_from_reordering_skills(tmp_path, humanizer_patterns):
    """The same resume as the competency fixture, with every heading ending in ':'."""
    doc = Document()
    doc.add_paragraph("Priya Raghunathan")
    doc.add_paragraph("PROFESSIONAL SUMMARY:")
    doc.add_paragraph("Senior Data Engineer with cloud data platform experience.")
    doc.add_paragraph("CORE COMPETENCIES:")
    table = doc.add_table(rows=2, cols=2)
    table.rows[0].cells[0].text = "Data Platforms:"
    table.rows[0].cells[1].text = "Snowflake, Azure Databricks, Microsoft Fabric, Azure Synapse"
    table.rows[1].cells[0].text = "Pipelines:"
    table.rows[1].cells[1].text = "SSIS, ADF Pipelines, PySpark, Kafka"
    doc.add_paragraph("PROFESSIONAL EXPERIENCE:")
    doc.add_paragraph("Built medallion pipelines on Azure Databricks with PySpark and Delta Lake.")
    master = tmp_path / "MASTER_RESUME.docx"
    doc.save(str(master))

    result = tailor_resume(
        master, tmp_path / "out", {"company": "Acme", "title": "Data Engineer"},
        keywords=["pyspark", "microsoft fabric"], patterns=humanizer_patterns,
    )
    reorders = [c for c in result["changes"] if c["type"] == "reorder_skills"]
    assert len(reorders) == 2
    assert all(c["before"] != c["after"] for c in reorders)

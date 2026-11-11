"""Tests for the resume format + content validator."""
from docx import Document

from validate import validate_resume


def _make_resume(tmp_path, paragraphs, name="resume.docx"):
    doc = Document()
    for p in paragraphs:
        doc.add_paragraph(p)
    path = tmp_path / name
    doc.save(str(path))
    return path


def _good_paragraphs():
    # ~160 words across the core sections with contact details.
    filler = "Built and shipped reliable data pipelines and analytics across teams. " * 12
    return [
        "Priya Raghunathan",
        "priya@example.com | 555-123-4567",
        "Experience",
        "Senior Data Engineer — " + filler,
        "Education",
        "B.Tech in Computer Science, 2018.",
        "Skills",
        "Python, PySpark, Azure Databricks, Delta Lake, Power BI, SQL.",
    ]


def test_valid_resume_passes(tmp_path):
    path = _make_resume(tmp_path, _good_paragraphs())
    result = validate_resume(path, keywords=["python", "pyspark", "azure"])
    assert result["ok"] is True
    assert result["issues"] == []
    assert result["sections"] == {"experience": True, "education": True, "skills": True}
    assert result["has_email"] is True
    assert result["has_phone"] is True
    assert result["keyword_coverage"]["ratio"] == 1.0


def test_missing_file_is_a_hard_issue(tmp_path):
    result = validate_resume(tmp_path / "nope.docx")
    assert result["ok"] is False
    assert any("not found" in i for i in result["issues"])


def test_empty_resume_is_a_hard_issue(tmp_path):
    path = _make_resume(tmp_path, [""])
    result = validate_resume(path)
    assert result["ok"] is False
    assert any("empty" in i for i in result["issues"])


def test_missing_all_sections_and_contact_is_hard_issue(tmp_path):
    # Enough words, but no sections and no contact details.
    body = "word " * 200
    path = _make_resume(tmp_path, [body])
    result = validate_resume(path)
    assert result["ok"] is False
    assert any("core sections" in i for i in result["issues"])
    assert any("contact details" in i for i in result["issues"])


def test_one_missing_section_is_a_warning_not_an_issue(tmp_path):
    paragraphs = _good_paragraphs()
    # Drop the Education section header + line.
    paragraphs = [p for p in paragraphs if not p.startswith("Education") and "B.Tech" not in p]
    result = validate_resume(_make_resume(tmp_path, paragraphs))
    assert result["ok"] is True  # still no hard issues
    assert any("missing section" in w for w in result["warnings"])


def test_low_keyword_coverage_is_a_warning(tmp_path):
    path = _make_resume(tmp_path, _good_paragraphs())
    result = validate_resume(path, keywords=["kafka", "snowflake", "terraform", "python"])
    assert result["ok"] is True
    assert result["keyword_coverage"]["ratio"] < 0.4
    assert any("keyword coverage" in w for w in result["warnings"])

"""Tests for the deterministic resume tailor."""
import hashlib

from keywordAudit import read_docx_text
from tailor import output_filename, tailor_resume


def _digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_output_filename_is_slugged_and_dated():
    name = output_filename("Acme Analytics", "Senior Data Engineer")
    assert name.startswith("acme-analytics_senior-data-engineer_")
    assert name.endswith(".docx")


def test_tailor_honors_explicit_output_name(sample_resume, tmp_path, humanizer_patterns):
    out_dir = tmp_path / "output"
    job = {"company": "Acme", "title": "Senior Data Engineer"}
    result = tailor_resume(
        sample_resume, out_dir, job,
        keywords=["azure"],
        patterns=humanizer_patterns,
        output_name="Atresh_Somayajula_Resume_Senior_Data_Engineer.docx",
    )
    assert result["output_path"].endswith(
        "Atresh_Somayajula_Resume_Senior_Data_Engineer.docx"
    )


def test_tailor_creates_output_and_leaves_master_untouched(sample_resume, tmp_path, humanizer_patterns):
    before = _digest(sample_resume)
    out_dir = tmp_path / "output"
    job = {"company": "Acme", "title": "Senior Data Engineer"}
    result = tailor_resume(
        sample_resume, out_dir, job,
        keywords=["azure", "pyspark", "snowflake"],
        patterns=humanizer_patterns,
    )

    # Master is byte-for-byte unchanged.
    assert _digest(sample_resume) == before
    # Output exists and is a different file.
    out_path = result["output_path"]
    assert out_path.endswith(".docx")
    assert "snowflake" in result["audit"]["missing"]
    assert "azure" in result["audit"]["present"]


def test_tailor_does_not_fabricate_missing_keywords(sample_resume, tmp_path, humanizer_patterns):
    out_dir = tmp_path / "output"
    job = {"company": "Acme", "title": "DE"}
    result = tailor_resume(
        sample_resume, out_dir, job,
        keywords=["snowflake", "redshift"],
        patterns=humanizer_patterns,
    )
    tailored_text = read_docx_text(result["output_path"]).lower()
    # Missing skills must NOT be injected into the tailored resume.
    assert "snowflake" not in tailored_text
    assert "redshift" not in tailored_text


def test_summary_line_only_lists_present_keywords(sample_resume, tmp_path, humanizer_patterns):
    out_dir = tmp_path / "output"
    job = {"company": "Acme", "title": "DE"}
    result = tailor_resume(
        sample_resume, out_dir, job,
        keywords=["azure", "snowflake"],
        patterns=humanizer_patterns,
        add_summary_line=True,
    )
    assert result["summary_line"] is not None
    assert "azure" in result["summary_line"].lower()
    assert "snowflake" not in result["summary_line"].lower()


def test_focus_line_anchored_above_core_competencies(tmp_path, humanizer_patterns):
    """The per-job focus line is inserted just above CORE COMPETENCIES."""
    from docx import Document

    doc = Document()
    doc.add_paragraph("ATRESH SOMAYAJULA")
    doc.add_paragraph("PROFESSIONAL SUMMARY")
    doc.add_paragraph("Built medallion pipelines on Azure Databricks with PySpark and Delta Lake.")
    doc.add_paragraph("CORE COMPETENCIES")
    doc.add_paragraph("Azure, PySpark, Power BI, Delta Lake")
    master = tmp_path / "MASTER_RESUME.docx"
    doc.save(str(master))

    out_dir = tmp_path / "output"
    job = {"company": "Acme", "title": "Senior Data Engineer"}
    result = tailor_resume(
        master, out_dir, job,
        keywords=["azure", "pyspark", "snowflake"],
        patterns=humanizer_patterns,
        add_summary_line=True,
    )

    texts = [p.text for p in Document(result["output_path"]).paragraphs]
    focus_idx = next(
        i for i, t in enumerate(texts) if t.lower().startswith("most relevant to this role")
    )
    cc_idx = next(i for i, t in enumerate(texts) if t.strip().lower() == "core competencies")
    # The focus line sits immediately above the CORE COMPETENCIES heading.
    assert focus_idx < cc_idx
    # Honest: present keywords are listed, missing ones never appear.
    assert "azure" in texts[focus_idx].lower()
    assert "pyspark" in texts[focus_idx].lower()
    assert "snowflake" not in texts[focus_idx].lower()


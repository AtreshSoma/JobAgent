"""Pytest configuration: make src/resume importable and provide a sample resume."""
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
RESUME_SRC = REPO_ROOT / "src" / "resume"
sys.path.insert(0, str(RESUME_SRC))


@pytest.fixture()
def humanizer_patterns():
    return {
        "bannedPhrases": ["leverage synergies", "results-driven professional"],
        "bannedCharacters": ["\u2014", "\u2013"],
        "characterReplacements": {"\u2014": ", ", "\u2013": "-", "\u2019": "'"},
        "rules": {"removeEmDashes": True, "collapseExclamation": True, "normalizeWhitespace": True},
    }


@pytest.fixture()
def sample_resume(tmp_path):
    """Create a small .docx master resume and return its path."""
    from docx import Document

    doc = Document()
    doc.add_paragraph("Atresh Somayajula")
    doc.add_paragraph("Senior Data Engineer")
    doc.add_paragraph("Built medallion pipelines on Azure Databricks with PySpark and Delta Lake.")
    doc.add_paragraph("Developed Power BI semantic models and DAX measures for finance analytics.")
    path = tmp_path / "MASTER_RESUME.docx"
    doc.save(str(path))
    return path


@pytest.fixture()
def sample_resume_paragraph_competencies(tmp_path):
    """A master resume shaped like the REAL one: no tables anywhere.

    CORE COMPETENCIES is a set of "Label:  a, b, c" paragraphs, and one skill
    carries a bracketed qualifier containing a comma
    ("Dimensional Modeling (Kimball, Inmon)"). Both details matter: the tailor
    originally only reordered competency TABLES, so this layout was skipped
    entirely, and a naive comma split tore the bracketed skill in half.

    Bullets are List Paragraph style so the bullet-run detection sees them.
    """
    from docx import Document

    doc = Document()
    doc.add_paragraph("Atresh Somayajula")
    doc.add_paragraph("PROFESSIONAL SUMMARY")
    doc.add_paragraph(
        "Senior Data Engineer with 10+ years building cloud data platforms."
    )
    doc.add_paragraph("CORE COMPETENCIES")
    doc.add_paragraph(
        "Analytics & BI:  Power BI, DAX, Semantic Models, "
        "Dimensional Modeling (Kimball, Inmon)"
    )
    doc.add_paragraph(
        "Pipelines:  SSIS, ADF Pipelines, PySpark, Kafka"
    )
    doc.add_paragraph("PROFESSIONAL EXPERIENCE")
    doc.add_paragraph("Senior Data Engineer | Acme | 2022 - Present")
    doc.add_paragraph(
        "Built medallion pipelines on Azure Databricks with PySpark and Delta Lake.",
        style="List Paragraph",
    )
    doc.add_paragraph(
        "Developed Power BI semantic models and DAX measures for finance analytics.",
        style="List Paragraph",
    )
    path = tmp_path / "MASTER_RESUME.docx"
    doc.save(str(path))
    return path


@pytest.fixture()
def sample_resume_with_competencies(tmp_path):
    """A master resume whose competencies live in a 2-column TABLE."""
    from docx import Document

    doc = Document()
    doc.add_paragraph("Atresh Somayajula")
    doc.add_paragraph("PROFESSIONAL SUMMARY")
    doc.add_paragraph("Senior Data Engineer with cloud data platform experience.")
    doc.add_paragraph("CORE COMPETENCIES")
    table = doc.add_table(rows=2, cols=2)
    table.rows[0].cells[0].text = "Data Platforms:"
    table.rows[0].cells[1].text = "Snowflake, Azure Databricks, Microsoft Fabric, Azure Synapse"
    table.rows[1].cells[0].text = "Pipelines:"
    table.rows[1].cells[1].text = "SSIS, ADF Pipelines, PySpark, Kafka"
    doc.add_paragraph("PROFESSIONAL EXPERIENCE")
    doc.add_paragraph("Built medallion pipelines on Azure Databricks with PySpark and Delta Lake.")
    path = tmp_path / "MASTER_RESUME.docx"
    doc.save(str(path))
    return path

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
def sample_resume_with_competencies(tmp_path):
    """A master resume with a competencies TABLE (like the real master)."""
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

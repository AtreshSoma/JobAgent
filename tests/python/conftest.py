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

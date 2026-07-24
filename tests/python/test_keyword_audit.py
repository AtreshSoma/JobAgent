"""Tests for the resume keyword audit."""
from keywordAudit import audit_keywords, read_docx_text


def test_read_docx_text(sample_resume):
    text = read_docx_text(sample_resume)
    assert "Azure Databricks" in text
    assert "Power BI" in text


def test_audit_splits_present_and_missing(sample_resume):
    text = read_docx_text(sample_resume)
    result = audit_keywords(text, ["azure", "pyspark", "delta lake", "snowflake", "kafka"])
    assert "azure" in result["present"]
    assert "pyspark" in result["present"]
    assert "delta lake" in result["present"]
    assert "snowflake" in result["missing"]
    assert "kafka" in result["missing"]


def test_audit_is_case_insensitive_and_dedupes(sample_resume):
    text = read_docx_text(sample_resume)
    result = audit_keywords(text, ["AZURE", "azure", "Azure"])
    assert result["present"].count("AZURE") == 1
    assert result["missing"] == []


def test_audit_uses_truthful_aliases_and_keeps_absent_tools_missing():
    result = audit_keywords(
        "Delivered PySpark transformations through ADF Pipelines.",
        ["spark", "elt", "dbt"],
        evidence_aliases={
            "spark": ["pyspark"],
            "elt": ["adf pipelines"],
        },
    )
    assert result["present"] == ["spark", "elt"]
    assert result["missing"] == ["dbt"]

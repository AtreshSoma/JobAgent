"""Tests for the ATS-safety resume linter."""
import json
from pathlib import Path

from docx import Document
from docx.shared import Inches

from atsLint import lint_resume

CONFIG = json.load(open(Path(__file__).resolve().parents[2] / "config" / "ats_resume.json"))


def _save(doc, tmp_path, name="resume.docx"):
    path = tmp_path / name
    doc.save(str(path))
    return path


def test_clean_resume_passes(tmp_path):
    doc = Document()
    doc.add_paragraph("Priya Raghunathan")
    doc.add_paragraph("Senior Data Engineer")
    doc.add_paragraph("Built Databricks and Delta Lake pipelines with PySpark.")
    path = _save(doc, tmp_path)
    result = lint_resume(path, config=CONFIG)
    assert result["ok"] is True
    assert result["issues"] == []
    assert result["findings"]["tables"] == 0


def test_table_is_a_high_severity_finding(tmp_path):
    doc = Document()
    doc.add_paragraph("Priya Raghunathan")
    table = doc.add_table(rows=1, cols=2)
    table.rows[0].cells[0].text = "Skill"
    table.rows[0].cells[1].text = "Level"
    path = _save(doc, tmp_path)
    result = lint_resume(path, config=CONFIG)
    assert result["ok"] is False
    assert result["findings"]["tables"] == 1
    assert any(i["severity"] == "high" and "table" in i["message"].lower() for i in result["issues"])


def test_em_dash_flagged_low(tmp_path):
    doc = Document()
    doc.add_paragraph("Engineered pipelines \u2014 reduced runtime.")
    path = _save(doc, tmp_path)
    result = lint_resume(path, config=CONFIG)
    assert result["findings"]["emDash"] is True
    assert any("dash" in i["message"].lower() for i in result["issues"])


def test_banned_bullet_phrase_flagged(tmp_path):
    doc = Document()
    doc.add_paragraph("Responsible for building data pipelines.")
    path = _save(doc, tmp_path)
    result = lint_resume(path, config=CONFIG)
    assert "responsible for" in result["findings"]["bannedBulletPhrases"]


def test_decorative_symbol_flagged_but_standard_bullet_is_safe(tmp_path):
    doc = Document()
    doc.add_paragraph("\u2022 Built pipelines")        # standard bullet: safe
    doc.add_paragraph("\u2605 Rockstar engineer")      # decorative star: flagged
    path = _save(doc, tmp_path)
    result = lint_resume(path, config=CONFIG)
    assert "\u2605" in result["findings"]["decorativeSymbols"]
    assert "\u2022" not in result["findings"]["decorativeSymbols"]


def test_missing_file_is_non_fatal(tmp_path):
    result = lint_resume(tmp_path / "nope.docx", config=CONFIG)
    assert result["ok"] is True
    assert "note" in result


def test_image_is_high_severity(tmp_path):
    doc = Document()
    doc.add_paragraph("Priya Raghunathan")
    # Create a tiny 1x1 PNG to embed.
    png = (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
        b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01"
        b"\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
    )
    img = tmp_path / "p.png"
    img.write_bytes(png)
    doc.add_picture(str(img), width=Inches(1))
    path = _save(doc, tmp_path)
    result = lint_resume(path, config=CONFIG)
    assert result["findings"]["images"] >= 1
    assert result["ok"] is False

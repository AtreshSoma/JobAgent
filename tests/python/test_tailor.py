"""Tests for the deterministic resume tailor."""
import hashlib
from collections import Counter

import pytest

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



# ── evidence-based tailoring (2026-07 upgrade) ──────────────────────────────

def _tokens(text):
    import re
    # Strip trailing punctuation so "databricks." (sentence end) == "databricks".
    return {m.rstrip("./-,") for m in re.findall(r"[a-z0-9][a-z0-9+#./-]*", text.lower())}


def test_reorders_competencies_to_put_jd_skills_first(sample_resume_with_competencies, tmp_path, humanizer_patterns):
    out_dir = tmp_path / "out"
    job = {"company": "Acme", "title": "Data Engineer"}
    result = tailor_resume(
        sample_resume_with_competencies, out_dir, job,
        keywords=["pyspark", "microsoft fabric"],
        patterns=humanizer_patterns,
    )
    from docx import Document
    doc = Document(result["output_path"])
    platforms = doc.tables[0].rows[0].cells[1].text
    pipelines = doc.tables[0].rows[1].cells[1].text
    # JD-matched skills moved to the FRONT of their category…
    assert platforms.startswith("Microsoft Fabric")
    assert pipelines.startswith("PySpark")
    # …and the multiset of skills is EXACTLY preserved (pure permutation).
    assert sorted(s.strip() for s in platforms.split(",")) == sorted(
        ["Snowflake", "Azure Databricks", "Microsoft Fabric", "Azure Synapse"])
    assert sorted(s.strip() for s in pipelines.split(",")) == sorted(
        ["SSIS", "ADF Pipelines", "PySpark", "Kafka"])
    # The change log records the reorder with before/after + evidence.
    reorders = [c for c in result["changes"] if c["type"] == "reorder_skills"]
    assert len(reorders) == 2
    assert reorders[0]["before"] != reorders[0]["after"]
    assert "job description asks for" in reorders[0]["evidence"]


def test_tailored_resume_never_contains_unsupported_requirements(
    sample_resume_with_competencies, tmp_path, humanizer_patterns
):
    """THE no-fabrication property: every word in the tailored resume already
    existed in the master. JD requirements the master does not evidence are
    reported as gaps and never inserted."""
    out_dir = tmp_path / "out"
    job = {"company": "Acme", "title": "Data Engineer"}
    unsupported = ["terraform", "golang", "kubernetes"]
    result = tailor_resume(
        sample_resume_with_competencies, out_dir, job,
        keywords=["pyspark", "azure databricks"] + unsupported,
        patterns=humanizer_patterns,
        add_summary_line=True,
    )
    master_tokens = _tokens(read_docx_text(sample_resume_with_competencies))
    # The focus line adds only a fixed label; its keywords must come from the master.
    label_tokens = _tokens("Most relevant to this role")
    tailored_tokens = _tokens(read_docx_text(result["output_path"]))
    assert tailored_tokens <= master_tokens | label_tokens, (
        f"invented tokens: {tailored_tokens - master_tokens - label_tokens}")
    # Unsupported requirements are reported as gaps — never added.
    gap_keywords = {g["keyword"] for g in result["gaps"]}
    for kw in unsupported:
        assert kw in gap_keywords
        assert kw not in tailored_tokens


def test_changes_log_traces_every_action_to_evidence(sample_resume_with_competencies, tmp_path, humanizer_patterns):
    out_dir = tmp_path / "out"
    job = {"company": "Acme", "title": "Data Engineer"}
    result = tailor_resume(
        sample_resume_with_competencies, out_dir, job,
        keywords=["pyspark"],
        patterns=humanizer_patterns,
        add_summary_line=True,
    )
    types = {c["type"] for c in result["changes"]}
    assert "reorder_skills" in types
    assert "emphasize" in types
    assert "focus_line" in types
    for change in result["changes"]:
        assert change.get("evidence"), f"change without evidence: {change}"
        assert change.get("reason"), f"change without reason: {change}"
    # Emphasis evidence cites the actual resume text that mentions the keyword.
    emphasize = next(c for c in result["changes"] if c["type"] == "emphasize")
    assert any("pyspark" in e["keyword"] for e in emphasize["evidence"])
    assert all(e["resume_text"] for e in emphasize["evidence"])


def _truth_resume(tmp_path):
    """Resume with two roles and intentionally low-relevance-first content."""
    from docx import Document

    doc = Document()
    doc.add_paragraph("Candidate Name")
    doc.add_paragraph("PROFESSIONAL SUMMARY")
    doc.add_paragraph("Created Tableau dashboards for operations teams.")
    doc.add_paragraph("Built SQL data pipelines with documented quality checks.")
    doc.add_paragraph("CORE COMPETENCIES")
    table = doc.add_table(rows=1, cols=2)
    table.rows[0].cells[0].text = "Data:"
    table.rows[0].cells[1].text = "Tableau, Kafka, SQL, Python"
    doc.add_paragraph("PROFESSIONAL EXPERIENCE")
    doc.add_paragraph("Acme Corporation")
    doc.add_paragraph("Senior Data Engineer")
    doc.add_paragraph("January 2022 - Present")
    doc.add_paragraph("Created Tableau dashboards for business users.", style="List Bullet")
    doc.add_paragraph("Built SQL pipelines with tested data-quality controls.", style="List Bullet")
    doc.add_paragraph("Beta Systems")
    doc.add_paragraph("Data Engineer")
    doc.add_paragraph("June 2019 - December 2021")
    doc.add_paragraph("Maintained Kafka ingestion for internal datasets.", style="List Bullet")
    doc.add_paragraph("Developed Python validation for scheduled loads.", style="List Bullet")
    doc.add_paragraph("EDUCATION")
    doc.add_paragraph("State University")
    path = tmp_path / "TRUTH_MASTER.docx"
    doc.save(path)
    return path


def _employment_anchor_sequence(document):
    expected = {
        "Acme Corporation", "Senior Data Engineer", "January 2022 - Present",
        "Beta Systems", "Data Engineer", "June 2019 - December 2021",
    }
    return [paragraph.text for paragraph in document.paragraphs if paragraph.text in expected]


def test_required_content_ranks_before_preferred_within_original_scopes(
    tmp_path, humanizer_patterns
):
    from docx import Document

    master = _truth_resume(tmp_path)
    jd = (
        "Requirements: SQL, Python, Terraform, and a documented 40% throughput gain. "
        "Preferred qualifications: Tableau and Kafka."
    )
    result = tailor_resume(
        master,
        tmp_path / "out",
        {"company": "Example", "title": "Data Engineer", "jd_text": jd},
        keywords=["sql", "python", "terraform", "40%", "tableau", "kafka"],
        patterns=humanizer_patterns,
    )

    doc = Document(result["output_path"])
    texts = [paragraph.text for paragraph in doc.paragraphs]
    summary_start = texts.index("PROFESSIONAL SUMMARY")
    assert texts[summary_start + 1].startswith("Built SQL")

    acme_sql = texts.index("Built SQL pipelines with tested data-quality controls.")
    acme_tableau = texts.index("Created Tableau dashboards for business users.")
    beta_python = texts.index("Developed Python validation for scheduled loads.")
    beta_kafka = texts.index("Maintained Kafka ingestion for internal datasets.")
    assert acme_sql < acme_tableau
    assert beta_python < beta_kafka

    # Role anchors never move, so bullets cannot cross employers or chronology.
    assert _employment_anchor_sequence(doc) == [
        "Acme Corporation", "Senior Data Engineer", "January 2022 - Present",
        "Beta Systems", "Data Engineer", "June 2019 - December 2021",
    ]
    changes = result["changes"]
    assert any(change["type"] == "reorder_summary" for change in changes)
    assert len([c for c in changes if c["type"] == "reorder_experience_bullets"]) == 2
    assert result["qualifications"]["audit"]["required"]["present"] == ["sql", "python"]
    assert result["qualifications"]["audit"]["preferred"]["present"] == ["tableau", "kafka"]


def test_unsupported_technology_and_metric_are_required_gaps_never_inserted(
    tmp_path, humanizer_patterns
):
    master = _truth_resume(tmp_path)
    result = tailor_resume(
        master,
        tmp_path / "out",
        {
            "company": "Example",
            "title": "Data Engineer",
            "jd_text": "Requirements: Terraform and a 40% throughput gain. Preferred: Tableau.",
        },
        keywords=["terraform", "40%", "tableau"],
        patterns=humanizer_patterns,
        add_summary_line=True,
        enable_rewrites=True,
    )
    tailored = read_docx_text(result["output_path"]).lower()
    assert "terraform" not in tailored
    assert "40%" not in tailored
    gaps = {gap["keyword"]: gap for gap in result["gaps"]}
    assert gaps["terraform"]["qualification"] == "required"
    assert gaps["40%"]["qualification"] == "required"
    assert all(gap["evidence"]["master_resume"] == [] for gap in gaps.values())
    assert result["rewrite_policy"] == {
        "mode": "disabled",
        "requested": True,
        "applied": 0,
        "reason": result["rewrite_policy"]["reason"],
    }
    assert any("deliberately not performed" in item for item in result["limitations"])


def test_provenance_and_invariants_cover_every_mutation(tmp_path, humanizer_patterns):
    master = _truth_resume(tmp_path)
    result = tailor_resume(
        master,
        tmp_path / "out",
        {
            "company": "Example",
            "title": "Data Engineer",
            "jd_text": "Required: SQL and Python. Preferred: Tableau and Kafka.",
        },
        keywords=["sql", "python", "tableau", "kafka"],
        patterns=humanizer_patterns,
        add_summary_line=True,
    )
    for change in result["changes"]:
        assert "before" in change and change["before"] is not None
        assert "after" in change and change["after"] is not None
        assert change["reason"]
        assert change["evidence"]
        assert change["source"] == "master_resume"

    assert result["selected_content"]["summary"]
    assert result["selected_content"]["experience"]
    assert all(result["invariants"][key] for key in (
        "text_units_preserved",
        "source_paragraphs_preserved_once",
        "protected_content_order_preserved",
        "employment_facts_unchanged",
        "employment_chronology_unchanged",
        "paragraph_styles_preserved",
        "ats_safe_structure_preserved",
        "duplicate_protection_passed",
    ))
    assert result["invariants"]["new_duplicates"] == []


def test_duplicate_protection_is_idempotent_and_preserves_docx_layout(
    tmp_path, humanizer_patterns
):
    from docx import Document

    master = _truth_resume(tmp_path)
    job = {
        "company": "Example",
        "title": "Data Engineer",
        "jd_text": "Required: SQL and Python. Preferred: Tableau and Kafka.",
    }
    first = tailor_resume(
        master,
        tmp_path / "first",
        job,
        keywords=["sql", "python", "tableau", "kafka"],
        patterns=humanizer_patterns,
        add_summary_line=True,
    )
    second = tailor_resume(
        first["output_path"],
        tmp_path / "second",
        job,
        keywords=["sql", "python", "tableau", "kafka"],
        patterns=humanizer_patterns,
        add_summary_line=True,
    )
    doc = Document(second["output_path"])
    texts = [paragraph.text for paragraph in doc.paragraphs]
    assert sum(text.lower().startswith("most relevant to this role:") for text in texts) == 1
    assert Counter(texts)["Built SQL pipelines with tested data-quality controls."] == 1
    assert [
        paragraph.style.name for paragraph in doc.paragraphs
        if paragraph.text in {
            "Built SQL pipelines with tested data-quality controls.",
            "Created Tableau dashboards for business users.",
            "Developed Python validation for scheduled loads.",
            "Maintained Kafka ingestion for internal datasets.",
        }
    ] == ["List Bullet"] * 4
    assert second["invariants"]["duplicate_protection_passed"] is True
    assert not any(change["type"] == "focus_line" for change in second["changes"])


def test_refuses_to_overwrite_master_resume(tmp_path, humanizer_patterns):
    master = _truth_resume(tmp_path)
    before = _digest(master)
    with pytest.raises(ValueError, match="overwrite the master"):
        tailor_resume(
            master,
            tmp_path,
            {"company": "Example", "title": "Data Engineer"},
            keywords=["sql"],
            patterns=humanizer_patterns,
            output_name=master.name,
        )
    assert _digest(master) == before


def test_cli_propagates_truthfulness_contract(tmp_path, humanizer_patterns):
    from tailor_cli import _run

    master = _truth_resume(tmp_path)
    response = _run({
        "master_path": str(master),
        "output_dir": str(tmp_path / "cli-out"),
        "job": {
            "company": "Example",
            "title": "Data Engineer",
            "jd_text": "Required: SQL and Terraform. Preferred: Tableau.",
        },
        "keywords": ["sql", "terraform", "tableau"],
        "patterns": humanizer_patterns,
        "ats_config": {
            "requiredMarkers": ["required"],
            "preferredMarkers": ["preferred"],
        },
        "enable_rewrites": True,
    })
    assert response["ok"] is True
    assert response["qualifications"]["required"] == ["sql", "terraform"]
    assert response["rewrite_policy"]["mode"] == "disabled"
    assert response["invariants"]["employment_chronology_unchanged"] is True
    assert response["selected_content"]["summary"]
    assert response["limitations"]
    assert response["gaps"][0]["keyword"] == "terraform"


def test_non_competency_tables_are_immutable(tmp_path, humanizer_patterns):
    from docx import Document

    doc = Document()
    doc.add_paragraph("Candidate Name")
    doc.add_paragraph("PROFESSIONAL EXPERIENCE")
    table = doc.add_table(rows=1, cols=2)
    table.rows[0].cells[0].text = "Acme Corporation"
    table.rows[0].cells[1].text = "Tableau, SQL, Python"
    master = tmp_path / "TABLE_MASTER.docx"
    doc.save(master)

    result = tailor_resume(
        master,
        tmp_path / "out",
        {
            "company": "Example",
            "title": "Data Engineer",
            "jd_text": "Required: SQL and Python. Preferred: Tableau.",
        },
        keywords=["sql", "python", "tableau"],
        patterns=humanizer_patterns,
    )
    tailored = Document(result["output_path"])
    assert tailored.tables[0].rows[0].cells[1].text == "Tableau, SQL, Python"
    assert not any(change["type"] == "reorder_skills" for change in result["changes"])

"""Regression tests for tailoring QUALITY, not just truthfulness.

Each test here corresponds to a defect found by running the real tailor against
real job descriptions and reading the resulting .docx:

  1. Comma-separated skill lists were split on EVERY comma, so
     "Dimensional Modeling (Kimball, Inmon)" became two fragments and reordering
     produced literal nonsense in a resume sent to employers.
  2. Emphasis bolded the whole RUN. Word stores a bullet as one run, so a single
     keyword match turned an entire bullet bold — thirteen fully-bold bullets on
     the real resume.
  3. Competency reordering only handled TABLES, so the extremely common
     paragraph layout ("Data Platforms:  Azure Databricks, …") was never
     reordered at all — the highest-value ATS action silently did nothing.
"""
import pytest
from docx import Document

from tailor import (
    _brackets_balanced,
    _parse_competency_line,
    _split_skill_list,
    tailor_resume,
)


# ─────────────────── 1. bracket-aware skill splitting ───────────────────

class TestSkillListSplitting:
    def test_keeps_bracketed_qualifiers_intact(self):
        items = _split_skill_list(
            "Power BI, DAX, Dimensional Modeling (Kimball, Inmon), SSAS Tabular"
        )
        assert items == [
            "Power BI", "DAX", "Dimensional Modeling (Kimball, Inmon)", "SSAS Tabular",
        ]

    def test_handles_slashes_and_nested_brackets(self):
        assert _split_skill_list(
            "Microsoft Fabric (Lakehouse/Warehouse), Azure Synapse, A [x, y], B {p, q}"
        ) == [
            "Microsoft Fabric (Lakehouse/Warehouse)", "Azure Synapse", "A [x, y]", "B {p, q}",
        ]

    def test_plain_lists_are_unaffected(self):
        assert _split_skill_list("SQL, Python, Spark") == ["SQL", "Python", "Spark"]

    def test_ignores_empty_segments(self):
        assert _split_skill_list("SQL, , Python,") == ["SQL", "Python"]

    def test_unclosed_bracket_does_not_crash(self):
        assert _split_skill_list("A (oops, B") == ["A (oops, B"]

    def test_bracket_balance_detector(self):
        assert _brackets_balanced("Dimensional Modeling (Kimball, Inmon)")
        assert not _brackets_balanced("Dimensional Modeling (Kimball")
        assert not _brackets_balanced("Inmon)")


class TestCompetencyLineParsing:
    def test_parses_a_labelled_skill_list(self):
        label, _sep, items = _parse_competency_line(
            "Analytics & BI:  Power BI, DAX, Semantic Models"
        )
        assert label == "Analytics & BI"
        assert items == ["Power BI", "DAX", "Semantic Models"]

    @pytest.mark.parametrize("text", [
        "PROFESSIONAL SUMMARY",                       # heading, no list
        "Senior Data Engineer with 10+ years.",       # prose, no colon
        "Data Platforms: Azure Databricks",           # single item
        "Built X: improved throughput by 40%.",       # sentence punctuation in label
    ])
    def test_rejects_non_competency_lines(self, text):
        assert _parse_competency_line(text) is None

    def test_rejects_a_long_label(self):
        assert _parse_competency_line(
            "This label is far too long to be a competency category: a, b"
        ) is None


# ─────────────────── 2. + 3. end-to-end on a realistic master ───────────────────

def _tailor(master, tmp_path, keywords, jd_text, **kwargs):
    return tailor_resume(
        master, tmp_path / "out",
        {"company": "Acme", "title": "Data Engineer", "jd_text": jd_text},
        keywords=keywords,
        patterns={},
        **kwargs,
    )


class TestParagraphCompetencyReordering:
    def test_reorders_a_paragraph_skill_list_toward_the_jd(
        self, sample_resume_paragraph_competencies, tmp_path,
    ):
        # The JD asks for dimensional modeling under Required; it sits LAST in
        # the master's Analytics & BI line and should move to the front.
        result = _tailor(
            sample_resume_paragraph_competencies, tmp_path,
            keywords=["Dimensional Modeling", "Power BI"],
            jd_text="Required qualifications: strong Dimensional Modeling experience.",
        )
        reorders = [c for c in result["changes"] if c["type"] == "reorder_skills"]
        assert reorders, "paragraph-based competencies were not reordered at all"

        analytics = next(c for c in reorders if "Analytics & BI" in c["where"])
        assert analytics["after"].index("Dimensional Modeling (Kimball, Inmon)") \
            < analytics["before"].index("Dimensional Modeling (Kimball, Inmon)")

    def test_reordering_never_corrupts_a_bracketed_skill(
        self, sample_resume_paragraph_competencies, tmp_path,
    ):
        result = _tailor(
            sample_resume_paragraph_competencies, tmp_path,
            keywords=["Dimensional Modeling", "Power BI", "DAX"],
            jd_text="Required: Dimensional Modeling, DAX, Power BI.",
        )
        text = "\n".join(p.text for p in Document(result["output_path"]).paragraphs)
        # The exact qualified skill must survive as one unit...
        assert "Dimensional Modeling (Kimball, Inmon)" in text
        # ...and the corruption signature must not appear.
        assert "Kimball, DAX" not in text
        assert "Kimball, Power BI" not in text
        assert "Kimball, Semantic" not in text

    def test_skill_multiset_is_preserved_exactly(
        self, sample_resume_paragraph_competencies, tmp_path,
    ):
        master_line = next(
            p.text for p in Document(sample_resume_paragraph_competencies).paragraphs
            if p.text.startswith("Analytics & BI")
        )
        result = _tailor(
            sample_resume_paragraph_competencies, tmp_path,
            keywords=["Dimensional Modeling"],
            jd_text="Required: Dimensional Modeling.",
        )
        out_line = next(
            p.text for p in Document(result["output_path"]).paragraphs
            if p.text.startswith("Analytics & BI")
        )
        before = _parse_competency_line(master_line)[2]
        after = _parse_competency_line(out_line)[2]
        assert sorted(before) == sorted(after)
        assert result["invariants"]["text_units_preserved"] is True


def _bold_text(path):
    """All bold text in a document, concatenated."""
    doc = Document(path)
    return "".join(
        run.text for para in doc.paragraphs for run in para.runs
        if run.bold and run.text
    )


def _all_text(path):
    """Full document text, whitespace-normalized, for content comparison."""
    import re

    doc = Document(path)
    return re.sub(r"\s+", " ", "\n".join(p.text for p in doc.paragraphs)).strip()


class TestEmphasisIsSurgical:
    def test_bolds_only_the_keyword_not_the_surrounding_sentence(
        self, sample_resume_paragraph_competencies, tmp_path,
    ):
        result = _tailor(
            sample_resume_paragraph_competencies, tmp_path,
            keywords=["PySpark"],
            jd_text="Required qualifications: PySpark.",
        )
        bold = _bold_text(result["output_path"])
        assert "PySpark" in bold, "the matched keyword should be emphasized"
        # The decisive assertion: the sentence around it must NOT be bold.
        # Whole-run bolding used to sweep up the entire bullet.
        assert "medallion pipelines" not in bold
        assert "Delta Lake" not in bold  # not requested by this JD

    def test_emphasis_stays_a_small_fraction_of_the_document(
        self, sample_resume_paragraph_competencies, tmp_path,
    ):
        result = _tailor(
            sample_resume_paragraph_competencies, tmp_path,
            keywords=["PySpark", "Azure Databricks", "Delta Lake", "Power BI", "DAX"],
            jd_text="Required: PySpark, Azure Databricks, Delta Lake, Power BI, DAX.",
        )
        bold = _bold_text(result["output_path"])
        full = _all_text(result["output_path"])
        # Headings are bold in the master, so allow generous headroom; the point
        # is that body prose is not being wholesale emphasized.
        assert len(bold) < len(full) * 0.5, (
            f"bolded {len(bold)} of {len(full)} chars — reads as keyword stuffing"
        )

    def test_run_splitting_does_not_alter_document_text(
        self, sample_resume_paragraph_competencies, tmp_path,
    ):
        result = _tailor(
            sample_resume_paragraph_competencies, tmp_path,
            keywords=["PySpark", "Azure Databricks", "Delta Lake"],
            jd_text="Required: PySpark, Azure Databricks, Delta Lake.",
        )
        # Splitting a run into bold/non-bold pieces must be invisible in text.
        out = _all_text(result["output_path"])
        for sentence in [
            "Built medallion pipelines on Azure Databricks with PySpark and Delta Lake.",
            "Developed Power BI semantic models and DAX measures for finance analytics.",
        ]:
            assert sentence in out
        assert result["invariants"]["text_units_preserved"] is True

    def test_caps_the_number_of_emphasized_terms(
        self, sample_resume_paragraph_competencies, tmp_path,
    ):
        # Twenty candidate terms must not produce twenty bolded terms: past a
        # dozen, emphasis stops meaning anything and reads as keyword stuffing.
        many = [
            "Power BI", "DAX", "Semantic Models", "PySpark", "Azure Databricks",
            "Delta Lake", "SSIS", "ADF Pipelines", "Kafka", "Dimensional Modeling",
            "Senior", "Data Engineer", "finance", "analytics", "pipelines",
            "medallion", "cloud", "platforms", "years", "Acme",
        ]
        result = _tailor(
            sample_resume_paragraph_competencies, tmp_path,
            keywords=many,
            jd_text="Required qualifications: " + ", ".join(many),
        )
        assert result["emphasized"] <= 12

    def test_prefers_required_terms_when_the_budget_is_tight(
        self, sample_resume_paragraph_competencies, tmp_path,
    ):
        result = _tailor(
            sample_resume_paragraph_competencies, tmp_path,
            keywords=["Kafka", "PySpark"],
            jd_text=(
                "Required qualifications: PySpark experience. "
                "Preferred qualifications: Kafka exposure."
            ),
        )
        emphasized = {
            e["keyword"] for change in result["changes"]
            if change["type"] == "emphasize" for e in change["evidence"]
        }
        assert "PySpark" in emphasized


class TestMasterRemainsPristine:
    def test_master_file_is_never_modified(
        self, sample_resume_paragraph_competencies, tmp_path,
    ):
        import hashlib

        before = hashlib.sha256(sample_resume_paragraph_competencies.read_bytes()).hexdigest()
        _tailor(
            sample_resume_paragraph_competencies, tmp_path,
            keywords=["Dimensional Modeling", "PySpark"],
            jd_text="Required: Dimensional Modeling, PySpark.",
        )
        after = hashlib.sha256(sample_resume_paragraph_competencies.read_bytes()).hexdigest()
        assert before == after


# ─────────────────── 4. grounded LLM classification (ordering only) ───────────────────

from tailor import _apply_llm_qualifications  # noqa: E402


def _quals(**buckets):
    items = []
    for classification, terms in buckets.items():
        for term in terms:
            items.append({"keyword": term, "classification": classification, "jd_evidence": []})
    return {
        "required": list(buckets.get("required", [])),
        "preferred": list(buckets.get("preferred", [])),
        "unclassified": list(buckets.get("unclassified", [])),
        "items": items,
    }


class TestLlmQualificationMerge:
    def test_upgrades_unclassified_terms(self):
        # Blob job descriptions leave everything unclassified, which strips the
        # ranking of any requirement signal. Grounded labels restore it.
        out = _apply_llm_qualifications(
            _quals(unclassified=["Python", "Power BI"]),
            {"required": ["Python"], "preferred": ["Power BI"]},
        )
        assert out["required"] == ["Python"]
        assert out["preferred"] == ["Power BI"]
        assert out["unclassified"] == []
        assert all(i["classified_by"] == "llm_grounded" for i in out["items"])

    def test_upgrades_preferred_to_required(self):
        out = _apply_llm_qualifications(
            _quals(preferred=["PySpark"]), {"required": ["PySpark"]},
        )
        assert out["required"] == ["PySpark"]
        assert out["preferred"] == []

    def test_never_demotes_an_explicit_heading_classification(self):
        # A real "Required qualifications:" heading is stronger evidence than a
        # model's reading of the same text, so it must win.
        out = _apply_llm_qualifications(
            _quals(required=["SQL"]), {"preferred": ["SQL"]},
        )
        assert out["required"] == ["SQL"]
        assert out["preferred"] == []
        assert "classified_by" not in out["items"][0]

    def test_is_a_no_op_without_labels(self):
        original = _quals(unclassified=["Kafka"])
        assert _apply_llm_qualifications(original, None) is original
        assert _apply_llm_qualifications(original, {"required": [], "preferred": []}) is original

    def test_ignores_terms_the_resume_never_mentioned(self):
        out = _apply_llm_qualifications(
            _quals(unclassified=["Python"]), {"required": ["Rust"]},
        )
        assert out["required"] == []
        assert out["unclassified"] == ["Python"]

    def test_matching_is_case_and_whitespace_insensitive(self):
        out = _apply_llm_qualifications(
            _quals(unclassified=["Dimensional  Modeling"]),
            {"required": ["dimensional modeling"]},
        )
        assert out["required"] == ["Dimensional  Modeling"]

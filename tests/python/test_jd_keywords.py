"""Tests for deterministic JD keyword tiering."""
from jdKeywords import extract_jd_keywords

VOCAB = [
    "azure data factory", "adf", "databricks", "delta lake", "spark",
    "dbt", "kafka", "power bi", "python", "sql",
]
MARKERS_REQUIRED = ["required", "must have"]
MARKERS_PREFERRED = ["preferred", "nice to have"]


def test_title_terms_are_tier1():
    jd = "Build pipelines with dbt."
    out = extract_jd_keywords(jd, "Senior Data Engineer (Databricks)", VOCAB,
                              required_markers=MARKERS_REQUIRED, preferred_markers=MARKERS_PREFERRED)
    assert "databricks" in out["tier1"]
    assert "databricks" in out["title_terms"]


def test_repeated_terms_are_tier1():
    jd = "We use Spark. Spark is core to the team. Some Power BI too."
    out = extract_jd_keywords(jd, "Data Engineer", VOCAB,
                              required_markers=MARKERS_REQUIRED, preferred_markers=MARKERS_PREFERRED)
    assert "spark" in out["tier1"]          # appears twice
    assert "power bi" in out["tier2"]        # appears once, no marker


def test_required_section_terms_are_tier1_preferred_are_tier2():
    jd = ("Required: Azure Data Factory and Delta Lake. "
          "Preferred: dbt and Kafka.")
    out = extract_jd_keywords(jd, "Data Engineer", VOCAB,
                              required_markers=MARKERS_REQUIRED, preferred_markers=MARKERS_PREFERRED)
    assert "azure data factory" in out["tier1"]
    assert "delta lake" in out["tier1"]
    assert "dbt" in out["tier2"]
    assert "kafka" in out["tier2"]


def test_only_vocabulary_terms_are_tiered_never_invented():
    jd = "Required: Rust, Golang, and quantum computing. Also Databricks."
    out = extract_jd_keywords(jd, "Data Engineer", VOCAB,
                              required_markers=MARKERS_REQUIRED, preferred_markers=MARKERS_PREFERRED)
    # Non-vocabulary words never appear anywhere in the output.
    flat = out["tier1"] + out["tier2"] + out["all"]
    assert all(term not in flat for term in ("rust", "golang", "quantum computing"))
    assert "databricks" in out["tier1"]


def test_outcome_signals_detected():
    jd = "Own data quality and reduce latency across the lakehouse."
    out = extract_jd_keywords(jd, "Data Engineer", VOCAB,
                              outcome_signals=["data quality", "latency", "cost reduction"])
    assert "data quality" in out["tier3_signals"]
    assert "latency" in out["tier3_signals"]
    assert "cost reduction" not in out["tier3_signals"]


def test_acronym_pair_detection():
    jd = "Required: Azure Data Factory (ADF) experience."
    out = extract_jd_keywords(jd, "Data Engineer", VOCAB,
                              required_markers=MARKERS_REQUIRED,
                              acronym_pairs=[{"acronym": "ADF", "full": "Azure Data Factory"}])
    assert out["acronyms"][0]["jd_has_acronym"] is True
    assert out["acronyms"][0]["jd_has_full"] is True


def test_word_boundary_prevents_false_substring_match():
    # "adfs" must NOT match the "adf" vocabulary term.
    jd = "We run ADFS federation. Also Databricks."
    out = extract_jd_keywords(jd, "Data Engineer", VOCAB)
    assert "adf" not in out["all"]
    assert "databricks" in out["all"]

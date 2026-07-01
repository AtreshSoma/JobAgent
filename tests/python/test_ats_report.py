"""Tests for the deterministic ATS readiness report."""
import json
from pathlib import Path

from atsReport import build_ats_report

CONFIG = json.load(open(Path(__file__).resolve().parents[2] / "config" / "ats_resume.json"))


def _jk(tier1=None, tier2=None, signals=None, acronyms=None):
    return {
        "tier1": tier1 or [],
        "tier2": tier2 or [],
        "tier3_signals": signals or [],
        "acronyms": acronyms or [],
        "all": (tier1 or []) + (tier2 or []),
    }


CLEAN_LINT = {"ok": True, "issues": [], "findings": {}}


def test_full_tier1_coverage_scores_high_and_strong_band():
    resume = "Databricks, Delta Lake, Spark, Python, SQL across Azure Data Factory pipelines."
    jk = _jk(tier1=["databricks", "delta lake", "spark"], tier2=["dbt"])
    rep = build_ats_report(resume, jk, CLEAN_LINT, config=CONFIG)
    # tier1 100% (.7) + tier2 0% (.3) = 70 -> strong band starts at 0.70.
    assert rep["match_score"] == 70
    assert rep["band"] == "strong"
    assert rep["tier1"]["missing"] == []


def test_missing_tier1_lowers_score_and_recommends_truthfully():
    resume = "Spark and Python only."
    jk = _jk(tier1=["databricks", "delta lake", "spark"], tier2=[])
    rep = build_ats_report(resume, jk, CLEAN_LINT, config=CONFIG)
    assert rep["band"] == "below_threshold"
    assert set(rep["tier1"]["missing"]) == {"databricks", "delta lake"}
    # Recommendations are conditioned on actually having the experience.
    assert any("if you have hands-on" in r.lower() for r in rep["recommendations"])


def test_critical_tier1_gap_sets_ok_false():
    resume = "Tableau and Excel."
    jk = _jk(tier1=["databricks", "delta lake", "spark", "dbt"], tier2=[])
    rep = build_ats_report(resume, jk, CLEAN_LINT, config=CONFIG)
    # 0/4 tier1 present -> below tier1CriticalMin (0.5) -> ok False.
    assert rep["ok"] is False


def test_over_optimized_band_flagged():
    resume = "Databricks Delta Lake Spark dbt Kafka Power BI Python SQL"
    jk = _jk(tier1=["databricks", "delta lake", "spark", "dbt"],
             tier2=["kafka", "power bi", "python", "sql"])
    rep = build_ats_report(resume, jk, CLEAN_LINT, config=CONFIG)
    assert rep["match_score"] >= 90
    assert rep["band"] == "over_optimized"


def test_acronym_gap_recommended_when_resume_has_only_one_form():
    # JD uses both ADF and the full form; resume has only the full form.
    resume = "Built Azure Data Factory pipelines end to end."
    jk = _jk(
        tier1=["azure data factory"],
        acronyms=[{"acronym": "ADF", "full": "Azure Data Factory",
                   "jd_has_acronym": True, "jd_has_full": True}],
    )
    rep = build_ats_report(resume, jk, CLEAN_LINT, config=CONFIG)
    assert rep["acronym_gaps"]
    assert rep["acronym_gaps"][0]["add"] == "ADF"


def test_lint_issues_flow_into_safety_and_recommendations():
    resume = "Databricks Delta Lake Spark"
    jk = _jk(tier1=["databricks", "delta lake", "spark"])
    lint = {"ok": False, "issues": [{"severity": "high", "message": "1 table(s) detected."}],
            "findings": {"tables": 1}}
    rep = build_ats_report(resume, jk, lint, config=CONFIG)
    assert rep["ats_safety"]["ok"] is False
    assert any("table" in r.lower() for r in rep["recommendations"])
    # The high-severity safety issue surfaces in the verdict too.
    assert any("table" in v.lower() for v in rep["verdict"])


def test_verdict_is_present_and_specific():
    resume = "Spark"
    jk = _jk(tier1=["databricks", "spark"])
    rep = build_ats_report(resume, jk, CLEAN_LINT, config=CONFIG)
    assert rep["verdict"]
    assert "%" in rep["verdict"][0]

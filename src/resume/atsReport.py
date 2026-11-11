"""Deterministic ATS readiness report (the honest "brutal truth" assessment).

Given the tiered JD keywords, the generated resume's text, and the ATS-safety
lint, this produces a structured, recruiter-grade readout of how well the resume
is positioned for THIS job: an estimated keyword-match score, which required
(Tier 1) terms are present vs. missing, the keyword-density band (too low = ranked
out, too high = flagged by humans), ATS-safety issues, a short verdict, and
specific, TRUTHFUL recommendations.

It never rewrites the resume and never tells the user to claim experience they do
not have. Missing-keyword recommendations are explicitly conditioned on the user
actually having that experience. Pure function of its inputs.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List

from keywordAudit import audit_keywords


def _ratio(present: int, total: int) -> float:
    return (present / total) if total else 0.0


def _pct(x: float) -> int:
    return int(round(x * 100))


def build_ats_report(
    resume_text: str,
    jd_keywords: Dict[str, Any],
    lint: Dict[str, Any] | None,
    *,
    config: Dict[str, Any] | None = None,
    evidence_aliases: Dict[str, List[str]] | None = None,
) -> Dict[str, Any]:
    """Compose the ATS readiness report.

    Returns a dict with: match_score (0-100), band, tier1/tier2 present+missing,
    coverage ratios, acronym_gaps, ats_safety, verdict (list of sentences),
    recommendations (list), and ok (False only when a Tier-1 gap is critical).
    """
    config = config or {}
    cov = config.get("coverage") or {}
    strong_min = cov.get("strongMin", 0.70)
    over_min = cov.get("overOptimizedMin", 0.90)
    tier1_critical = cov.get("tier1CriticalMin", 0.50)
    w1 = cov.get("tier1Weight", 0.70)
    w2 = cov.get("tier2Weight", 0.30)

    tier1 = list(jd_keywords.get("tier1") or [])
    tier2 = list(jd_keywords.get("tier2") or [])

    a1 = audit_keywords(resume_text, tier1, evidence_aliases=evidence_aliases)
    a2 = audit_keywords(resume_text, tier2, evidence_aliases=evidence_aliases)
    tier1_ratio = _ratio(len(a1["present"]), len(tier1))
    tier2_ratio = _ratio(len(a2["present"]), len(tier2))

    # Weighted match score. When a tier is empty, its weight collapses onto the
    # other so the score still reflects real coverage instead of cratering.
    if tier1 and tier2:
        score = w1 * tier1_ratio + w2 * tier2_ratio
    elif tier1:
        score = tier1_ratio
    elif tier2:
        score = tier2_ratio
    else:
        # No vocabulary terms found in the JD at all; fall back to overall list.
        all_terms = list(jd_keywords.get("all") or [])
        a_all = audit_keywords(
            resume_text, all_terms, evidence_aliases=evidence_aliases
        )
        score = _ratio(len(a_all["present"]), len(all_terms))

    match_score = _pct(score)

    if score < strong_min:
        band = "below_threshold"
    elif score >= over_min:
        band = "over_optimized"
    else:
        band = "strong"

    # Acronym coverage: when the JD uses BOTH the acronym and the full form,
    # the resume should too (at first mention). Report one-sided coverage.
    resume_norm = re.sub(r"\s+", " ", (resume_text or "").lower()).strip()
    acronym_gaps: List[Dict[str, str]] = []
    for pair in jd_keywords.get("acronyms") or []:
        if not (pair.get("jd_has_acronym") and pair.get("jd_has_full")):
            continue
        acr = pair.get("acronym", "")
        full = pair.get("full", "")
        has_acr = bool(re.search(rf"(?<![a-z0-9]){re.escape(acr.lower())}(?![a-z0-9])", resume_norm))
        has_full = full.lower() in resume_norm
        if has_acr != has_full:  # resume carries only one of the two forms
            acronym_gaps.append({
                "acronym": acr,
                "full": full,
                "present": acr if has_acr else full,
                "add": full if has_acr else acr,
            })

    lint = lint or {"ok": True, "issues": [], "findings": {}}
    safety_issues = list(lint.get("issues") or [])

    # ---- Verdict (honest, specific, no padding) ----
    verdict: List[str] = []
    band_label = {
        "below_threshold": f"below the ~{_pct(strong_min)}% mark most parsers rank against",
        "strong": "in the target band recruiters and parsers reward",
        "over_optimized": f"above {_pct(over_min)}%, high enough to read as keyword-stuffed to a human reviewer",
    }[band]
    verdict.append(
        f"Estimated ATS keyword match for this role: {match_score}% "
        f"(Tier 1 {_pct(tier1_ratio)}%, Tier 2 {_pct(tier2_ratio)}%) - {band_label}."
    )

    if a1["missing"]:
        top = ", ".join(a1["missing"][:6])
        verdict.append(
            f"Highest-impact gap: {len(a1['missing'])} required (Tier 1) term(s) from the posting are "
            f"absent from your resume, including {top}."
        )
    else:
        verdict.append("Every Tier 1 term from this posting already appears in your resume.")

    high_safety = [i for i in safety_issues if i.get("severity") == "high"]
    if high_safety:
        verdict.append(high_safety[0]["message"])

    verdict.append(
        "The tailor surfaced and emphasized the matched terms you already have; it cannot add "
        "experience you have not done. Address the items below in your master resume to lift the score truthfully."
    )

    # ---- Recommendations (specific + truthful) ----
    recommendations: List[str] = []
    for kw in a1["missing"][:8]:
        recommendations.append(
            f"If you have hands-on {kw} experience, add it explicitly to a bullet or the skills line "
            f"(it is a required term in this posting and is currently missing)."
        )
    for gap in acronym_gaps[:4]:
        recommendations.append(
            f"Write both forms at first mention: \"{gap['full']} ({gap['acronym']})\" "
            f"(the posting uses both; your resume shows only \"{gap['present']}\")."
        )
    for issue in safety_issues:
        recommendations.append(issue["message"])

    # `ok` is False only when Tier 1 coverage is critically low for a JD that
    # actually had Tier 1 terms. This is INFORMATIONAL severity for the pipeline
    # (surfaced as a warning, not an auto-block) - the human decides.
    ok = True
    if tier1 and tier1_ratio < tier1_critical:
        ok = False

    return {
        "match_score": match_score,
        "band": band,
        "tier1": {
            "present": a1["present"],
            "missing": a1["missing"],
            "ratio": round(tier1_ratio, 3),
        },
        "tier2": {
            "present": a2["present"],
            "missing": a2["missing"],
            "ratio": round(tier2_ratio, 3),
        },
        "tier3_signals": list(jd_keywords.get("tier3_signals") or []),
        "acronym_gaps": acronym_gaps,
        "ats_safety": {"ok": lint.get("ok", True), "issues": safety_issues, "findings": lint.get("findings", {})},
        "verdict": verdict,
        "recommendations": recommendations,
        "ok": ok,
    }

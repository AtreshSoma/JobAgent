"""Deterministic job-description keyword tiering.

The ATS-resume principle this implements: not all JD keywords matter equally. A
term in the job title, repeated several times, or listed under "Required" carries
far more ATS weight than one mentioned once under "nice to have". Surfacing those
*Tier 1* terms in the resume is what moves a candidate to the top of the ranking.

This module is GROUNDED: it only tiers phrases drawn from a supplied vocabulary
(the scoring config's known data-engineering keywords). It never invents terms,
and it makes no network calls. Pure function of (jd_text, title, vocabulary).
"""
from __future__ import annotations

import re
from typing import Any, Dict, Iterable, List, Sequence


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").lower()).strip()


def _phrase_pattern(phrase: str) -> re.Pattern:
    """Word-boundary-ish matcher tolerant of tech punctuation (ci/cd, node.js)."""
    escaped = re.escape(phrase.lower())
    return re.compile(rf"(?<![a-z0-9]){escaped}(?![a-z0-9])", re.IGNORECASE)


def _count(text: str, phrase: str) -> int:
    if not phrase:
        return 0
    return len(_phrase_pattern(phrase).findall(text))


def _required_spans(
    text: str, required_markers: Sequence[str], preferred_markers: Sequence[str]
) -> List[tuple]:
    """Return (start, end) spans of text that fall under a "required" heading.

    Works on blob JDs (no newlines) by scanning marker positions: a required
    marker opens a span that stays open until the next marker (required or
    preferred) or the end of the document. A preferred marker closes it.
    """
    events: List[tuple] = []
    for m in required_markers:
        for hit in _phrase_pattern(m).finditer(text):
            events.append((hit.start(), "required"))
    for m in preferred_markers:
        for hit in _phrase_pattern(m).finditer(text):
            events.append((hit.start(), "preferred"))
    if not events:
        return []
    events.sort(key=lambda e: e[0])

    spans: List[tuple] = []
    open_start = None
    for pos, kind in events:
        if kind == "required":
            if open_start is None:
                open_start = pos
            # consecutive required markers just extend the open span
        else:  # preferred marker closes any open required span
            if open_start is not None:
                spans.append((open_start, pos))
                open_start = None
    if open_start is not None:
        spans.append((open_start, len(text)))
    return spans


def _in_spans(text: str, phrase: str, spans: List[tuple]) -> bool:
    if not spans:
        return False
    for hit in _phrase_pattern(phrase).finditer(text):
        i = hit.start()
        if any(start <= i < end for start, end in spans):
            return True
    return False


def extract_jd_keywords(
    jd_text: str,
    title: str,
    vocabulary: Iterable[str],
    *,
    required_markers: Iterable[str] | None = None,
    preferred_markers: Iterable[str] | None = None,
    outcome_signals: Iterable[str] | None = None,
    acronym_pairs: Iterable[Dict[str, str]] | None = None,
    repeat_threshold: int = 2,
) -> Dict[str, Any]:
    """Tier the vocabulary terms that appear in a job description.

    Returns::

        {
          "tier1": [...],   # title terms OR repeated OR under "Required"
          "tier2": [...],   # present once / under "Preferred"
          "tier3_signals": [...],  # outcome signals present in the JD
          "all": [...],     # every vocabulary term present in the JD
          "counts": {term: n, ...},
          "acronyms": [{"acronym","full","jd_has_acronym","jd_has_full"}, ...],
          "title_terms": [...],
        }
    """
    jd_norm = _normalize(jd_text)
    title_norm = _normalize(title)
    required_markers = list(required_markers or [])
    preferred_markers = list(preferred_markers or [])
    outcome_signals = list(outcome_signals or [])
    acronym_pairs = list(acronym_pairs or [])

    # De-duplicate the vocabulary, preserving first-seen order + display form.
    seen = set()
    vocab: List[str] = []
    for term in vocabulary:
        key = _normalize(term)
        if key and key not in seen:
            seen.add(key)
            vocab.append(term)

    spans = _required_spans(jd_norm, required_markers, preferred_markers)

    counts: Dict[str, int] = {}
    title_terms: List[str] = []
    tier1: List[str] = []
    tier2: List[str] = []
    all_present: List[str] = []

    for term in vocab:
        n = _count(jd_norm, term)
        in_title = bool(_count(title_norm, term))
        # A term counts as "present in the posting" if it is in the body OR the
        # title. Title-only terms still matter (the title is the highest-weight
        # ATS location), so they are never skipped.
        if n == 0 and not in_title:
            continue
        counts[term] = n
        all_present.append(term)
        if in_title:
            title_terms.append(term)
        is_required = _in_spans(jd_norm, term, spans)
        if in_title or n >= repeat_threshold or is_required:
            tier1.append(term)
        else:
            tier2.append(term)

    tier3_signals = [s for s in outcome_signals if _count(jd_norm, s) > 0]

    acronyms: List[Dict[str, Any]] = []
    for pair in acronym_pairs:
        acr = pair.get("acronym", "")
        full = pair.get("full", "")
        has_acr = bool(_count(jd_norm, acr))
        has_full = bool(_count(jd_norm, full))
        if has_acr or has_full:
            acronyms.append(
                {"acronym": acr, "full": full, "jd_has_acronym": has_acr, "jd_has_full": has_full}
            )

    return {
        "tier1": tier1,
        "tier2": tier2,
        "tier3_signals": tier3_signals,
        "all": all_present,
        "counts": counts,
        "acronyms": acronyms,
        "title_terms": title_terms,
    }

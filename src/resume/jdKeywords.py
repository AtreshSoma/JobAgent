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


def _strip_non_role_boilerplate(text: str) -> str:
    """Remove recruiting-safety copy that must not become a job requirement."""
    cleaned = text or ""
    patterns = (
        # Common Greenhouse/Anthropic-style fraud warning. Without this guard,
        # "banking information" is incorrectly tiered as required domain skill.
        r"legitimate\s+[^.]{0,160}?\s+recruiters?\s+will\s+never\s+ask\s+for\s+"
        r"[^.]{0,360}?(?:\.|$)",
        r"recruitment\s+fraud\s+(?:notice|warning)[^.]{0,360}?(?:\.|$)",
    )
    for pattern in patterns:
        cleaned = re.sub(pattern, " ", cleaned, flags=re.IGNORECASE)
    return cleaned


def _phrase_pattern(phrase: str) -> re.Pattern:
    """Word-boundary-ish matcher tolerant of tech punctuation (ci/cd, node.js)."""
    escaped = re.escape(phrase.lower())
    return re.compile(rf"(?<![a-z0-9]){escaped}(?![a-z0-9])", re.IGNORECASE)


def _count(text: str, phrase: str) -> int:
    if not phrase:
        return 0
    return len(_phrase_pattern(phrase).findall(text))


def _marker_events(
    text: str, required_markers: Sequence[str], preferred_markers: Sequence[str]
) -> List[tuple]:
    """Return non-overlapping qualification-heading events.

    Marker vocabularies commonly overlap: ``preferred qualifications`` also
    contains the broad required marker ``qualifications``.  Treating both hits
    as headings incorrectly turns the preferred section back into a required
    section halfway through the heading.  We therefore prefer the longest
    marker at an overlapping location and discard the shorter nested hit.

    Each event is ``(start, end, kind, marker)`` and events are returned in
    document order.
    """
    candidates: List[tuple] = []
    for kind, markers in (
        ("required", required_markers),
        ("preferred", preferred_markers),
    ):
        for marker in markers:
            if not marker:
                continue
            for hit in _phrase_pattern(marker).finditer(text):
                candidates.append((hit.start(), hit.end(), kind, marker))

    # At a shared/overlapping position, keep the most specific (longest)
    # configured heading.  The final kind tie-break is deterministic only; an
    # exact marker should not normally be configured in both lists.
    candidates.sort(key=lambda item: (item[0], -(item[1] - item[0]), item[2]))
    selected: List[tuple] = []
    for candidate in candidates:
        start, end, _kind, _marker = candidate
        if any(start < chosen_end and end > chosen_start for chosen_start, chosen_end, *_ in selected):
            continue
        selected.append(candidate)
    return selected


def _required_spans(
    text: str, required_markers: Sequence[str], preferred_markers: Sequence[str]
) -> List[tuple]:
    """Return (start, end) spans of text that fall under a "required" heading.

    Works on blob JDs (no newlines) by scanning marker positions: a required
    marker opens a span that stays open until the next marker (required or
    preferred) or the end of the document. A preferred marker closes it.
    """
    events = _marker_events(text, required_markers, preferred_markers)
    if not events:
        return []

    spans: List[tuple] = []
    open_start = None
    for pos, _end, kind, _marker in events:
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


def _context(text: str, start: int, end: int, radius: int = 90) -> str:
    """Return a compact, whitespace-normalized JD excerpt around a hit."""
    left = max(0, start - radius)
    right = min(len(text), end + radius)
    return re.sub(r"\s+", " ", text[left:right]).strip()


def classify_qualification_keywords(
    jd_text: str,
    keywords: Iterable[str],
    *,
    required_markers: Iterable[str] | None = None,
    preferred_markers: Iterable[str] | None = None,
) -> Dict[str, Any]:
    """Classify requested keywords as required, preferred, or unclassified.

    This is deliberately narrower than ATS tiering: repetition and title
    placement can affect ATS importance, but they do not turn a preferred
    qualification into a required one.  Classification comes only from the
    most recent explicit qualification heading before each keyword occurrence.
    If a term occurs in both sections, ``required`` wins conservatively.

    The returned ``items`` retain the caller's display form and include exact JD
    excerpts so downstream tailoring can explain every prioritization decision.
    """
    # Normalize whitespace up front so multi-word headings and technologies can
    # span line breaks in copied job descriptions without losing classification.
    text = re.sub(
        r"\s+", " ", _strip_non_role_boilerplate(jd_text or "")
    ).strip()
    required = list(required_markers or [])
    preferred = list(preferred_markers or [])
    events = _marker_events(text, required, preferred)

    deduped: List[str] = []
    seen = set()
    for keyword in keywords:
        key = _normalize(str(keyword))
        if key and key not in seen:
            seen.add(key)
            deduped.append(keyword)

    buckets: Dict[str, List[str]] = {
        "required": [],
        "preferred": [],
        "unclassified": [],
    }
    items: List[Dict[str, Any]] = []

    for keyword in deduped:
        occurrences: List[Dict[str, str]] = []
        kinds = set()
        for hit in _phrase_pattern(str(keyword)).finditer(text):
            active = None
            for event in events:
                if event[0] > hit.start():
                    break
                active = event
            kind = active[2] if active is not None else "unclassified"
            kinds.add(kind)
            occurrences.append({
                "classification": kind,
                "marker": active[3] if active is not None else "",
                "excerpt": _context(text, hit.start(), hit.end()),
            })

        if "required" in kinds:
            classification = "required"
        elif "preferred" in kinds:
            classification = "preferred"
        else:
            classification = "unclassified"

        buckets[classification].append(keyword)
        items.append({
            "keyword": keyword,
            "classification": classification,
            "jd_evidence": occurrences,
        })

    return {
        **buckets,
        "items": items,
    }


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
    jd_norm = _normalize(_strip_non_role_boilerplate(jd_text))
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

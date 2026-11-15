"""One evidence check: does this text show this skill? (audit R2, R3, R13/D3)

Every place that decides "the resume shows X" or "the posting asks for X"
asks here: the tailor's audit, gaps, reordering, emphasis and page fit, and
the posting classifier. src/resume/evidence.js is the same check for the
scorer and the dashboard, driven by the same rules (evidence_rules.json) and
held to the same cases (tests/shared/evidence_cases.json).

What it fixes:
  * Everyday words were skills. "-" and "&" counted as word boundaries, so
    "go-live" was Go, "R&D" was R and "I excel at" was Excel (R2). An everyday
    term now counts only in a skills list, next to another technology, or
    beside one of its anchor words ("Microsoft Excel"), and R and C must be
    capitals.
  * A plural was a gap. "Built data pipelines" did not evidence "data
    pipeline" (R3). The last word of a term may now be plural (s, es, y→ies),
    except for everyday terms ("goes" is not Go).

The check is deliberately literal: it never infers a skill from a related one.
That is what evidence aliases are for, and they are applied by the caller.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Dict, Iterable, List, Sequence, Tuple

_RULES = json.loads((Path(__file__).with_name("evidence_rules.json")).read_text(encoding="utf-8"))

EVERYDAY = frozenset(_RULES["everydayTerms"])
ANCHORS: Dict[str, frozenset] = {k: frozenset(v) for k, v in _RULES["anchors"].items()}
TECHNOLOGIES = frozenset(_RULES["technologies"])
_CREDENTIAL_RE = re.compile(r"\b(?:" + "|".join(map(re.escape, _RULES["credentialWords"])) + r")\b")

# Characters that glue a word into something else: "go-live", "R&D", "C++", "C#".
_JOINERS = r"\-&'’@+#"
# What separates the items of a list, in a skills line or a sentence.
_SEPARATOR_RE = re.compile(r"[,;|•·/]|\band\b|\bor\b|(?<=\s)&(?=\s)|(?<=\s)\+(?=\s)", re.IGNORECASE)
_LABEL_RE = re.compile(r"^\s*[^:,;|.]{1,40}:\s*")
# A sentence or line: context never reaches past one.
_SEGMENT_END_RE = re.compile(r"\n|[.!?](?=\s|$)|•")
_JOIN_LEFT_RE = re.compile(r"\s*(?:,|/|;|\||&|\+|\band\b|\bor\b)\s*$", re.IGNORECASE)
_JOIN_RIGHT_RE = re.compile(r"^\s*(?:,|/|;|\||&|\+|\band\b|\bor\b)\s*", re.IGNORECASE)
_PREV_WORD_RE = re.compile(r"([A-Za-z0-9+#]+)[ \t]+$")
_NEXT_WORD_RE = re.compile(r"^[ \t]+([A-Za-z0-9+#]+)")
_ITEM_LEAD = " \t([\"'"
_ITEM_TRIM_RE = re.compile(r"^[\s(\[\"']+|[\s.;:!?)\]\"']+$")
# A qualifier or version after the item: "Excel (advanced)", "Python 3.11".
_ITEM_SUFFIX_RE = re.compile(r"(?<=\S)\s*\([^)]*\)\s*$|\s+v?\d+(?:\.\d+)*\s*$")


def _trim_item(piece: str) -> Tuple[int, str]:
    """An item without its qualifier, punctuation and padding, and where it starts in ``piece``."""
    bare = _ITEM_SUFFIX_RE.sub("", piece)
    return len(bare) - len(bare.lstrip(_ITEM_LEAD)), _ITEM_TRIM_RE.sub("", bare)


def normalize(term: str) -> str:
    return re.sub(r"\s+", " ", str(term or "").strip().lower())


def is_everyday(term: str) -> bool:
    """A skill that is also an ordinary word, or a single letter."""
    key = normalize(term)
    return key in EVERYDAY or (len(key) == 1 and key.isalpha())


def _body(key: str, *, plural: bool) -> str:
    words = key.split(" ")
    body = r"\s+".join(re.escape(w) for w in words)
    last = words[-1]
    if not plural or len(last) < 3 or not last.isalpha():
        return body
    if last.endswith("y") and len(last) > 3 and last[-2] not in "aeiou":
        return body[:-1] + "(?:y|ies)"
    if last.endswith("s"):
        return body
    return body + "(?:es|s)?"


_PATTERNS: Dict[str, re.Pattern] = {}


def pattern(term: str) -> re.Pattern:
    """Where the term's words occur, before any context rule is applied."""
    key = normalize(term)
    cached = _PATTERNS.get(key)
    if cached is not None:
        return cached
    everyday = is_everyday(key)
    body = _body(key, plural=not everyday)
    if everyday:
        compiled = re.compile(rf"(?<![a-z0-9{_JOINERS}]){body}(?![a-z0-9{_JOINERS}])(?!\.[a-z0-9])", re.IGNORECASE)
    else:
        compiled = re.compile(rf"(?<![a-z0-9]){body}(?![a-z0-9])", re.IGNORECASE)
    _PATTERNS[key] = compiled
    return compiled


def _neighbours(vocabulary: Iterable[str], term_key: str) -> List[str]:
    found = {normalize(v) for v in vocabulary if normalize(v)} | TECHNOLOGIES
    return sorted((t for t in found if t != term_key and not is_everyday(t)), key=len, reverse=True)


def _starts_with_any(text: str, terms: Sequence[str]) -> bool:
    return any(re.match(rf"{_body(t, plural=True)}(?![a-z0-9])", text, re.IGNORECASE) for t in terms)


def _ends_with_any(text: str, terms: Sequence[str]) -> bool:
    return any(re.search(rf"(?<![a-z0-9]){_body(t, plural=True)}$", text, re.IGNORECASE) for t in terms)


def _segment(text: str, start: int, end: int) -> Tuple[int, int]:
    """The sentence or line holding [start, end)."""
    seg_start = 0
    for hit in _SEGMENT_END_RE.finditer(text, 0, start):
        seg_start = hit.end()
    nxt = _SEGMENT_END_RE.search(text, end)
    return seg_start, (nxt.start() if nxt else len(text))


def _items(text: str, seg_start: int, seg_end: int) -> Tuple[bool, List[Tuple[int, int]]]:
    """A segment's list items as trimmed spans, and whether it opens with a label."""
    segment = text[seg_start:seg_end]
    label = _LABEL_RE.match(segment)
    offset = label.end() if label else 0
    bounds = []
    cursor = offset
    for sep in _SEPARATOR_RE.finditer(segment, offset):
        bounds.append((cursor, sep.start()))
        cursor = sep.end()
    bounds.append((cursor, len(segment)))
    spans = []
    for left, right in bounds:
        lead, trimmed = _trim_item(segment[left:right])
        if not trimmed:
            continue
        spans.append((seg_start + left + lead, seg_start + left + lead + len(trimmed)))
    return bool(label), spans


def _counts(term_key: str, text: str, start: int, end: int, vocabulary: Iterable[str]) -> bool:
    """Context rule for an everyday term: an anchor, a neighbouring technology, or a list item."""
    if len(term_key) == 1 and text[start:end] != text[start:end].upper():
        return False
    anchors = ANCHORS.get(term_key, frozenset())
    before = _PREV_WORD_RE.search(text[:start])
    after = _NEXT_WORD_RE.match(text[end:])
    if (before and before.group(1).lower() in anchors) or (after and after.group(1).lower() in anchors):
        return True
    seg_start, seg_end = _segment(text, start, end)
    techs = _neighbours(vocabulary, term_key)
    right = _JOIN_RIGHT_RE.match(text[end:seg_end])
    if right and _starts_with_any(text[end + right.end():seg_end], techs):
        return True
    left = _JOIN_LEFT_RE.search(text[seg_start:start])
    if left and _ends_with_any(text[seg_start:seg_start + left.start()], techs):
        return True
    labelled, spans = _items(text, seg_start, seg_end)
    if (start, end) not in spans:
        return False
    others = [text[a:b] for a, b in spans if (a, b) != (start, end)]
    return labelled or any(normalize(o) in techs for o in others)


def occurrences(
    term: str, text: str, *, vocabulary: Iterable[str] = (), in_list: bool = False,
) -> List[Tuple[int, int]]:
    """Spans of ``text`` that evidence ``term``, in order. Empty means no evidence.

    ``in_list`` says ``text`` is one item of a skills list the caller already
    found (a competency cell or "Label: a, b" item): an everyday term then
    counts when it is the whole item, qualifier aside ("Excel (advanced)").
    """
    key = normalize(term)
    if not key or not text:
        return []
    everyday = is_everyday(key)
    vocabulary = tuple(vocabulary)
    found = []
    for hit in pattern(key).finditer(text):
        if everyday:
            if in_list:
                _lead, whole = _trim_item(text)
                capital = len(key) > 1 or hit.group(0) == hit.group(0).upper()
                if not (capital and normalize(whole) == normalize(hit.group(0))):
                    continue
            elif not _counts(key, text, hit.start(), hit.end(), vocabulary):
                continue
        found.append((hit.start(), hit.end()))
    return found


def shows(term: str, text: str, *, vocabulary: Iterable[str] = (), in_list: bool = False) -> bool:
    return bool(occurrences(term, text, vocabulary=vocabulary, in_list=in_list))


def find_evidence(
    term: str,
    lines: Sequence[str],
    *,
    aliases: Dict[str, Sequence[str]] | None = None,
    vocabulary: Iterable[str] = (),
    limit: int = 1,
) -> List[Dict[str, str]]:
    """The first line evidencing ``term`` or each of its aliases, up to ``limit``."""
    alias_map = {normalize(k): list(v or []) for k, v in (aliases or {}).items()}
    key = normalize(term)
    found: List[Dict[str, str]] = []
    seen = set()
    vocabulary = tuple(vocabulary)
    # "RN license", "CPA certification": the credential is the evidence, not the
    # paperwork word around it, so the bare credential is tried last.
    core = normalize(_CREDENTIAL_RE.sub(" ", key))
    for candidate in [term, *alias_map.get(key, []), *([core] if core and core != key else [])]:
        ckey = normalize(candidate)
        if not ckey or ckey in seen:
            continue
        seen.add(ckey)
        for line in lines:
            clean = re.sub(r"\s+", " ", str(line or "")).strip()
            if clean and shows(candidate, clean, vocabulary=vocabulary):
                found.append({"matched_term": str(candidate), "resume_text": clean[:300]})
                break
        if len(found) >= limit:
            break
    return found

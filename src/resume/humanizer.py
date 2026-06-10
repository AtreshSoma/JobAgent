"""Deterministic text humanizer (Python side, for resume text).

Mirrors src/apply/humanizer.js. Applies config/humanizer_patterns.json:
removes banned phrases, replaces banned characters (em/en dashes, smart quotes),
collapses exclamation marks, and normalizes whitespace. It never invents
content; it only cleans text that already exists.
"""
from __future__ import annotations

import re
from typing import Any, Dict


def humanize(text: str, patterns: Dict[str, Any]) -> str:
    """Clean ``text`` according to the humanizer ``patterns`` config."""
    if not isinstance(text, str):
        return ""
    out = text

    for src, dst in (patterns.get("characterReplacements") or {}).items():
        out = out.replace(src, dst)

    for ch in patterns.get("bannedCharacters") or []:
        out = out.replace(ch, "")

    for phrase in patterns.get("bannedPhrases") or []:
        if not phrase:
            continue
        out = re.sub(re.escape(phrase), "", out, flags=re.IGNORECASE)

    rules = patterns.get("rules") or {}
    if rules.get("collapseExclamation", True):
        out = re.sub(r"!+", ".", out)
    if rules.get("normalizeWhitespace", True):
        out = re.sub(r"[ \t]+", " ", out)
        out = re.sub(r" *\n *", "\n", out)
        out = re.sub(r"\n{3,}", "\n\n", out)
        out = re.sub(r" +([.,;:])", r"\1", out)
        out = out.strip()
    return out


def has_banned_content(text: str, patterns: Dict[str, Any]) -> bool:
    """Return True if any banned phrase or character remains in ``text``."""
    lower = (text or "").lower()
    for ch in patterns.get("bannedCharacters") or []:
        if ch in text:
            return True
    for phrase in patterns.get("bannedPhrases") or []:
        if phrase and phrase.lower() in lower:
            return True
    return False

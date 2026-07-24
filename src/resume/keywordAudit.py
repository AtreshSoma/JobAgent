"""Resume keyword audit.

Reads the master resume (.docx) and reports which job keywords are already
present and which are missing. Used to (a) surface honest tailoring gaps and
(b) feed the deterministic resume tailor. It never invents skills.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Dict, Iterable, List, Mapping, Sequence


def read_docx_text(path: str | Path) -> str:
    """Extract all text (paragraphs + tables) from a .docx file."""
    from docx import Document  # imported lazily so non-docx tests still run

    document = Document(str(path))
    parts: List[str] = [p.text for p in document.paragraphs]
    for table in document.tables:
        for row in table.rows:
            for cell in row.cells:
                parts.append(cell.text)
    return "\n".join(parts)


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").lower()).strip()


def _phrase_pattern(phrase: str) -> re.Pattern:
    """Boundary-aware matcher so short skills do not match inside other words."""
    escaped = re.escape(_normalize(phrase))
    return re.compile(rf"(?<![a-z0-9]){escaped}(?![a-z0-9])", re.IGNORECASE)


def _evidence_terms(
    keyword: str,
    evidence_aliases: Mapping[str, Sequence[str]] | None,
) -> List[str]:
    aliases = {
        _normalize(term): list(values or [])
        for term, values in (evidence_aliases or {}).items()
    }
    result: List[str] = []
    seen = set()
    for term in [keyword, *aliases.get(_normalize(keyword), [])]:
        key = _normalize(term)
        if key and key not in seen:
            seen.add(key)
            result.append(str(term))
    return result


def audit_keywords(
    resume_text: str,
    keywords: Iterable[str],
    *,
    evidence_aliases: Mapping[str, Sequence[str]] | None = None,
) -> Dict[str, List[str]]:
    """Split ``keywords`` into those present vs. missing in ``resume_text``.

    Matching is case-insensitive and boundary-aware. Configured evidence aliases
    can support a JD term (for example, PySpark supports Spark) without claiming
    that genuinely absent technologies are present.
    """
    haystack = _normalize(resume_text)
    present: List[str] = []
    missing: List[str] = []
    seen = set()
    for kw in keywords:
        key = _normalize(kw)
        if not key or key in seen:
            continue
        seen.add(key)
        supported = any(
            _phrase_pattern(term).search(haystack)
            for term in _evidence_terms(str(kw), evidence_aliases)
        )
        (present if supported else missing).append(kw)
    return {"present": present, "missing": missing}


def audit_resume(resume_path: str | Path, keywords: Iterable[str]) -> Dict[str, List[str]]:
    """Convenience wrapper: read the resume then audit keywords."""
    return audit_keywords(read_docx_text(resume_path), keywords)

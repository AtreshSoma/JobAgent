"""Resume keyword audit.

Reads the master resume (.docx) and reports which job keywords are already
present and which are missing. Used to (a) surface honest tailoring gaps and
(b) feed the deterministic resume tailor. It never invents skills.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Dict, Iterable, List


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


def audit_keywords(resume_text: str, keywords: Iterable[str]) -> Dict[str, List[str]]:
    """Split ``keywords`` into those present vs. missing in ``resume_text``.

    Matching is case-insensitive, whitespace-normalized substring matching.
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
        (present if key in haystack else missing).append(kw)
    return {"present": present, "missing": missing}


def audit_resume(resume_path: str | Path, keywords: Iterable[str]) -> Dict[str, List[str]]:
    """Convenience wrapper: read the resume then audit keywords."""
    return audit_keywords(read_docx_text(resume_path), keywords)

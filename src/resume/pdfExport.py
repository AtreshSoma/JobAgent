"""Optional PDF export for tailored resumes.

Uses ``docx2pdf`` (which relies on Microsoft Word on Windows / macOS). PDF export
is best-effort: if the dependency or Word is unavailable, this returns a result
with ``exported=False`` and a reason instead of raising, so the pipeline keeps
working in DRY_RUN / headless environments.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Dict


def pdf_page_count(pdf_path: str | Path) -> int | None:
    """Count pages in a PDF without a PDF library.

    The tailor keeps résumés inside a page budget using a geometry ESTIMATE,
    because Word is optional here. Whenever a PDF does get produced we can
    report the true number instead, so the packet states a measured fact rather
    than a prediction. Returns None if the file cannot be read.

    Reads the page-tree ``/Count`` (authoritative, one per document) and falls
    back to counting ``/Type /Page`` objects for writers that omit it.
    """
    try:
        data = Path(pdf_path).read_bytes()
    except OSError:
        return None
    counts = [int(match.group(1)) for match in re.finditer(rb"/Count\s+(\d+)", data)]
    if counts:
        return max(counts)
    pages = len(re.findall(rb"/Type\s*/Page[^s]", data))
    return pages or None


def export_to_pdf(docx_path: str | Path, pdf_path: str | Path | None = None) -> Dict[str, Any]:
    """Convert ``docx_path`` to PDF. Returns ``{exported, pdf_path, pages, reason}``."""
    docx_path = Path(docx_path)
    if not docx_path.exists():
        return {"exported": False, "pdf_path": None, "pages": None, "reason": f"missing docx: {docx_path}"}

    if pdf_path is None:
        pdf_path = docx_path.with_suffix(".pdf")
    pdf_path = Path(pdf_path)

    try:
        from docx2pdf import convert  # noqa: WPS433 (lazy, optional dependency)
    except Exception as err:  # pragma: no cover - environment dependent
        return {"exported": False, "pdf_path": None, "pages": None, "reason": f"docx2pdf unavailable: {err}"}

    try:
        convert(str(docx_path), str(pdf_path))
    except Exception as err:  # pragma: no cover - requires Word
        return {"exported": False, "pdf_path": None, "pages": None, "reason": f"conversion failed: {err}"}

    return {
        "exported": True,
        "pdf_path": str(pdf_path),
        "pages": pdf_page_count(pdf_path),
        "reason": "ok",
    }

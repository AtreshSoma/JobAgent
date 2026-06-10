"""Optional PDF export for tailored resumes.

Uses ``docx2pdf`` (which relies on Microsoft Word on Windows / macOS). PDF export
is best-effort: if the dependency or Word is unavailable, this returns a result
with ``exported=False`` and a reason instead of raising, so the pipeline keeps
working in DRY_RUN / headless environments.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Dict


def export_to_pdf(docx_path: str | Path, pdf_path: str | Path | None = None) -> Dict[str, Any]:
    """Convert ``docx_path`` to PDF. Returns ``{exported, pdf_path, reason}``."""
    docx_path = Path(docx_path)
    if not docx_path.exists():
        return {"exported": False, "pdf_path": None, "reason": f"missing docx: {docx_path}"}

    if pdf_path is None:
        pdf_path = docx_path.with_suffix(".pdf")
    pdf_path = Path(pdf_path)

    try:
        from docx2pdf import convert  # noqa: WPS433 (lazy, optional dependency)
    except Exception as err:  # pragma: no cover - environment dependent
        return {"exported": False, "pdf_path": None, "reason": f"docx2pdf unavailable: {err}"}

    try:
        convert(str(docx_path), str(pdf_path))
    except Exception as err:  # pragma: no cover - requires Word
        return {"exported": False, "pdf_path": None, "reason": f"conversion failed: {err}"}

    return {"exported": True, "pdf_path": str(pdf_path), "reason": "ok"}

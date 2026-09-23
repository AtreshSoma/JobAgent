"""Optional PDF export for tailored resumes.

Two converters, tried in order:

1. ``docx2pdf``, which drives Microsoft Word (Windows / macOS only).
2. LibreOffice (``soffice --convert-to pdf``), which works everywhere including
   Linux and CI.

The second one exists because the first can never succeed on Linux, and
``resumeExportPdf`` defaults to ON — so on any machine without Word (this
includes CI and most Linux desktops) every export failed, silently, and the
dashboard's preview route turned that into an unexplained error. A missing
converter is now a reported, actionable condition rather than a dead end.

Export remains best-effort: with no converter at all this returns
``exported=False`` and a reason instead of raising, so the pipeline keeps working
headless and the DOCX — which is always produced — stays the deliverable.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict


# Where Microsoft Word installs itself on Windows.
_WORD_WINDOWS_PATHS = (
    r"C:\Program Files\Microsoft Office\root\Office16\WINWORD.EXE",
    r"C:\Program Files (x86)\Microsoft Office\root\Office16\WINWORD.EXE",
    r"C:\Program Files\Microsoft Office\Office16\WINWORD.EXE",
    r"C:\Program Files (x86)\Microsoft Office\Office16\WINWORD.EXE",
)

# Where LibreOffice installs itself when it is not on PATH.
_SOFFICE_FALLBACK_PATHS = (
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/usr/bin/soffice",
    "/usr/local/bin/soffice",
    "/opt/libreoffice/program/soffice",
    r"C:\Program Files\LibreOffice\program\soffice.exe",
)


def find_soffice() -> str | None:
    """Absolute path to a LibreOffice binary, or None."""
    found = shutil.which("soffice") or shutil.which("libreoffice")
    if found:
        return found
    for path in _SOFFICE_FALLBACK_PATHS:
        if Path(path).exists():
            return path
    return None


def converter_availability() -> Dict[str, Any]:
    """Which DOCX-to-PDF converters this machine can actually use.

    Reported by ``doctor`` so "PDF export is on but cannot work here" is visible
    up front instead of surfacing as a failed preview later.
    """
    word = False
    word_reason = ""
    try:
        import docx2pdf  # noqa: F401,WPS433
    except Exception as err:  # noqa: BLE001
        word_reason = f"docx2pdf unavailable: {err}"
    else:
        # The PACKAGE importing proves nothing: docx2pdf installs on any
        # platform and then fails at call time without a real Word install.
        # Reporting "available" on that basis is the same presence-vs-capability
        # mistake the preview route used to make, so look for Word itself.
        if os.name == "nt":
            word = any(Path(p).exists() for p in _WORD_WINDOWS_PATHS)
            if not word:
                word_reason = "Microsoft Word not found in Program Files"
        elif os.uname().sysname == "Darwin":
            word = Path("/Applications/Microsoft Word.app").exists()
            if not word:
                word_reason = "Microsoft Word is not installed"
        else:
            word_reason = "docx2pdf needs Microsoft Word, which does not run on this platform"

    soffice = find_soffice()
    return {
        "available": bool(word or soffice),
        "word": word,
        "word_reason": word_reason,
        "libreoffice": soffice,
    }


# Hard per-converter limits, in seconds. Their SUM must stay below the budget
# Node allows a Python helper for PDF export (PYTHON_PDF_BUDGET_SECONDS in
# src/resume/pythonEnv.js, 180 s): LibreOffice was allowed 120 s while Node
# killed the whole tailor at 60 s, so a slow conversion lost the DOCX result
# too; and docx2pdf had no limit at all, so a Word stuck on a dialog hung the
# tailor until Node killed it.
DOCX2PDF_TIMEOUT_S = 90
LIBREOFFICE_TIMEOUT_S = 90


def _export_with_word(docx_path: Path, pdf_path: Path, timeout: int = DOCX2PDF_TIMEOUT_S) -> str | None:
    """Convert via docx2pdf in a CHILD interpreter so the call can time out.

    Returns None on success, else the reason it failed.
    """
    code = "import sys; from docx2pdf import convert; convert(sys.argv[1], sys.argv[2])"
    try:
        proc = subprocess.run(  # noqa: S603
            [sys.executable, "-c", code, str(docx_path), str(pdf_path)],
            capture_output=True, text=True, timeout=timeout, check=False,
        )
    except subprocess.TimeoutExpired:
        return f"Word conversion timed out after {timeout}s"
    except Exception as err:  # noqa: BLE001
        return f"Word conversion could not start: {err}"
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip().splitlines()
        return f"Word conversion failed: {detail[-1][:200] if detail else f'exit {proc.returncode}'}"
    return None if pdf_path.exists() else "Word reported success but wrote no PDF"


def _export_with_libreoffice(docx_path: Path, pdf_path: Path, timeout: int = LIBREOFFICE_TIMEOUT_S) -> Dict[str, Any]:
    """Convert via LibreOffice headless.

    ``--convert-to`` always writes ``<stem>.pdf`` into ``--outdir`` and offers no
    way to name the file, so it converts into a scratch directory and the result
    is moved to the requested path.
    """
    soffice = find_soffice()
    if not soffice:
        return {"exported": False, "pdf_path": None, "pages": None, "reason": "LibreOffice not found"}

    with tempfile.TemporaryDirectory(prefix="jobagent-pdf-") as scratch:
        try:
            proc = subprocess.run(  # noqa: S603
                [soffice, "--headless", "--convert-to", "pdf", "--outdir", scratch, str(docx_path)],
                capture_output=True, text=True, timeout=timeout, check=False,
            )
        except subprocess.TimeoutExpired:
            return {"exported": False, "pdf_path": None, "pages": None,
                    "reason": f"LibreOffice conversion timed out after {timeout}s"}
        except Exception as err:  # noqa: BLE001
            return {"exported": False, "pdf_path": None, "pages": None,
                    "reason": f"LibreOffice could not start: {err}"}

        produced = Path(scratch) / (docx_path.stem + ".pdf")
        if not produced.exists():
            detail = (proc.stderr or proc.stdout or "").strip()[:200] or f"exit {proc.returncode}"
            return {"exported": False, "pdf_path": None, "pages": None,
                    "reason": f"LibreOffice produced no PDF ({detail})"}

        pdf_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(produced), str(pdf_path))

    return {"exported": True, "pdf_path": str(pdf_path), "pages": pdf_page_count(pdf_path), "reason": "ok (LibreOffice)"}


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

    # 1. Word via docx2pdf. Best fidelity, but Windows/macOS only AND it needs a
    #    real Word installation, not just the package.
    word_reason = None
    try:
        import docx2pdf  # noqa: F401,WPS433 (lazy, optional dependency)
    except Exception as err:  # pragma: no cover - environment dependent
        word_reason = f"docx2pdf unavailable: {err}"
    else:
        word_reason = _export_with_word(docx_path, pdf_path)  # pragma: no cover - requires Word
        if word_reason is None:
            return {
                "exported": True,
                "pdf_path": str(pdf_path),
                "pages": pdf_page_count(pdf_path),
                "reason": "ok (Word)",
            }

    # 2. LibreOffice. The only converter that can work on Linux/CI, and the
    #    reason this function is no longer a guaranteed failure there.
    fallback = _export_with_libreoffice(docx_path, pdf_path)
    if fallback["exported"]:
        return fallback

    # Neither worked: say so precisely, and name the remedy. The DOCX is already
    # written, so this degrades the preview, never the deliverable.
    return {
        "exported": False,
        "pdf_path": None,
        "pages": None,
        "reason": (
            f"no DOCX-to-PDF converter available ({word_reason}; {fallback['reason']}). "
            "Install Microsoft Word or LibreOffice, or use the DOCX."
        ),
    }

"""One-off maintenance: strip the legacy per-job focus line from generated resumes.

Removes any paragraph that begins with "Most relevant to this role" from every
generated .docx under applications/output and resumes/output, then re-exports a
PDF for each changed docx that already had a .pdf sibling.

The master resume (resumes/base/MASTER_RESUME.docx) is never touched.

Usage:
    python scripts/strip_focus_line.py            # dry-run (report only)
    python scripts/strip_focus_line.py --apply     # rewrite files in place
"""
from __future__ import annotations

import sys
from pathlib import Path

# Make src/resume importable for the optional PDF re-export.
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src" / "resume"))

FOCUS_PREFIX = "most relevant to this role"
SCAN_DIRS = ("applications/output", "resumes/output")
SKIP = {(ROOT / "resumes" / "base" / "MASTER_RESUME.docx").resolve()}


def _norm(text: str) -> str:
    return " ".join((text or "").split()).strip().lower()


def strip_focus_paragraphs(doc) -> int:
    """Delete paragraphs that start with the focus prefix. Returns count removed."""
    removed = 0
    for para in list(doc.paragraphs):
        if _norm(para.text).startswith(FOCUS_PREFIX):
            element = para._element  # noqa: SLF001 - python-docx low-level removal
            element.getparent().remove(element)
            removed += 1
    return removed


def find_docx() -> list[Path]:
    files: list[Path] = []
    for rel in SCAN_DIRS:
        base = ROOT / rel
        if base.exists():
            files.extend(base.rglob("*.docx"))
    return [f for f in files if f.resolve() not in SKIP]


def main() -> int:
    apply = "--apply" in sys.argv[1:]
    from docx import Document  # noqa: WPS433 - optional dependency, lazy import

    changed: list[Path] = []
    scanned = 0
    for docx_path in find_docx():
        scanned += 1
        try:
            doc = Document(str(docx_path))
        except Exception as err:  # pragma: no cover - corrupt/locked file
            print(f"SKIP (unreadable): {docx_path} -> {err}")
            continue
        removed = strip_focus_paragraphs(doc)
        if removed:
            rel = docx_path.relative_to(ROOT)
            if apply:
                doc.save(str(docx_path))
                changed.append(docx_path)
                print(f"CLEANED ({removed} line removed): {rel}")
            else:
                print(f"WOULD CLEAN ({removed} line): {rel}")

    pdf_done = 0
    pdf_failed = 0
    if apply and changed:
        from pdfExport import export_to_pdf  # noqa: WPS433 - lazy optional import

        for docx_path in changed:
            pdf_path = docx_path.with_suffix(".pdf")
            if pdf_path.exists():
                result = export_to_pdf(docx_path, pdf_path)
                if result.get("exported"):
                    pdf_done += 1
                else:
                    pdf_failed += 1
                    print(f"PDF re-export skipped: {pdf_path.relative_to(ROOT)} -> {result.get('reason')}")

    verb = "Cleaned" if apply else "Would clean"
    print("\n--- summary ---")
    print(f"docx scanned:   {scanned}")
    print(f"{verb}:        {len(changed) if apply else '(dry-run, see WOULD CLEAN above)'}")
    if apply:
        print(f"PDFs re-exported: {pdf_done}")
        if pdf_failed:
            print(f"PDFs not re-exported (Word/docx2pdf unavailable): {pdf_failed}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

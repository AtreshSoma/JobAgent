"""Strip the legacy focus line from resumes whose paths exceed Windows MAX_PATH.

python-docx cannot open files at paths longer than 260 chars on Windows. This
copies each long-path docx to a short temp path, strips the focus line there,
copies it back (using the \\?\ extended-length prefix so the write succeeds),
and re-exports a PDF if a .pdf sibling exists.
"""
from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src" / "resume"))

FOCUS_PREFIX = "most relevant to this role"

LONG_FILES = [
    r"applications\output\Deloitte\ConvergeHEALTH - Data Operations Engineer, Expert Services-Innovation_Delivery_Transformation_2026-06-07\Atresh_Somayajula_Resume_ConvergeHEALTH_Data_Operations_Engineer_Expert_Services_Innovation_Delivery_Transformation.docx",
    r"applications\output\Neon IT Solutions\Only W2 W2 Senior Health care Data engineer GCP and Azure (BigQuery, SQL Server) – REMOTE REMOTE_2026-06-05\Atresh_Somayajula_Resume_Only_W2_W2_Senior_Health_care_Data_engineer_GCP_and_Azure_BigQuery_SQL_Server_REMOTE_REMOTE.docx",
    r"applications\output\Neon IT Solutions\Only W2 W2 Senior Health care Data engineer GCP and Azure (BigQuery, SQL Server) – REMOTE REMOTE_2026-06-06\Atresh_Somayajula_Resume_Only_W2_W2_Senior_Health_care_Data_engineer_GCP_and_Azure_BigQuery_SQL_Server_REMOTE_REMOTE.docx",
    r"applications\output\Neon IT Solutions\Only W2 W2 Senior Health care Data engineer GCP and Azure (BigQuery, SQL Server) – REMOTE REMOTE_2026-06-07\Atresh_Somayajula_Resume_Only_W2_W2_Senior_Health_care_Data_engineer_GCP_and_Azure_BigQuery_SQL_Server_REMOTE_REMOTE.docx",
]


def _norm(text: str) -> str:
    return " ".join((text or "").split()).strip().lower()


def _ext(path: Path) -> str:
    """Extended-length path so Windows APIs accept >260-char paths."""
    s = str(path)
    return s if s.startswith("\\\\?\\") else "\\\\?\\" + s


def main() -> int:
    from docx import Document  # lazy optional import

    changed = []
    for rel in LONG_FILES:
        src = ROOT / rel
        if not Path(_ext(src)).exists():
            print(f"MISSING: {rel}")
            continue
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td) / "r.docx"
            shutil.copyfile(_ext(src), tmp)
            doc = Document(str(tmp))
            removed = sum(
                1 for p in list(doc.paragraphs) if _norm(p.text).startswith(FOCUS_PREFIX)
            )
            if not removed:
                print(f"ALREADY CLEAN: {rel}")
                continue
            for p in list(doc.paragraphs):
                if _norm(p.text).startswith(FOCUS_PREFIX):
                    p._element.getparent().remove(p._element)
            doc.save(str(tmp))
            # Copy back over the long-path original.
            with open(tmp, "rb") as fh, open(_ext(src), "wb") as out:
                out.write(fh.read())
            changed.append(src)
            print(f"CLEANED ({removed} line): {rel}")

    # Re-export PDFs for changed files that have a .pdf sibling.
    if changed:
        from pdfExport import export_to_pdf

        for src in changed:
            pdf = src.with_suffix(".pdf")
            if Path(_ext(pdf)).exists():
                result = export_to_pdf(_ext(src), _ext(pdf))
                status = "ok" if result.get("exported") else result.get("reason")
                print(f"PDF re-export: {pdf.name} -> {status}")

    print(f"\nCleaned {len(changed)} long-path resume(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

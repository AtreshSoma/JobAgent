"""Deterministic resume tailoring.

Produces a per-job tailored copy of the master resume WITHOUT inventing any
content. The master file is opened read-only (we never call ``save`` on it).

Tailoring actions (all honest, content-preserving):
  1. Emphasize (bold) existing runs that mention a matched job keyword.
  2. Optionally insert a "most relevant to this role" line built ONLY from
     keywords that are both requested by the job AND already present in the
     resume. It is anchored just above the CORE COMPETENCIES / PROFESSIONAL
     SUMMARY heading so ATS parsers see the job's own terminology up top.
  3. Save the result to a per-job .docx in the job's output folder.

If a keyword is requested but missing from the resume, it is reported as a gap
and is never added as a fabricated skill.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List

from humanizer import humanize
from keywordAudit import audit_keywords, read_docx_text


def _slug(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return slug or "untitled"


def _date_stamp(now: datetime | None = None) -> str:
    now = now or datetime.now(timezone.utc)
    return now.strftime("%Y%m%d")


def output_filename(company: str, title: str, now: datetime | None = None) -> str:
    return f"{_slug(company)}_{_slug(title)}_{_date_stamp(now)}.docx"


def _emphasize(document, keywords: List[str]) -> int:
    """Bold runs that contain a matched keyword. Returns count emphasized."""
    lowered = [k.lower() for k in keywords if k]
    count = 0
    for para in document.paragraphs:
        for run in para.runs:
            text = (run.text or "").lower()
            if text and any(k in text for k in lowered):
                run.bold = True
                count += 1
    return count


# Headings we prefer to anchor the per-job focus line above (in priority order).
# Placed just before the first match so the job's own terminology sits near the
# top of the resume, where ATS keyword parsers weigh it most.
_FOCUS_ANCHORS = ("core competencies", "professional summary", "professional experience")


def _norm_heading(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip().lower())


def _insert_focus_line(document, present: List[str], patterns: Dict[str, Any] | None) -> str:
    """Insert a per-job focus line built only from ``present`` keywords.

    The line is anchored above the first matching heading in ``_FOCUS_ANCHORS``
    (falling back to the top of the document). Returns the rendered text.
    """
    label = "Most relevant to this role"
    text = humanize(f"{label}: {', '.join(present)}.", patterns or {})

    anchor = None
    for para in document.paragraphs:
        if _norm_heading(para.text) in _FOCUS_ANCHORS:
            anchor = para
            break

    if anchor is not None:
        new_para = anchor.insert_paragraph_before()
    elif document.paragraphs:
        new_para = document.paragraphs[0].insert_paragraph_before()
    else:
        new_para = document.add_paragraph()

    # Bold the label, italicize the keyword list, so it reads as a deliberate
    # tailoring cue rather than body copy.
    head, sep, rest = text.partition(":")
    if sep:
        run_label = new_para.add_run(head + ":")
        run_label.bold = True
        run_kw = new_para.add_run(rest)
        run_kw.italic = True
    else:
        new_para.add_run(text).italic = True
    return text


def tailor_resume(
    master_path: str | Path,
    output_dir: str | Path,
    job: Dict[str, Any],
    keywords: Iterable[str],
    patterns: Dict[str, Any] | None = None,
    *,
    add_summary_line: bool = False,
    now: datetime | None = None,
    output_name: str | None = None,
) -> Dict[str, Any]:
    """Create a tailored resume for ``job`` and return a result dict.

    Returns ``{output_path, audit, emphasized, summary_line}``.
    Raises FileNotFoundError if the master is missing.
    """
    from docx import Document

    master_path = Path(master_path)
    if not master_path.exists():
        raise FileNotFoundError(f"Master resume not found: {master_path}")

    keywords = list(keywords)
    resume_text = read_docx_text(master_path)
    audit = audit_keywords(resume_text, keywords)

    # Open the master read-only: we load it, mutate the in-memory copy, and save
    # to a NEW path. The master file on disk is never written.
    document = Document(str(master_path))
    emphasized = _emphasize(document, audit["present"])

    summary_line = None
    if add_summary_line and audit["present"]:
        summary_line = _insert_focus_line(document, audit["present"], patterns)

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    filename = output_name or output_filename(
        job.get("company", "company"), job.get("title", "role"), now
    )
    output_path = output_dir / filename
    document.save(str(output_path))

    return {
        "output_path": str(output_path),
        "audit": audit,
        "emphasized": emphasized,
        "summary_line": summary_line,
    }

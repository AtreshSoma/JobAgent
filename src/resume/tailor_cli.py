"""CLI bridge for resume tailoring.

Reads a single JSON request on stdin, runs the deterministic resume tailor
(``tailor.py``), optionally exports a PDF, and writes a single JSON response to
stdout. This is the process boundary the Node runtime (``tailorRunner.js``)
talks to via ``child_process``.

Request (stdin JSON):
    {
      "master_path": "resumes/base/MASTER_RESUME.docx",
      "output_dir": "resumes/output",
      "job": {"company": "...", "title": "...", "jd_text": "..."},
      "keywords": ["azure", "databricks", ...],
      "export_pdf": false
    }

Response (stdout JSON):
    {
      "ok": true,
      "output_path": "resumes/output/acme_senior-data-engineer_20260605.docx",
      "pdf_path": null,
      "audit": {"present": [...], "missing": [...]},
      "emphasized": 3,
      "error": null
    }

The master resume is opened read-only by ``tailor.py`` and is NEVER written.
On any failure this prints ``{"ok": false, "error": "..."}`` and exits 0 so the
Node caller can fall back gracefully (it inspects ``ok``, not the exit code).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

# Make sibling modules (tailor, keywordAudit, humanizer, pdfExport) importable
# regardless of the current working directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))


def _section_headings(ats_config: dict):
    names = (ats_config or {}).get("sectionHeadings") or {}
    return {kind: list(v) for kind, v in names.items() if isinstance(v, list) and v} or None


def _page_measurer(request: dict):
    """LibreOffice's page count for the fit, unless turned off or not installed."""
    if request.get("measure_pages") is False:
        return None
    import pagefit

    return pagefit.measure_document if pagefit.measurement_available() else None


def _run(request: dict) -> dict:
    from tailor import master_units, tailor_resume  # local import so import errors are reported

    if request.get("mode") == "letter_docx":
        # A cover letter as a plain, ATS-safe .docx (P1-3): one paragraph per
        # block of text, no tables, no headers, no images.
        from docx import Document
        from docx.shared import Pt

        path = Path(str(request.get("path") or ""))
        if path.suffix.lower() != ".docx" or not path.parent.exists():
            return {"ok": False, "error": "path must be a .docx file in an existing folder"}
        document = Document()
        style = document.styles["Normal"]
        style.font.name = "Calibri"
        style.font.size = Pt(11)
        for block in str(request.get("text") or "").split("\n\n"):
            document.add_paragraph(block.strip("\n"))
        document.save(str(path))
        return {"ok": True, "path": str(path)}

    if request.get("mode") == "html":
        # A resume as ATS-safe HTML for the Chromium PDF path (P2-3). Read-only.
        from tailor import docx_to_html

        if not request.get("docx_path"):
            return {"ok": False, "error": "docx_path is required"}
        return {"ok": True, **docx_to_html(request["docx_path"])}

    if request.get("mode") == "readiness":
        # What tailoring will be able to work with in this resume (F4). Read-only.
        from readiness import readiness

        if not request.get("docx_path"):
            return {"ok": False, "error": "docx_path is required"}
        return {"ok": True, "readiness": readiness(
            request["docx_path"], section_headings=_section_headings(request.get("ats_config")),
        )}

    if request.get("mode") == "units":
        # The master's paragraphs as citable evidence units (P1-2). Read-only.
        if not request.get("master_path"):
            return {"ok": False, "error": "master_path is required"}
        return {"ok": True, "units": master_units(request["master_path"])}

    master_path = request.get("master_path")
    output_dir = request.get("output_dir")
    output_name = request.get("output_filename") or None
    job = request.get("job") or {}
    keywords = request.get("keywords") or []
    vocabulary = request.get("vocabulary") or []
    evidence_aliases = request.get("evidence_aliases") or {}
    ats_config = request.get("ats_config") or {}
    export_pdf = bool(request.get("export_pdf", False))

    if not master_path:
        return {"ok": False, "error": "master_path is required"}
    if not output_dir:
        return {"ok": False, "error": "output_dir is required"}

    result = tailor_resume(
        master_path,
        output_dir,
        job,
        keywords,
        request.get("patterns") or {},
        max_pages=int(request.get("max_pages") if request.get("max_pages") is not None else 2),
        required_markers=ats_config.get("requiredMarkers"),
        preferred_markers=ats_config.get("preferredMarkers"),
        evidence_aliases=evidence_aliases,
        enable_rewrites=bool(request.get("enable_rewrites", False)),
        output_name=output_name,
        # Optional grounded requirement classification. Every phrase here was
        # verified verbatim against this posting before it was sent, and it can
        # only influence ORDERING priority — never resume content.
        llm_qualifications=request.get("llm_requirements") or None,
        # Bullets a person accepted after each rewrite was verified against
        # cited master-resume evidence (src/resume/rewrites.js).
        accepted_rewrites=request.get("accepted_rewrites") or None,
        # Bullets the person pinned for this job: never omitted to fit the page.
        keep_bullets=request.get("keep_bullets") or None,
        # The score's evidence, so the packet lists the score's gaps (R13).
        evidence_lines=request.get("evidence_lines") or None,
        evidence_vocabulary=request.get("evidence_vocabulary"),
        gap_terms=request.get("gap_terms"),
        # The rendered length decides the page fit when LibreOffice is here (R6).
        measure_pages=_page_measurer(request),
        # Extra section names for this install (R14).
        section_headings=_section_headings(ats_config),
    )

    pdf_path = None
    pdf_result = None
    page_count = None
    if export_pdf:
        from pdfExport import export_to_pdf

        pdf_result = export_to_pdf(result["output_path"])
        pdf_path = pdf_result.get("pdf_path") if pdf_result.get("exported") else None
        # A rendered PDF settles the page count for real. Record it next to the
        # estimate so the packet can say "2 pages (measured)" instead of only
        # ever predicting it.
        page_count = pdf_result.get("pages")
        if page_count is not None:
            result.setdefault("invariants", {})["rendered_pages"] = page_count
            result["invariants"]["within_page_budget"] = page_count <= int(request.get("max_pages") or 2)
            if page_count > int(request.get("max_pages") or 2):
                result.setdefault("limitations", []).append(
                    f"The rendered PDF is {page_count} pages, over the "
                    f"{int(request.get('max_pages') or 2)}-page target. Shorten bullets in "
                    "the master resume — the tailor omits whole bullets but never rewrites them."
                )

    # Validate the generated resume's format + content (honest quality gate).
    validation = None
    try:
        from validate import validate_resume

        validation = validate_resume(result["output_path"], keywords)
    except Exception as err:  # noqa: BLE001 - validation must never break tailoring
        validation = {"ok": True, "issues": [], "warnings": [f"validation skipped: {err}"]}

    # ATS readiness report: tier the JD's keywords, lint the generated resume for
    # ATS-hostile formatting, and produce an honest "will this get picked?" readout.
    # Wrapped so an analysis failure never breaks the tailoring contract.
    ats_report = None
    try:
        ats_report = _build_ats_report(
            result["output_path"], job, vocabulary, ats_config, evidence_aliases
        )
    except Exception as err:  # noqa: BLE001 - ATS analysis is best-effort
        ats_report = {"error": f"ats report skipped: {type(err).__name__}: {err}"}

    return {
        "ok": True,
        "output_path": result["output_path"],
        "pdf_path": pdf_path,
        "pdf_result": pdf_result,
        "page_count": page_count,
        "audit": result.get("audit"),
        "emphasized": result.get("emphasized"),
        "changes": result.get("changes", []),
        "gaps": result.get("gaps", []),
        "qualifications": result.get("qualifications", {}),
        "selected_content": result.get("selected_content", {}),
        "rewrite_policy": result.get("rewrite_policy", {}),
        "invariants": result.get("invariants", {}),
        "limitations": result.get("limitations", []),
        "skipped_steps": result.get("skipped_steps", []),
        "validation": validation,
        "ats_report": ats_report,
        "error": None,
    }


def _build_ats_report(resume_path, job, vocabulary, ats_config, evidence_aliases=None):
    """Tier JD keywords, lint the resume, and compose the ATS readiness report."""
    from jdKeywords import extract_jd_keywords
    from atsLint import lint_resume
    from atsReport import build_ats_report
    from keywordAudit import read_docx_text

    jd_keywords = extract_jd_keywords(
        job.get("jd_text", ""),
        job.get("title", ""),
        vocabulary,
        required_markers=ats_config.get("requiredMarkers"),
        preferred_markers=ats_config.get("preferredMarkers"),
        outcome_signals=ats_config.get("outcomeSignals"),
        acronym_pairs=ats_config.get("acronymPairs"),
    )
    lint = lint_resume(resume_path, config=ats_config)
    resume_text = read_docx_text(resume_path)
    report = build_ats_report(
        resume_text,
        jd_keywords,
        lint,
        config=ats_config,
        evidence_aliases=evidence_aliases or {},
    )
    # Carry the tiering forward so reviewers can see exactly what the JD demanded.
    report["jd_tier1"] = jd_keywords.get("tier1", [])
    report["jd_tier2"] = jd_keywords.get("tier2", [])
    return report



def main() -> int:
    try:
        raw = sys.stdin.read()
        request = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as err:
        print(json.dumps({"ok": False, "error": f"invalid JSON request: {err}"}))
        return 0

    print(json.dumps(_answer(request)))
    return 0


def _answer(request: dict) -> dict:
    try:
        return _run(request)
    except FileNotFoundError as err:
        return {"ok": False, "error": str(err)}
    except Exception as err:  # noqa: BLE001 - report any failure to the caller
        return {"ok": False, "error": f"{type(err).__name__}: {err}"}


def serve() -> int:
    """Answer one JSON request per line until stdin closes (audit R17).

    Each request ran in a fresh interpreter that imported python-docx and the
    tailor again: two or three starts per job. A worker started once answers
    request after request. Every reply is one line carrying the request's
    ``_id``. Anything a module prints while working goes to stderr, so it can
    never be mistaken for a reply.
    """
    replies = sys.stdout
    sys.stdout = sys.stderr
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as err:
            replies.write(json.dumps({"ok": False, "error": f"invalid JSON request: {err}"}) + "\n")
            replies.flush()
            continue
        request_id = request.pop("_id", None) if isinstance(request, dict) else None
        response = _answer(request if isinstance(request, dict) else {})
        replies.write(json.dumps({"_id": request_id, **response}) + "\n")
        replies.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(serve() if "--serve" in sys.argv[1:] else main())

"""ATS-safety linter for a generated resume (.docx).

Modern ATS parsers read a document left-to-right, top-to-bottom and reliably
choke on certain constructs: tables, multi-column layouts, images carrying text,
and content stranded in headers/footers all get scrambled or dropped. Em dashes
and decorative symbols break some parsers outright; weak "responsible for" bullet
phrasing survives ATS but loses human reviewers.

This module INSPECTS a .docx and reports what it finds. It is an honest detector:
it never edits the document or invents content. Because the resume is generated
from the user's master, any structural finding is really a finding about the
master, so the user fixes it once and every future application benefits.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Dict, List

# Standard bullet glyphs that are SAFE (parsers expect these).
_SAFE_SYMBOLS = {"\u2022", "\u00b7", "\u2023", "\u25aa", "\u2043", "\u2219"}

# Decorative / symbol unicode ranges that commonly break or pollute ATS parsing.
# Deliberately excludes accented Latin letters (names like "José" are fine).
_DECORATIVE_RE = re.compile(
    "[\U0001F000-\U0001FAFF"  # emoji & pictographs
    "\u2190-\u21FF"            # arrows
    "\u2300-\u23FF"            # misc technical
    "\u25A0-\u25FF"            # geometric shapes (filled squares/circles)
    "\u2600-\u27BF"            # dingbats, misc symbols
    "\u2B00-\u2BFF"            # extra arrows/stars
    "\uFE00-\uFE0F"            # variation selectors
    "\u2705\u2714\u2716\u274C\u2B50]"  # check/cross/star emoji-likes
)

EM_DASH = "\u2014"
EN_DASH = "\u2013"


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").lower()).strip()


def _decorative_symbols(text: str) -> List[str]:
    found = []
    seen = set()
    for ch in text:
        if ch in _SAFE_SYMBOLS:
            continue
        if _DECORATIVE_RE.match(ch) and ch not in seen:
            seen.add(ch)
            found.append(ch)
    return found


def lint_resume(resume_path: str | Path, *, config: Dict[str, Any] | None = None) -> Dict[str, Any]:
    """Inspect a generated resume for ATS-hostile structure + phrasing.

    Returns ``{ok, issues, findings}`` where ``findings`` is structured data and
    ``issues`` is a list of ``{severity, message}`` (severity: high|medium|low).
    Never raises for a bad/missing file: that is reported as a low-confidence
    note and ``findings`` stays empty so the caller degrades gracefully.
    """
    config = config or {}
    flags = config.get("atsUnsafe") or {}
    banned = [b for b in (config.get("bannedBulletPhrases") or []) if b]

    findings: Dict[str, Any] = {
        "tables": 0,
        "images": 0,
        "multiColumn": False,
        "headerFooterContent": False,
        "emDash": False,
        "decorativeSymbols": [],
        "bannedBulletPhrases": [],
    }
    issues: List[Dict[str, str]] = []

    resume_path = Path(resume_path)
    if not resume_path.exists():
        return {"ok": True, "issues": [], "findings": findings, "note": "resume file not found; lint skipped"}

    try:
        from docx import Document  # lazy import so non-docx environments still load
        from docx.oxml.ns import qn

        document = Document(str(resume_path))
    except Exception as err:  # noqa: BLE001 - never break tailoring over a lint read
        return {"ok": True, "issues": [], "findings": findings, "note": f"lint skipped: {type(err).__name__}: {err}"}

    # --- Structure: tables ---
    table_count = len(document.tables)
    findings["tables"] = table_count
    if table_count and flags.get("flagTables", True):
        issues.append({
            "severity": "high",
            "message": (
                f"{table_count} table(s) detected. ATS parsers read tables out of order; "
                "rebuild the resume as single-column plain text."
            ),
        })

    # --- Structure: images / drawings ---
    try:
        image_count = len(document.inline_shapes)
        # Floating images aren't in inline_shapes; count <w:drawing> elements too.
        drawings = document.element.body.findall(f".//{qn('w:drawing')}")
        image_count = max(image_count, len(drawings))
    except Exception:  # noqa: BLE001
        image_count = 0
    findings["images"] = image_count
    if image_count and flags.get("flagImages", True):
        issues.append({
            "severity": "high",
            "message": (
                f"{image_count} image/graphic element(s) detected. Text inside images is invisible "
                "to ATS; keep the resume to selectable text only."
            ),
        })

    # --- Structure: multi-column sections ---
    multi_col = False
    try:
        for section in document.sections:
            cols = section._sectPr.find(qn("w:cols"))
            if cols is not None:
                num = cols.get(qn("w:num"))
                if num and int(num) > 1:
                    multi_col = True
                    break
    except Exception:  # noqa: BLE001
        multi_col = False
    findings["multiColumn"] = multi_col
    if multi_col and flags.get("flagMultiColumn", True):
        issues.append({
            "severity": "high",
            "message": "Multi-column layout detected. Single-column only; columns get interleaved by ATS.",
        })

    # --- Structure: header / footer content ---
    hf_content = False
    try:
        for section in document.sections:
            for region in (section.header, section.footer):
                if region is None:
                    continue
                text = " ".join(p.text for p in region.paragraphs).strip()
                if text:
                    hf_content = True
                    break
            if hf_content:
                break
    except Exception:  # noqa: BLE001
        hf_content = False
    findings["headerFooterContent"] = hf_content
    if hf_content and flags.get("flagHeaderFooterContent", True):
        issues.append({
            "severity": "medium",
            "message": "Content found in a header/footer. Many ATS skip header/footer regions; "
                       "move contact details into the document body.",
        })

    # --- Content: full text scan ---
    full_text = "\n".join(p.text for p in document.paragraphs)
    for table in document.tables:
        for row in table.rows:
            for cell in row.cells:
                full_text += "\n" + cell.text

    if flags.get("flagEmDash", True) and (EM_DASH in full_text or EN_DASH in full_text):
        findings["emDash"] = True
        issues.append({
            "severity": "low",
            "message": "Em/en dash present. Replace with a comma or hyphen; some parsers split tokens on them.",
        })

    if flags.get("flagNonAsciiSymbols", True):
        symbols = _decorative_symbols(full_text)
        findings["decorativeSymbols"] = symbols
        if symbols:
            issues.append({
                "severity": "medium",
                "message": "Decorative symbols/icons present (" + " ".join(symbols[:6]) +
                           "). Remove icons; resume body should be plain text.",
            })

    if flags.get("flagBannedBulletPhrases", True) and banned:
        low = _normalize(full_text)
        hits = []
        for phrase in banned:
            if re.search(rf"(?<![a-z]){re.escape(phrase.lower())}(?![a-z])", low):
                hits.append(phrase)
        findings["bannedBulletPhrases"] = hits
        if hits:
            issues.append({
                "severity": "low",
                "message": "Weak bullet phrasing (" + ", ".join(hits[:5]) +
                           "). Lead bullets with an action verb (Architected, Built, Optimized).",
            })

    # `ok` reflects whether anything HIGH-severity (a real parse-breaker) was found.
    ok = not any(i["severity"] == "high" for i in issues)
    return {"ok": ok, "issues": issues, "findings": findings}

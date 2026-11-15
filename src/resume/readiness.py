"""Resume readiness: what tailoring will be able to work with (audit F4).

Run when a master resume is uploaded, so a layout the tailor cannot read is
found once, before any packet, instead of job by job. It uses the tailor's own
detectors (sections, roles, bullets, page estimate), so it reports what the
tailor will actually see, and it only reports: an upload is never refused here.

Every finding is {level, code, message}: "ok", "note" (worth knowing, nothing
to do) or "warn" (tailoring or the PDF will miss something).
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Dict, List

import tailor
from keywordAudit import read_docx_contact_text

_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
_PHONE_CANDIDATE_RE = re.compile(r"\+?\(?\d[\d\s().-]{7,}\d")
_LINKEDIN_RE = re.compile(r"linkedin\.com/in/", re.IGNORECASE)


def _has_phone(text: str) -> bool:
    """Ten to fifteen digits in one run of digits and separators ("555-010-0000")."""
    return any(10 <= sum(c.isdigit() for c in m.group(0)) <= 15 for m in _PHONE_CANDIDATE_RE.finditer(text or ""))


def _text_boxes(document) -> int:
    """Text boxes, counted once: Word also stores a fallback copy of each one."""
    count = 0
    for node in document.element.body.iter():
        if not str(node.tag).endswith("}txbxContent"):
            continue
        if any(str(a.tag).endswith("}Fallback") for a in node.iterancestors()):
            continue
        count += 1
    return count


def _plural(n: int, word: str, many: str | None = None) -> str:
    return f"{n} {word if n == 1 else (many or word + 's')}"


def readiness(path: str | Path, *, section_headings: Dict[str, List[str]] | None = None) -> Dict[str, Any]:
    """Read a resume the way the tailor will, and say what it found."""
    with tailor._section_heading_overrides(section_headings):
        return _readiness(path)


def _readiness(path: str | Path) -> Dict[str, Any]:
    from docx import Document
    from docx.oxml.ns import qn

    document = Document(str(path))
    sections: List[str] = []
    unrecognized: List[str] = []
    roles: List[str] = []
    bullets = 0
    typed = 0
    first_line_seen = False
    body_text: List[str] = []
    for paragraph in document.paragraphs:
        text = (paragraph.text or "").strip()
        if not text:
            continue
        body_text.append(text)
        if tailor._is_section_heading(text):
            sections.append(tailor._norm_heading(text))
        elif tailor._is_role_heading(paragraph):
            roles.append(text)
        elif tailor._is_bullet(paragraph):
            bullets += 1
            style = (getattr(paragraph.style, "name", "") or "").lower()
            numbered = paragraph._p.pPr is not None and paragraph._p.pPr.numPr is not None
            if "list" not in style and "bullet" not in style and not numbered:
                typed += 1
        elif first_line_seen and tailor._looks_like_heading(paragraph):
            unrecognized.append(text)
        first_line_seen = True
    for table in document.tables:
        for row in table.rows:
            for cell in row.cells:
                body_text.extend(p.text for p in cell.paragraphs if (p.text or "").strip())

    header_text = read_docx_contact_text(path)
    body = "\n".join(body_text)
    links = list(document.element.body.iter(qn("w:hyperlink")))
    link_targets = " ".join(
        str(document.part.rels[link.get(qn("r:id"))].target_ref)
        for link in links if link.get(qn("r:id")) in document.part.rels
    )
    email = bool(_EMAIL_RE.search(body) or _EMAIL_RE.search(header_text))
    phone = _has_phone(body) or _has_phone(header_text)
    contact = {
        "email": email,
        "phone": phone,
        "linkedin": bool(_LINKEDIN_RE.search(body) or _LINKEDIN_RE.search(header_text) or _LINKEDIN_RE.search(link_targets)),
        "in_page_header": bool(_EMAIL_RE.search(header_text) or _has_phone(header_text)),
    }
    tables = len(document.tables)
    text_boxes = _text_boxes(document)
    pages = round(tailor.estimate_page_count(document), 1)

    findings: List[Dict[str, str]] = []

    def add(level: str, code: str, message: str) -> None:
        findings.append({"level": level, "code": code, "message": message})

    if roles and bullets:
        add("ok", "structure", f"Found {_plural(len(sections), 'section')}, {_plural(len(roles), 'job')} "
                               f"and {_plural(bullets, 'bullet')}.")
    if not roles:
        add("warn", "no_roles", "No job lines were found: a job title or employer with its dates, under an "
                                "experience heading. Tailoring will not reorder or fit your experience.")
    if roles and not bullets:
        add("warn", "no_bullets", "No bullets were found under your jobs, so there is nothing to reorder or fit.")
    if unrecognized:
        add("warn", "unrecognized_headings",
            "These look like headings but are not ones the tailor knows, so the section under each is not "
            f"tailored: {', '.join(unrecognized)}.")
    if not email:
        add("warn", "no_email", "No email address was found.")
    if not phone:
        add("warn", "no_phone", "No phone number was found.")
    if contact["in_page_header"]:
        add("note", "contact_in_header", "Your contact details are in the page header. The PDF prints them, but "
                                         "some applicant systems ignore page headers, so a copy in the body is safer.")
    if tables:
        add("note", "tables", f"{_plural(tables, 'table')}. A tailored copy turns each row into a plain line, "
                              "so applicant systems read it in order. The words do not change.")
    if text_boxes:
        add("warn", "text_boxes", f"{_plural(text_boxes, 'text box', 'text boxes')}. Text in a text box is not "
                                  "tailored (it is printed in the PDF).")
    if typed:
        add("note", "typed_bullets", f"{_plural(typed, 'bullet')} typed by hand (a dash or a dot). They are "
                                     "handled like list bullets.")
    if links:
        add("note", "hyperlinks", f"{_plural(len(links), 'link')}. They stay links in the tailored copy and the PDF.")
    add("note", "pages", f"About {pages:.1f} pages, estimated from the text, not measured. Tailoring fits to "
                         "your page limit by leaving out the least relevant bullets.")

    return {
        "sections": sections,
        "unrecognized_headings": unrecognized,
        "roles": roles,
        "bullets": bullets,
        "typed_bullets": typed,
        "contact": contact,
        "hyperlinks": len(links),
        "tables": tables,
        "text_boxes": text_boxes,
        "estimated_pages": pages,
        "findings": findings,
    }

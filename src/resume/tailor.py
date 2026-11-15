"""Deterministic resume tailoring.

Produces a per-job tailored copy of the master resume WITHOUT inventing any
content. The master file is opened read-only (we never call ``save`` on it).

Tailoring actions (all honest, content-preserving):
  1. Classify requested terms as required, preferred, or unclassified from the
     job description's explicit qualification headings.
  2. Reorder existing summary paragraphs and bullet runs, within their original
     sections/roles, so supported required content appears before preferred
     content. Paragraphs are moved intact; none are copied, deleted, or edited.
  3. Emphasize (bold) the matched keyword ITSELF wherever the resume already
     mentions it. The run is split so only the phrase is bolded, never the
     surrounding sentence, and the number of emphasized terms is capped so the
     page never reads as keyword-stuffed.
  4. Reorder the comma-separated skill lists in CORE COMPETENCIES so the skills
     this JD asks for come FIRST in each category. Handles BOTH layouts: a
     2-column table and the more common "Label:  a, b, c" paragraph. Splitting
     is bracket-aware, so a qualified skill like
     "Dimensional Modeling (Kimball, Inmon)" moves as ONE item. Pure permutation
     of existing items — nothing is added, removed, or reworded.
  5. Flatten layout tables into single-column paragraphs in the generated copy,
     preserving their exact text/runs so ATS parsers read content in order.
  6. Repair layout artifacts: manual page breaks (which freeze pagination and
     leave half-empty pages), role blocks a previous pass folded into one
     paragraph (which cost the first bullet of every role its formatting),
     runs of blank filler, and `mailto:` prefixes left in visible text. These
     arrive from OUTSIDE too — a tailored copy saved back over the master
     carries them into every later run — so they are cleaned on the way in.
  7. Fit the result to a page budget (2 pages by default) by OMITTING whole
     low-relevance bullets from the oldest roles, worst-first, never dropping a
     role, heading, date, or a role's last bullet, and never shortening or
     rewording anything. Omissions are listed in `changes` for review.
  8. Save the result to a per-job .docx in the job's output folder.

Nothing is ever added: the optional "Most relevant to this role" line was
removed (audit R9), because it was text the master never contained.

Free-form rewriting is intentionally disabled. Without a claim-level evidence
map, even plausible wording changes can silently invent scope, ownership,
technologies, or metrics. This module therefore performs exact-text movement
and formatting changes whose provenance is auditable, plus ONE narrow
exception: ``accepted_rewrites``, bullets whose rewording was verified against
cited master-resume lines (src/resume/claimVerifier.js) and then accepted by a
person. Exactly those bullets change; every other unit is still checked
byte-for-byte by the truth invariants.

Every action is recorded in a structured ``changes`` list (what changed, where,
before/after, and the evidence for why) so a human can review the tailored
resume against the master before approving the application.

If a keyword is requested but missing from the resume, it is reported as a gap
(``gaps``) and is never added as a fabricated skill.
"""
from __future__ import annotations

import re
from collections import Counter
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Sequence

from docx.enum.text import WD_TAB_ALIGNMENT

import evidence
import pagefit
from jdKeywords import classify_qualification_keywords
from keywordAudit import read_docx_text


_DEFAULT_REQUIRED_MARKERS = (
    "required", "requirements", "must have", "must-have",
    "minimum qualifications", "minimum qualification", "basic qualifications",
    "what you need", "what you'll need", "what you will need", "you have",
    "you bring", "qualifications",
)
_DEFAULT_PREFERRED_MARKERS = (
    "preferred", "nice to have", "nice-to-have", "bonus", "a plus", "plus",
    "desired", "preferred qualifications", "good to have",
)
_QUALIFICATION_WEIGHT = {"required": 3, "preferred": 2, "unclassified": 1}
# A role's date line. Full month names were the only form recognised, so a
# résumé written "Jan 2020 – Present" / "Mar 2017 – Dec 2019" / "2015 – 2018"
# had ONE detectable role (the "Present" one) and every older role's bullets
# were counted as part of it. The page fit then treated the whole career as a
# single role and could strip older employers down to nothing. Every common
# form is recognised now: full and abbreviated months, MM/YYYY, and year
# RANGES (a bare year is not enough, so "B.S., 2016" stays an education line).
_MONTHS = (
    r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|"
    r"aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?"
)
_EMPLOYMENT_DATE_RE = re.compile(
    rf"\b{_MONTHS}\s*[’']?\s*\d{{2,4}}\b"
    r"|\b(?:0?[1-9]|1[0-2])\s*/\s*(?:19|20)\d{2}\b"
    r"|\b(?:19|20)\d{2}\s*(?:-|–|—|to|until)\s*(?:(?:19|20)\d{2}|present|current|now|today)\b"
    r"|\bpresent\b",
    re.IGNORECASE,
)


def _slug(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return slug or "untitled"


def _date_stamp(now: datetime | None = None) -> str:
    now = now or datetime.now(timezone.utc)
    return now.strftime("%Y%m%d")


def output_filename(company: str, title: str, now: datetime | None = None) -> str:
    return f"{_slug(company)}_{_slug(title)}_{_date_stamp(now)}.docx"


def _keyword_details(qualifications: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    return {
        re.sub(r"\s+", " ", str(item.get("keyword", "")).lower()).strip(): item
        for item in qualifications.get("items", [])
        if str(item.get("keyword", "")).strip()
    }


def _matches_for_text(
    text: str,
    keywords: Sequence[str],
    qualification_details: Dict[str, Dict[str, Any]],
    *,
    in_list: bool = False,
) -> List[Dict[str, Any]]:
    """Return grounded keyword evidence for one existing resume fragment.

    ``in_list``: ``text`` is one item of a skills list (src/resume/evidence.py).
    """
    matched: List[Dict[str, Any]] = []
    for keyword in keywords:
        if not keyword or not evidence.shows(str(keyword), text or "", vocabulary=keywords, in_list=in_list):
            continue
        key = re.sub(r"\s+", " ", str(keyword).lower()).strip()
        detail = qualification_details.get(key, {})
        matched.append({
            "keyword": keyword,
            "qualification": detail.get("classification", "unclassified"),
            "resume_text": text,
            "jd_evidence": detail.get("jd_evidence", []),
        })
    matched.sort(
        key=lambda item: -_QUALIFICATION_WEIGHT.get(item["qualification"], 1)
    )
    return matched


def _relevance_key(evidence: Sequence[Dict[str, Any]]) -> tuple:
    """Sort key: any required evidence outranks any preferred evidence."""
    weights = [
        _QUALIFICATION_WEIGHT.get(item.get("qualification", "unclassified"), 1)
        for item in evidence
    ]
    if not weights:
        return (0, 0, 0)
    return (max(weights), sum(weights), len(weights))


def _inline_items(paragraph):
    """Every run of a paragraph's text, in order, with the link it sits in (or None).

    ``paragraph.runs`` leaves out runs inside a ``w:hyperlink`` (python-docx
    1.2), while ``paragraph.text`` includes them. Code that read text through
    ``runs`` therefore lost every linked email, profile URL and portfolio link:
    the PDF left them out and refused to print (R1), a table cell holding a
    link failed the flattening check and abandoned the whole tailoring (R10),
    and an accepted rewrite kept the link text glued to the new wording (N3).
    Everything that walks a paragraph's runs goes through here.
    """
    from docx.text.hyperlink import Hyperlink

    for item in paragraph.iter_inner_content():
        if isinstance(item, Hyperlink):
            for run in item.runs:
                yield run, item
        else:
            yield item, None


#: Link targets a printed resume may carry. Anything else keeps its text, unlinked.
_SAFE_LINK_RE = re.compile(r"^(?:https?://|mailto:)", re.IGNORECASE)


def _iter_all_paragraphs(document):
    """Yield body and table-cell paragraphs once each."""
    seen = set()
    for paragraph in document.paragraphs:
        if paragraph._p not in seen:
            seen.add(paragraph._p)
            yield paragraph
    for table in document.tables:
        for row in table.rows:
            for cell in row.cells:
                for paragraph in cell.paragraphs:
                    if paragraph._p not in seen:
                        seen.add(paragraph._p)
                        yield paragraph


#: Most distinct terms to emphasize in one resume. Emphasis exists to draw a
#: human reviewer's eye to a handful of decisive matches. Past this, bolding
#: stops meaning anything and the page reads as keyword-stuffed.
_MAX_EMPHASIZED_TERMS = 12

def _merge_spans(spans: Sequence[tuple]) -> List[tuple]:
    """Merge overlapping/adjacent (start, end) ranges, left to right."""
    merged: List[tuple] = []
    for start, end in sorted(spans):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def _bold_spans_in_run(paragraph, run, spans: Sequence[tuple]) -> int:
    """Split ``run`` so ONLY the given character ranges become bold.

    Bolding the whole run was the original behaviour, and on a real resume it is
    ruinous: Word commonly stores an entire bullet as ONE run, so a single
    keyword match turned the complete bullet bold. A tailored resume came out
    with thirteen fully-bold bullets — unprofessional to a human, and a
    keyword-stuffing signal to an ATS.

    The run is rebuilt as up to 2n+1 runs that concatenate to exactly the same
    text, each inheriting the original run's formatting, with ``bold`` set only
    on the keyword pieces. ``paragraph.text`` is therefore unchanged, so the
    no-loss text invariant still holds.

    @return number of bolded pieces created
    """
    from copy import deepcopy as _deepcopy
    from docx.oxml.ns import qn
    from docx.oxml import OxmlElement
    from docx.text.run import Run

    text = run.text or ""
    ranges = [
        (max(0, start), min(len(text), end))
        for start, end in _merge_spans(spans)
        if 0 <= start < end
    ]
    if not ranges:
        return 0

    pieces: List[tuple] = []
    cursor = 0
    for start, end in ranges:
        if start > cursor:
            pieces.append((text[cursor:start], False))
        pieces.append((text[start:end], True))
        cursor = end
    if cursor < len(text):
        pieces.append((text[cursor:], False))
    pieces = [(chunk, bold) for chunk, bold in pieces if chunk]

    # The whole run IS the keyword (e.g. a standalone skill cell): no split
    # needed, just emphasize it.
    if len(pieces) == 1:
        run.bold = True
        return 1

    element = run._r
    parent = element.getparent()
    index = list(parent).index(element)

    created = []
    for chunk, bold in pieces:
        clone = _deepcopy(element)
        # Keep only the formatting; drop copied text/breaks/tabs.
        for child in list(clone):
            if child.tag != qn("w:rPr"):
                clone.remove(child)
        node = OxmlElement("w:t")
        node.set(qn("xml:space"), "preserve")
        node.text = chunk
        clone.append(node)
        created.append((clone, bold))

    for offset, (clone, _bold) in enumerate(created):
        parent.insert(index + offset, clone)
    parent.remove(element)

    bolded = 0
    for clone, bold in created:
        if bold:
            Run(clone, paragraph).bold = True
            bolded += 1
    return bolded


def _section_of(paragraph) -> str | None:
    """The nearest recognized section heading above a paragraph (normalized), or None.

    A paragraph in a table cell is placed by the heading above its table.
    """
    from docx.oxml.ns import qn
    from docx.text.paragraph import Paragraph

    node = paragraph._p
    while node.getparent() is not None and node.getparent().tag != qn("w:body"):
        node = node.getparent()
    for sibling in node.itersiblings(preceding=True):
        if sibling.tag != qn("w:p"):
            continue
        text = (Paragraph(sibling, paragraph._parent).text or "").strip()
        if text and _is_section_heading(text):
            return _norm_heading(text)
    return None


def _emphasis_allowed(paragraph) -> bool:
    """Bold may go on a bullet, or on a line in the summary or skills section."""
    text = (paragraph.text or "").strip()
    if not text or _is_section_heading(text) or _is_role_heading(paragraph):
        return False
    if _is_bullet(paragraph):
        return True
    section = _section_of(paragraph)
    if section is None:
        return False
    parts = [part.strip() for part in re.split(r"\s*(?:&|/|\band\b|,)\s*", section) if part.strip()]
    return any(part in _SUMMARY_HEADINGS or part in _COMPETENCY_HEADINGS for part in parts)


def _merge_identical_runs(paragraph) -> int:
    """Join neighbouring runs that hold plain text and look exactly the same.

    The visible text and formatting are unchanged; only Word's invisible run
    boundaries go. Spell-check markers between such runs are dropped too.
    """
    from lxml import etree
    from docx.oxml.ns import qn

    def plain(run) -> bool:
        children = [child.tag for child in run]
        return children.count(qn("w:t")) == 1 and all(tag in (qn("w:t"), qn("w:rPr")) for tag in children)

    def looks(run) -> bytes:
        properties = run.find(qn("w:rPr"))
        return etree.tostring(properties) if properties is not None else b""

    merged = 0
    previous = None
    for child in list(paragraph._p):
        if child.tag == qn("w:proofErr"):
            paragraph._p.remove(child)
            continue
        if child.tag != qn("w:r") or not plain(child):
            previous = None
            continue
        if previous is not None and looks(previous) == looks(child):
            kept = previous.find(qn("w:t"))
            kept.text = (kept.text or "") + (child.find(qn("w:t")).text or "")
            kept.set(qn("xml:space"), "preserve")
            paragraph._p.remove(child)
            merged += 1
        else:
            previous = child
    return merged


def _emphasize(
    document,
    keywords: List[str],
    qualification_details: Dict[str, Dict[str, Any]],
    *,
    max_terms: int = _MAX_EMPHASIZED_TERMS,
) -> tuple[int, List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Bold the KEYWORD ITSELF wherever the resume already mentions it.

    Two deliberate limits keep the result professional:
      * only the matched phrase is bolded, never the surrounding sentence
        (see _bold_spans_in_run), and
      * each distinct term is emphasized at its FIRST occurrence only, with a
        cap of ``max_terms`` terms per resume. Required JD qualifications are
        emphasized before preferred ones, so the budget goes to what the posting
        actually insists on.

    Returns ``(count, evidence, mutations)`` where evidence lists, per keyword,
    the existing resume text that mentions it — proof the emphasis is grounded
    in real content, not injected.
    """
    # Spend the emphasis budget on required terms first, then preferred, then
    # the rest; ties keep the caller's ordering for determinism.
    def _priority(keyword: str) -> int:
        key = re.sub(r"\s+", " ", str(keyword).lower()).strip()
        classification = qualification_details.get(key, {}).get("classification", "unclassified")
        return -_QUALIFICATION_WEIGHT.get(classification, 1)

    ordered_keywords = sorted(
        [keyword for keyword in keywords if keyword],
        key=lambda keyword: (_priority(keyword), keywords.index(keyword)),
    )

    count = 0
    evidence_by_keyword: Dict[str, Dict[str, Any]] = {}
    mutations: List[Dict[str, Any]] = []
    emphasized_terms: set = set()

    # Only the summary, skills and bullets take bold (R8). The first mention
    # anywhere used to win, so a term went bold in a role line ("Airflow
    # Platform Engineer | Example Corp"), a heading or the name.
    paragraphs = [para for para in _iter_all_paragraphs(document) if _emphasis_allowed(para)]
    # Word splits text into runs for reasons nobody sees ("Tuned Sp" + "ark"):
    # join runs that look the same, so a split term is found and bolded.
    for para in paragraphs:
        _merge_identical_runs(para)
    for keyword in ordered_keywords:
        if len(emphasized_terms) >= max_terms:
            break
        key = re.sub(r"\s+", " ", str(keyword).lower()).strip()
        if key in emphasized_terms:
            continue
        placed = False
        for para in paragraphs:
            if placed:
                break
            runs = list(para.runs)
            bounds = []
            cursor = 0
            for run in runs:
                bounds.append((cursor, cursor + len(run.text or "")))
                cursor += len(run.text or "")
            # Matched against the whole line, so the context rules for an
            # everyday term see the sentence, not one run of it.
            text = "".join(run.text or "" for run in runs)
            for start, end in evidence.occurrences(str(keyword), text, vocabulary=ordered_keywords):
                index = next((i for i, (left, right) in enumerate(bounds) if left <= start and end <= right), None)
                if index is None:
                    continue  # spans runs that look different: left alone
                run = runs[index]
                # Already bold in the master: nothing to do, but the term is
                # spent so we do not hunt for another occurrence.
                if run.bold is True:
                    placed = True
                    break
                offset = bounds[index][0]
                added = _bold_spans_in_run(para, run, [(start - offset, end - offset)])
                if not added:
                    continue
                count += added
                mutations.append({
                    "text": text[start:end],
                    "paragraph": (para.text or "").strip(),
                    "before_bold": run.bold,
                    "after_bold": True,
                })
                detail = qualification_details.get(key, {})
                evidence_by_keyword.setdefault(key, {
                    "keyword": keyword,
                    "qualification": detail.get("classification", "unclassified"),
                    "resume_text": (para.text or "").strip()[:240],
                    "jd_evidence": detail.get("jd_evidence", []),
                })
                placed = True
                break
        if placed:
            emphasized_terms.add(key)

    return count, list(evidence_by_keyword.values()), mutations


_BRACKET_PAIRS = {"(": ")", "[": "]", "{": "}"}
_CLOSERS = set(_BRACKET_PAIRS.values())


def _split_skill_list(text: str) -> List[str]:
    """Split a comma-separated competency list into items, respecting brackets.

    A naive ``split(",")`` tears qualified skills apart: the real entry
    "Dimensional Modeling (Kimball, Inmon)" became TWO items,
    "Dimensional Modeling (Kimball" and "Inmon)". Reordering then reassembled
    them around unrelated skills and produced literal nonsense in a resume sent
    to employers — while the item-multiset invariant still passed, because every
    fragment was technically still present.

    Commas inside (), [] or {} are therefore treated as part of the item.
    """
    items: List[str] = []
    buffer: List[str] = []
    depth = 0
    for char in text or "":
        if char in _BRACKET_PAIRS:
            depth += 1
            buffer.append(char)
        elif char in _CLOSERS:
            depth = max(0, depth - 1)
            buffer.append(char)
        elif char == "," and depth == 0:
            item = "".join(buffer).strip()
            if item:
                items.append(item)
            buffer = []
        else:
            buffer.append(char)
    tail = "".join(buffer).strip()
    if tail:
        items.append(tail)
    return items


def _brackets_balanced(text: str) -> bool:
    """True when every bracket in ``text`` is matched — a split-integrity check."""
    stack: List[str] = []
    for char in text or "":
        if char in _BRACKET_PAIRS:
            stack.append(_BRACKET_PAIRS[char])
        elif char in _CLOSERS:
            if not stack or stack.pop() != char:
                return False
    return not stack


def _set_cell_text_preserving(cell, text: str) -> None:
    """Replace a table cell's text while keeping the first run's formatting."""
    para = cell.paragraphs[0]
    if para.runs:
        para.runs[0].text = text
        for run in para.runs[1:]:
            run.text = ""
    else:
        para.add_run(text)


#: Section names by kind (R14). "Career History", "Professional Background"
#: and "Technical Proficiencies" were unknown, so nothing under them was
#: reordered and nothing said so. More names per install: ats_resume.json
#: "sectionHeadings" (see _section_heading_overrides).
_HEADING_KINDS: Dict[str, set] = {
    "summary": {
        "professional summary", "summary", "profile", "career summary", "about me", "about",
        "executive summary", "professional profile", "overview", "summary of qualifications",
        "objective", "career objective", "personal statement", "qualifications summary",
    },
    "experience": {
        "professional experience", "work experience", "experience", "employment history",
        "career history", "professional background", "work history", "employment",
        "career experience", "professional history", "relevant experience",
    },
    "skills": {
        "core competencies", "technical skills", "skills", "key skills", "areas of expertise",
        "technologies", "technical proficiencies", "technical expertise", "competencies",
        "core skills", "skill set", "skills and tools", "tools", "technical summary",
    },
    "education": {
        "education", "academic background", "education and training", "academic qualifications",
    },
    "other": {
        "certifications", "projects", "selected projects", "publications", "awards",
        "additional information",
        # Secondary experience blocks. Unrecognised, "EARLIER EXPERIENCE" read as
        # body text inside the role above it.
        "earlier experience", "additional experience", "other experience",
        "volunteer experience", "volunteering", "leadership",
        "honors", "honors and awards", "licenses", "training", "languages", "interests", "references",
    },
}
_COMPETENCY_HEADINGS = set(_HEADING_KINDS["skills"])
_SECTION_HEADINGS = set().union(*_HEADING_KINDS.values())


#: Sections whose dated lines are not jobs (R4). Experience-like sections
#: (and projects or volunteering, which read as roles) are not listed.
_NON_ROLE_SECTIONS = _HEADING_KINDS["summary"] | _HEADING_KINDS["skills"] | _HEADING_KINDS["education"] | {
    "certifications", "licenses", "training", "languages", "interests", "references",
    "honors", "honors and awards", "awards", "publications", "additional information",
}


def _preceding_section_heading(document, table) -> str:
    """Return the closest recognized section heading before a table."""
    from docx.oxml.ns import qn
    from docx.text.paragraph import Paragraph

    sibling = table._tbl.getprevious()
    while sibling is not None:
        if sibling.tag == qn("w:p"):
            text = _norm_heading(Paragraph(sibling, document._body).text)
            if text in _SECTION_HEADINGS:
                return text
        sibling = sibling.getprevious()
    return ""


def _reorder_competencies(
    document,
    keywords: List[str],
    qualification_details: Dict[str, Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Reorder comma-separated skills so JD-matched ones come first.

    Applies only to a 2-column table under a recognized competency heading, so
    unrelated employment/education tables cannot be mutated accidentally.
    STRICTLY a stable permutation of the existing items — the multiset of
    skills is unchanged; nothing is added, removed, or reworded. Required
    matches rank before preferred matches. Returns one provenance record per
    row actually reordered.
    """
    changes: List[Dict[str, Any]] = []
    if not keywords:
        return changes
    for table_index, table in enumerate(document.tables):
        section = _preceding_section_heading(document, table)
        if section not in _COMPETENCY_HEADINGS:
            continue
        for row_index, row in enumerate(table.rows):
            if len(row.cells) != 2:
                continue
            category = (row.cells[0].text or "").strip()
            value_cell = row.cells[1]
            # Reconstructing a multi-paragraph cell can alter its layout. Keep
            # complex cells untouched rather than pretending that is ATS-safe.
            if len(value_cell.paragraphs) != 1:
                continue
            nonempty_runs = [
                run for run, _link in _inline_items(value_cell.paragraphs[0]) if (run.text or "")
            ]
            # A link in the cell cannot be rebuilt into one run without
            # losing it (R16): leave the cell as it is.
            if len(nonempty_runs) > 1 or value_cell.paragraphs[0].hyperlinks:
                continue
            before_items = _split_skill_list(value_cell.text)
            if len(before_items) < 2:
                continue
            evidence_by_item = {
                item: _matches_for_text(item, keywords, qualification_details, in_list=True)
                for item in before_items
            }
            indexed = list(enumerate(before_items))
            ranked = sorted(
                indexed,
                key=lambda pair: (
                    -_relevance_key(evidence_by_item[pair[1]])[0],
                    -_relevance_key(evidence_by_item[pair[1]])[1],
                    -_relevance_key(evidence_by_item[pair[1]])[2],
                    pair[0],
                ),
            )
            after_items = [item for _index, item in ranked]
            matched = [item for item in after_items if evidence_by_item[item]]
            if after_items == before_items or not matched:
                continue
            if Counter(before_items) != Counter(after_items):
                raise RuntimeError("competency reordering changed the source skill multiset")
            # Integrity check the multiset cannot provide: if the split tore a
            # qualified skill apart ("… (Kimball, Inmon)"), each fragment carries
            # an unbalanced bracket and reordering would emit nonsense. Refuse.
            if any(not _brackets_balanced(item) for item in before_items):
                continue
            _set_cell_text_preserving(value_cell, ", ".join(after_items))
            changes.append({
                "type": "reorder_skills",
                "where": f"{section}: {category or 'competencies'}",
                "before": before_items,
                "after": after_items,
                "evidence": {
                    "job description asks for": [
                        evidence
                        for item in matched
                        for evidence in evidence_by_item[item]
                    ],
                    "master_resume_items": matched,
                },
                "reason": (
                    "supported required skills moved before supported preferred/other skills; "
                    "no items were added, removed, or reworded"
                ),
                "source": "master_resume",
                "table_index": table_index,
                "row_index": row_index,
            })
    return changes


#: A competency line looks like "Data Platforms:  Azure Databricks, Fabric, …".
#: The label is short and followed by a comma-separated skill list.
_COMPETENCY_LINE_RE = re.compile(r"^(?P<label>[^:]{1,48}?)(?P<sep>\s*:\s*)(?P<items>\S.*)$")


def _parse_competency_line(text: str) -> tuple | None:
    """Split a "Label: a, b, c" competency line into (label, sep, items).

    Returns None unless the line really is a labelled skill list: a short label,
    at least two comma-separated items, and no sentence punctuation in the label.
    """
    raw = text or ""
    match = _COMPETENCY_LINE_RE.match(raw.strip())
    if not match:
        return None
    label = match.group("label").strip()
    if not label or len(label.split()) > 5 or re.search(r"[.!?;]", label):
        return None
    items = _split_skill_list(match.group("items"))
    if len(items) < 2:
        return None
    return label, match.group("sep"), items


def _is_competency_paragraph(paragraph) -> bool:
    """Structural test for a skills line, independent of document position.

    Position-independent on purpose: the content-unit invariant must classify a
    line identically before and after tailoring, wherever reordering moved it.
    """
    if _is_bullet(paragraph):
        return False
    return _parse_competency_line(paragraph.text) is not None


def _reorder_competency_paragraphs(
    document,
    keywords: List[str],
    qualification_details: Dict[str, Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Reorder a PARAGRAPH-based skills list so JD-matched skills come first.

    `_reorder_competencies` only handles a 2-column table. Plenty of resumes —
    including the one this project ships against — write CORE COMPETENCIES as
    plain paragraphs ("Data Platforms:  Azure Databricks, …"), so that function
    silently found nothing and the single highest-value ATS action (leading each
    skill category with what the posting actually asked for) never happened.

    STRICTLY a stable permutation of the existing items: the multiset of skills
    is unchanged, and the label, separator, and run formatting are preserved.
    Only fires when the item text lives inside ONE run, so we never rebuild a
    mixed-formatting line and quietly change its appearance.
    """
    changes: List[Dict[str, Any]] = []
    if not keywords:
        return changes

    bounds = _section_bounds(document, _COMPETENCY_HEADINGS)
    if bounds is None:
        return changes
    start, end = bounds

    for paragraph in document.paragraphs[start:end]:
        parsed = _parse_competency_line(paragraph.text)
        if parsed is None or _is_bullet(paragraph):
            continue
        label, _sep, before_items = parsed

        evidence_by_item = {
            item: _matches_for_text(item, keywords, qualification_details, in_list=True)
            for item in before_items
        }
        indexed = list(enumerate(before_items))
        ranked = sorted(
            indexed,
            key=lambda pair: (
                -_relevance_key(evidence_by_item[pair[1]])[0],
                -_relevance_key(evidence_by_item[pair[1]])[1],
                -_relevance_key(evidence_by_item[pair[1]])[2],
                pair[0],
            ),
        )
        after_items = [item for _index, item in ranked]
        matched = [item for item in after_items if evidence_by_item[item]]
        if after_items == before_items or not matched:
            continue
        if Counter(before_items) != Counter(after_items):
            raise RuntimeError("competency reordering changed the source skill multiset")
        # Integrity check the multiset cannot provide: if the split tore a
        # qualified skill apart ("… (Kimball, Inmon)"), each fragment carries
        # an unbalanced bracket and reordering would emit nonsense. Refuse.
        if any(not _brackets_balanced(item) for item in before_items):
            continue

        # Locate the item text inside a single run, then rewrite just that slice.
        joined = ", ".join(before_items)
        full = paragraph.text or ""
        item_start = full.find(joined)
        if item_start < 0:
            continue
        item_end = item_start + len(joined)

        # Offsets over EVERY run, linked or not, because `full` includes link
        # text; only a run outside a link is ever rewritten (R16).
        target_run = None
        run_offset = 0
        for run, link in _inline_items(paragraph):
            run_text = run.text or ""
            run_end = run_offset + len(run_text)
            if link is None and run_offset <= item_start and item_end <= run_end:
                target_run = (run, run_offset)
                break
            run_offset = run_end
        if target_run is None:
            # Items span several runs; leave the line alone rather than
            # reconstructing it and risking a formatting change.
            continue

        run, offset = target_run
        run_text = run.text or ""
        local_start = item_start - offset
        local_end = item_end - offset
        run.text = run_text[:local_start] + ", ".join(after_items) + run_text[local_end:]

        changes.append({
            "type": "reorder_skills",
            "where": f"core competencies: {label}",
            "before": before_items,
            "after": after_items,
            "evidence": {
                "job description asks for": [
                    evidence for item in matched for evidence in evidence_by_item[item]
                ],
                "master_resume_items": matched,
            },
            "reason": (
                "supported required skills moved before supported preferred/other skills; "
                "no items were added, removed, or reworded"
            ),
            "source": "master_resume",
        })
    return changes


def _semantic_tokens(document) -> Counter:
    """Content-token multiset used to prove table flattening lost no words."""
    tokens = []
    for paragraph in _iter_all_paragraphs(document):
        tokens.extend(re.findall(
            r"[a-z0-9][a-z0-9+#./%_-]*", paragraph.text or "", re.IGNORECASE
        ))
    return Counter(token.lower() for token in tokens)


def _copy_cell_content(target, cell) -> None:
    """Append a cell's text/runs to a body paragraph with formatting intact.

    A link is copied as a link (its ``w:hyperlink`` element, whose relationship
    lives in the same document part), so "Portfolio: example.com/portfolio"
    keeps both its words and its target.
    """
    from docx.text.hyperlink import Hyperlink

    wrote = False
    for paragraph in cell.paragraphs:
        if wrote and (paragraph.text or "").strip():
            target.add_run(" ")
        for item in paragraph.iter_inner_content():
            if isinstance(item, Hyperlink):
                if item.text:
                    target._p.append(deepcopy(item._hyperlink))
                    wrote = True
                continue
            if not item.text:
                continue
            new_run = target.add_run(item.text)
            if item._r.rPr is not None:
                new_run._r.insert(0, deepcopy(item._r.rPr))
            wrote = True


def _flatten_tables_for_ats(document) -> Dict[str, Any] | None:
    """Turn tables into ordered body paragraphs without changing content.

    ATS parsers frequently interleave table cells. The master remains untouched;
    only the generated copy is normalized. A token-multiset check fails closed
    if a cell was lost or duplicated (including merged-cell edge cases).
    """
    tables = list(document.tables)
    if not tables:
        return None
    before_tokens = _semantic_tokens(document)
    evidence = []

    for table_index, table in enumerate(tables):
        row_count = 0
        for row in table.rows:
            # python-docx repeats the same XML cell for horizontal merges.
            cells = []
            seen_cells = set()
            for cell in row.cells:
                identity = id(cell._tc)
                if identity in seen_cells:
                    continue
                seen_cells.add(identity)
                if (cell.text or "").strip():
                    cells.append(cell)
            if not cells:
                continue
            paragraph = document.add_paragraph()
            # Moving the newly appended node before the table keeps exact table
            # order while producing a normal single-column document flow.
            table._tbl.addprevious(paragraph._p)
            # "Title | Company" and "Jan 2019 - Present" in two cells is a role
            # line with right-aligned dates. Two spaces lost the alignment; a
            # right tab stop at the text width keeps it (R10). Only a dates
            # column goes right: "Platforms | SQL, Spark, …" is a label and its
            # list, and other rows keep the plain gap.
            two_column = len(cells) == 2 and bool(_EMPLOYMENT_DATE_RE.search(cells[1].text or "")) \
                and len((cells[1].text or "").strip()) <= 40
            if two_column:
                section = document.sections[0]
                width = section.page_width - section.left_margin - section.right_margin
                paragraph.paragraph_format.tab_stops.add_tab_stop(width, WD_TAB_ALIGNMENT.RIGHT)
            for cell_index, cell in enumerate(cells):
                if cell_index:
                    paragraph.add_run("\t" if two_column else "  ")
                _copy_cell_content(paragraph, cell)
            row_count += 1
        table._tbl.getparent().remove(table._tbl)
        evidence.append({
            "table_index": table_index,
            "rows_converted": row_count,
            "source": "master_resume",
        })

    after_tokens = _semantic_tokens(document)
    if after_tokens != before_tokens:
        raise RuntimeError("ATS table normalization changed or duplicated resume text")
    return {
        "type": "flatten_tables_for_ats",
        "where": "generated resume layout",
        "before": f"{len(tables)} table(s)",
        "after": "single-column paragraphs (0 tables)",
        "evidence": evidence,
        "reason": (
            "converted layout tables to top-to-bottom text so ATS parsers keep "
            "the intended reading order; the content-token multiset is unchanged"
        ),
        "source": "master_resume",
    }


def _is_section_heading(text: str) -> bool:
    """Recognize a section heading, including combined ones.

    Résumés routinely merge two sections into one line — "EDUCATION &
    CERTIFICATIONS", "SKILLS / TOOLS". Matching only exact single names left
    those unrecognized, which silently extended the PROFESSIONAL EXPERIENCE
    section to the end of the document and put education lines inside the scope
    that reorders and trims role content.
    """
    normalized = _norm_heading(text)
    if not normalized:
        return False
    if normalized in _SECTION_HEADINGS:
        return True
    if len(normalized) > 60 or _EMPLOYMENT_DATE_RE.search(normalized):
        return False
    parts = [part.strip() for part in re.split(r"\s*(?:&|/|\band\b|,)\s*", normalized) if part.strip()]
    return len(parts) > 1 and all(part in _SECTION_HEADINGS for part in parts)


def _is_role_heading(paragraph) -> bool:
    """A role/employer/date line — the anchor of one employment block."""
    text = (paragraph.text or "").strip()
    if not text or _is_section_heading(text):
        return False
    # A bullet is content, never the anchor of a role, even when it mentions a
    # date ("Led the March 2021 migration…"). Long prose lines are the same.
    if _is_bullet(paragraph) or len(text) > 160:
        return False
    if not _EMPLOYMENT_DATE_RE.search(text):
        return False
    return not _in_non_role_section(paragraph)


def _non_role_heading(text: str) -> bool:
    """A heading whose section holds no employment: education, skills, summary…"""
    normalized = _norm_heading(text)
    if normalized in _NON_ROLE_SECTIONS:
        return True
    parts = [part.strip() for part in re.split(r"\s*(?:&|/|\band\b|,)\s*", normalized) if part.strip()]
    return len(parts) > 1 and all(part in _NON_ROLE_SECTIONS for part in parts)


def _in_non_role_section(paragraph) -> bool:
    """Is the nearest section heading above this paragraph one that holds no roles?

    A dated line is a role only in a section that can hold one. Role detection
    used to scan every paragraph, so "B.S. Computer Science, …, 2012 - 2016"
    was a role, and when education came first it became the CURRENT role:
    the page fit's never-drop protection guarded an education line and the
    real current role's required evidence was omitted (R4). With no heading
    above at all (a resume without headings), dated lines stay roles.
    """
    from docx.oxml.ns import qn
    from docx.text.paragraph import Paragraph

    for sibling in paragraph._p.itersiblings(preceding=True):
        if sibling.tag != qn("w:p"):
            continue
        text = (Paragraph(sibling, paragraph._parent).text or "").strip()
        if text and _is_section_heading(text):
            return _non_role_heading(text)
    return False


def _remove_paragraph(paragraph) -> None:
    element = paragraph._p
    parent = element.getparent()
    if parent is not None:
        parent.remove(element)


def _strip_hard_page_breaks(document) -> int:
    """Delete every manual page break in the body.

    A résumé of this shape must flow. A hard break says "start page 2 HERE"
    regardless of how much of page 1 is filled, which is exactly how a document
    ends up with a half-empty page and one more page than it needs. Word's
    keep-with-next / keep-together (applied in `_protect_headings`) achieves the
    real goal — no orphaned heading — without freezing the pagination.

    These breaks also arrive from OUTSIDE: a tailored copy that gets saved back
    over the master carries its layout artifacts into every future run, so they
    are removed on the way in as well as never written on the way out.
    """
    from docx.oxml.ns import qn

    removed = 0
    for paragraph in list(document.paragraphs):
        here = 0
        for run in list(paragraph.runs):
            for br in list(run._r.findall(qn("w:br"))):
                if br.get(qn("w:type")) == "page":
                    run._r.remove(br)
                    here += 1
        properties = paragraph._p.pPr
        if properties is not None and properties.find(qn("w:pageBreakBefore")) is not None:
            properties.remove(properties.find(qn("w:pageBreakBefore")))
            here += 1
        removed += here
        # A paragraph that existed ONLY to carry the break is now blank filler
        # holding open exactly the gap we are trying to close.
        if here and not (paragraph.text or "").strip():
            _remove_paragraph(paragraph)
    return removed


def _split_round_tripped_roles(document) -> int:
    """Undo role blocks that a previous pass folded into one paragraph.

    An earlier implementation merged "role title", "employer • dates" and the
    first bullet into a SINGLE paragraph joined by a line break, to defeat
    renderers that ignore keep-with-next. The cost was formatting: that first
    bullet lost its bullet glyph and picked up four literal spaces of fake
    indent, so every role's first point rendered differently from its siblings.

    Word honors keep-with-next, so the merge is unnecessary — and because the
    master resume is itself a round-trip of an earlier tailored copy, the damage
    has to be undone on the way in. Runs are moved, never rewritten, so the
    text is bit-identical either side of the split.
    """
    from docx.oxml.ns import qn

    split = 0
    for paragraph in list(document.paragraphs):
        if not _is_role_heading(paragraph):
            continue
        children = list(paragraph._p)
        break_index = None
        for index, child in enumerate(children):
            if child.tag != qn("w:r"):
                continue
            if any(br.get(qn("w:type")) in (None, "textWrapping") for br in child.findall(qn("w:br"))):
                break_index = index
                break
        if break_index is None:
            continue
        tail = children[break_index:]
        # The run holding the break may also hold text; keep only the break's
        # own run out of the tail and drop the break element itself.
        head_run = tail[0]
        for br in list(head_run.findall(qn("w:br"))):
            head_run.remove(br)
        if not head_run.findall(qn("w:t")):
            tail = tail[1:]
            paragraph._p.remove(head_run)
        if not tail:
            continue

        # python-docx has insert_paragraph_before but no "after", so the new
        # paragraph element is placed directly.
        from docx.text.paragraph import Paragraph

        new_element = paragraph._p.makeelement(qn("w:p"), {})
        paragraph._p.addnext(new_element)
        follower = Paragraph(new_element, paragraph._parent)
        for child in tail:
            paragraph._p.remove(child)
            follower._p.append(child)
        # Drop the fake indent the merge introduced, then adopt the formatting of
        # the sibling bullets this line belongs with.
        for run in follower.runs:
            if run.text and not run.text.strip():
                run.text = ""
        first = next((run for run in follower.runs if run.text), None)
        if first is not None:
            first.text = first.text.lstrip()
        # An italic lead line ("Short-term engagement: …") is a role
        # description, not a bullet, and stays as it is. Anything else is a
        # bullet that lost its formatting in the merge, so it adopts the exact
        # formatting of its siblings — looking forward first, then backward for
        # the last role in a section, which has no bullet after it to copy.
        if not _all_italic(follower):
            sibling = _sibling_bullet(document, follower)
            if sibling is not None:
                _adopt_bullet_formatting(follower, sibling)
        split += 1
    return split


def _sibling_bullet(document, paragraph):
    """Nearest bullet in the same section, looking forward then backward."""
    paragraphs = document.paragraphs
    index = next(
        (i for i, candidate in enumerate(paragraphs) if candidate._p is paragraph._p),
        None,
    )
    if index is None:
        return None
    for direction in (1, -1):
        cursor = index + direction
        while 0 <= cursor < len(paragraphs):
            candidate = paragraphs[cursor]
            text = (candidate.text or "").strip()
            if text and _is_section_heading(text):
                break
            if text and _is_bullet(candidate):
                return candidate
            cursor += direction
    return None


def _adopt_bullet_formatting(paragraph, model) -> None:
    """Copy a model bullet's style, indent, and numbering onto `paragraph`."""
    from docx.oxml.ns import qn

    paragraph.style = model.style
    paragraph.paragraph_format.left_indent = model.paragraph_format.left_indent
    paragraph.paragraph_format.first_line_indent = model.paragraph_format.first_line_indent
    model_properties = model._p.pPr
    if model_properties is None:
        return
    numbering = model_properties.find(qn("w:numPr"))
    if numbering is None:
        return
    properties = paragraph._p.get_or_add_pPr()
    existing = properties.find(qn("w:numPr"))
    if existing is not None:
        properties.remove(existing)
    properties.append(deepcopy(numbering))


def _all_italic(paragraph) -> bool:
    """Is every run italic? Marks a role's descriptive lead, not a bullet."""
    runs = [run for run in paragraph.runs if (run.text or "").strip()]
    return bool(runs) and all(run.italic for run in runs)


def _next_content_paragraph(document, paragraph):
    paragraphs = document.paragraphs
    for index, candidate in enumerate(paragraphs):
        if candidate._p is paragraph._p:
            for follower in paragraphs[index + 1:]:
                if (follower.text or "").strip():
                    return follower
            return None
    return None


def _collapse_blank_paragraphs(document) -> int:
    """Remove runs of blank paragraphs that open a gap in the page.

    One blank line between sections is deliberate spacing. Two or more in a row
    (and any trailing at the very end of the document) are leftovers from
    editing or from a previous pass deleting content, and they read as the
    "wide empty space" the layout is judged on.
    """
    removed = 0
    blanks_in_row = 0
    for paragraph in list(document.paragraphs):
        if (paragraph.text or "").strip():
            blanks_in_row = 0
            continue
        blanks_in_row += 1
        if blanks_in_row > 1:
            _remove_paragraph(paragraph)
            removed += 1
    for paragraph in reversed(document.paragraphs):
        if (paragraph.text or "").strip():
            break
        _remove_paragraph(paragraph)
        removed += 1
    return removed


_URI_PREFIX_RE = re.compile(r"^\s*(?:mailto:|tel:)", re.IGNORECASE)


def _clean_uri_display_text(document) -> int:
    """Show `you@example.com`, not `mailto:you@example.com`.

    Pasting a hyperlink into Word leaves the URI scheme in the VISIBLE text.
    Removing the prefix changes no address and no claim — it is the same
    contact detail, spelled the way a human reads it, and the hyperlink's own
    target is untouched so the link still works.

    Iterates `w:t` elements rather than `paragraph.runs`: contact details are
    normally inside a `w:hyperlink`, whose runs are not direct children of the
    paragraph and so never appeared in `runs` at all.
    """
    from docx.oxml.ns import qn

    cleaned = 0
    for paragraph in document.paragraphs:
        for node in paragraph._p.iter(qn("w:t")):
            if node.text and _URI_PREFIX_RE.match(node.text):
                node.text = _URI_PREFIX_RE.sub("", node.text, count=1)
                cleaned += 1
    return cleaned


def _normalize_layout(document) -> Dict[str, Any] | None:
    """Repair layout artifacts (including ones inherited from the master)."""
    breaks = _strip_hard_page_breaks(document)
    roles_split = _split_round_tripped_roles(document)
    blanks = _collapse_blank_paragraphs(document)
    uris = _clean_uri_display_text(document)
    if not any((breaks, roles_split, blanks, uris)):
        return None
    details = []
    if breaks:
        details.append(f"{breaks} manual page break(s) removed so the text reflows")
    if roles_split:
        details.append(f"{roles_split} role block(s) un-merged so every bullet formats alike")
    if blanks:
        details.append(f"{blanks} redundant blank line(s) removed")
    if uris:
        details.append(f"{uris} link(s) shown without their mailto:/tel: prefix")
    return {
        "type": "normalize_layout",
        "where": "document layout",
        "before": "manual page breaks, merged role blocks, and blank filler from earlier edits",
        "after": "; ".join(details),
        "evidence": [{
            "page_breaks_removed": breaks,
            "role_blocks_split": roles_split,
            "blank_paragraphs_removed": blanks,
            "uri_prefixes_cleaned": uris,
        }],
        "reason": (
            "manual breaks and merged blocks are what produce half-empty pages and "
            "inconsistent bullets; no wording, claim, or date is affected"
        ),
        "source": "master_resume",
    }


# ── page-fit geometry ────────────────────────────────────────────────────────
# The estimate and the LibreOffice measurement live in src/resume/pagefit.py
# (audit R6): style- and font-aware, calibrated against LibreOffice renders.
estimate_page_count = pagefit.estimate_page_count


# A bullet that states a measured result: a number with a unit, a currency
# amount, a multiplier, or a count of something. These are the lines a
# reviewer remembers ("cut month-end close from 5 days to 2"), and the old
# fitter dropped them as readily as filler whenever they did not repeat a term
# from the posting.
_IMPACT_RE = re.compile(
    r"[$€£₹]\s?\d|\d+(?:\.\d+)?\s?(?:%|percent|x\b|×|k\b|m\b|mm\b|bn?\b|million|billion|"
    r"thousand|hours?|days?|weeks?|months?|minutes?|seconds?|users?|customers?|clients?|"
    r"people|engineers?|teams?|records?|rows?|tb|gb|pb|countries|states|sites|stores)"
    r"|\b(?!(?:19|20)\d{2}\b)\d{2,}[+]?(?:,\d{3})*\b",
    re.IGNORECASE,
)


def _has_impact(text: str) -> bool:
    return bool(_IMPACT_RE.search(text or ""))


def _norm_bullet(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip().lower())


#: Most LibreOffice renders one page fit may run (each takes about a second).
_MAX_FIT_MEASUREMENTS = 8


def _fit_to_pages(
    document,
    *,
    max_pages: int,
    keywords: Sequence[str],
    qualification_details: Dict[str, Dict[str, Any]],
    min_bullets_per_role: int = 1,
    keep_bullets: Sequence[str] | None = None,
    measure: Any = None,
) -> tuple[Dict[str, Any] | None, List[str]]:
    """Trim the résumé to `max_pages` by omitting the LEAST VALUABLE bullets.

    MEASURED, NOT ONLY ESTIMATED (R6). With ``measure`` (a document -> pages
    callable; LibreOffice in practice, see src/resume/pagefit.py), the estimate
    only proposes how many bullets to leave out. The real page count then
    decides, by a short search over that same order: the fewest bullets that
    bring the rendered document within budget. Bullets the estimate would have
    dropped needlessly are kept, and a document the estimate thought fit but
    renders long is trimmed. Without ``measure`` it works on the estimate alone.

    Value is not just keyword overlap. Each bullet is scored on three things a
    reviewer actually weighs, and the lowest-value bullets go first:

      - relevance: evidence for a requirement in THIS posting (required terms
        outweigh preferred ones, which outweigh unclassified ones);
      - impact: a measured result (a number, %, money, a count) is kept ahead
        of an unmeasured duty;
      - recency: the current role is read first and kept deepest.

    Guarantees:
      - No role, employer, date, section heading, summary, or competency line is
        ever removed, and whole bullets only: nothing is shortened or reworded.
      - The current role's bullets that evidence a REQUIRED qualification are
        never omitted, and neither is anything pinned with `keep_bullets`.
      - The two most recent roles keep at least two bullets each (or all they
        have); every other role keeps at least `min_bullets_per_role`.
      - When the budget cannot be met within those rules the résumé is left
        LONGER rather than thinner, and a limitation says so: losing a real,
        relevant achievement costs more than a third page.
    """
    if max_pages <= 0:
        return None, []
    if estimate_page_count(document) <= max_pages:
        if measure is None:
            return None, []
        first = measure(document)
        if first is None or first <= max_pages:
            return None, []

    pinned = {_norm_bullet(text) for text in (keep_bullets or []) if str(text or "").strip()}
    roles: List[Dict[str, Any]] = []
    current: Dict[str, Any] | None = None
    previous_line = ""
    for paragraph in document.paragraphs:
        text = (paragraph.text or "").strip()
        if _is_role_heading(paragraph):
            # Name the role by its title line when the dates sit on their own
            # line under it ("Senior Engineer | Contoso" then "Remote | 2020 -
            # Present"), so an omission can say which job it came from.
            label = f"{previous_line} | {text}" if previous_line and not _EMPLOYMENT_DATE_RE.search(previous_line) else text
            current = {"heading": label, "bullets": []}
            roles.append(current)
            previous_line = ""
            continue
        if text and not _is_bullet(paragraph) and not _is_section_heading(text):
            previous_line = text
        elif text:
            previous_line = ""
        if current is None:
            continue
        if _is_section_heading(paragraph.text):
            current = None
            continue
        if _is_bullet(paragraph) and (paragraph.text or "").strip():
            current["bullets"].append(paragraph)

    total_roles = len(roles)
    candidates: List[tuple] = []
    for role_index, role in enumerate(roles):
        bullets = role["bullets"]
        floor = min(len(bullets), 2) if role_index < 2 else min(len(bullets), max(1, min_bullets_per_role))
        recency = {0: 4, 1: 2, 2: 1}.get(role_index, 0)
        scored = []
        for position, paragraph in enumerate(bullets):
            text = paragraph.text or ""
            evidence = _matches_for_text(text, keywords, qualification_details)
            relevance = _relevance_key(evidence)
            impact = _has_impact(text)
            # The current role's evidence for a REQUIRED qualification is what
            # this application stands on; older required evidence is ranked
            # high but can still go when the budget demands it.
            protected = _norm_bullet(text) in pinned or (
                role_index == 0 and relevance[0] >= _QUALIFICATION_WEIGHT["required"]
            )
            value = relevance[0] * 4 + min(relevance[1], 6) + (3 if impact else 0) + recency
            scored.append({
                "paragraph": paragraph, "value": value, "protected": protected, "impact": impact,
                "terms": [item["keyword"] for item in evidence], "position": position,
            })
        # Only the lowest-value bullets above the role's floor are candidates.
        droppable = sorted(
            (item for item in scored if not item["protected"]),
            key=lambda item: (item["value"], -item["position"]),
        )
        removable = max(0, len(bullets) - floor)
        for item in droppable[:removable]:
            # Older roles go first on ties; within a role, the later bullet.
            candidates.append((item["value"], -(total_roles - role_index), -item["position"], role, item))
    candidates.sort(key=lambda entry: entry[:3])

    # Every candidate in leave-out order. `apply(k)` sets exactly the first k
    # aside, from a snapshot of the body, so a search can put bullets back.
    body = document.element.body
    original = list(body)
    order = [entry[4]["paragraph"]._p for entry in candidates]

    def apply(k: int) -> None:
        gone = {id(node) for node in order[:k]}
        for child in list(body):
            body.remove(child)
        for child in original:
            if id(child) not in gone:
                body.append(child)

    k = 0
    while k < len(order) and estimate_page_count(document) > max_pages:
        k += 1
        apply(k)

    pages = None
    measurements = 0
    if measure is not None:
        seen: Dict[int, Any] = {}

        def pages_at(n: int):
            nonlocal measurements
            if n not in seen:
                apply(n)
                seen[n] = measure(document)
                measurements += 1
            return seen[n]

        at_estimate = pages_at(k)
        if at_estimate is not None:
            if at_estimate <= max_pages:
                lo, hi = 0, k  # the estimate may have trimmed more than needed
            elif pages_at(len(order)) is not None and pages_at(len(order)) > max_pages:
                lo = hi = len(order)  # cannot fit within the rules: leave all candidates out
            else:
                lo, hi = k + 1, len(order)
            while lo < hi and measurements < _MAX_FIT_MEASUREMENTS:
                mid = (lo + hi) // 2
                result = pages_at(mid)
                if result is None:
                    break
                if result <= max_pages:
                    hi = mid
                else:
                    lo = mid + 1
            k = hi
            pages = pages_at(k)
        apply(k)

    dropped: List[Dict[str, Any]] = []
    for _value, _age, _pos, role, item in candidates[:k]:
        paragraph = item["paragraph"]
        raw = paragraph.text or ""
        reasons = []
        reasons.append("matches no requirement in this posting" if not item["terms"]
                       else f"only matches {', '.join(item['terms'][:3])}")
        if not item["impact"]:
            reasons.append("states no measured result")
        dropped.append({
            "text": raw.strip(),
            # The exact content-unit key, so the invariant can account for this
            # removal byte-for-byte even when the bullet had stray whitespace.
            "unit": f"paragraph:{raw}",
            "role": role["heading"][:160],
            "has_metric": item["impact"],
            "jd_terms": item["terms"],
            "reason": "; ".join(reasons),
        })

    estimated = estimate_page_count(document)
    length = f"{pages} page(s), measured" if pages is not None else f"an estimated {estimated:.1f} pages"
    if not dropped and pages is not None and pages <= max_pages:
        return None, []  # the estimate thought it long; the render says it fits
    if not dropped:
        return None, [
            f"The résumé is {length}, over the {max_pages}-page target. "
            "Nothing was left out: every remaining bullet is recent, measured, or evidences a "
            "requirement of this posting. Shorten wording in the master resume if length matters."
        ]

    limitations: List[str] = []
    if (pages if pages is not None else estimated) > max_pages:
        limitations.append(
            f"Still {length} after leaving out {len(dropped)} bullet(s). "
            "The rest were kept on purpose (recent, measured, or required by this posting)."
        )
    return {
        "type": "fit_to_page_budget",
        "where": "PROFESSIONAL EXPERIENCE bullets",
        "before": f"content estimated at more than {max_pages} page(s)",
        "after": f"{len(dropped)} lowest-value bullet(s) omitted; "
                 + (f"{pages} page(s), measured by LibreOffice" if pages is not None else f"estimated {estimated:.1f} page(s)"),
        "evidence": [{
            "max_pages": max_pages,
            "omitted": dropped,
            "roles_kept": len(roles),
            "min_bullets_per_role": min_bullets_per_role,
            "pinned": len(pinned),
            "text_changed": False,
            "pages": pages if pages is not None else round(estimated, 2),
            "measured_by": "LibreOffice" if pages is not None else None,
            "measurements": measurements,
        }],
        "reason": (
            f"a {max_pages}-page résumé is the target; the bullets omitted are the ones with the "
            "least relevance to this posting, no measured result, and the oldest role. Nothing "
            "was shortened or reworded, required-skill evidence is never omitted, and every "
            "role keeps its heading, dates, and detail"
        ),
        "source": "master_resume",
    }, limitations


def _protect_headings(document) -> Dict[str, Any] | None:
    """Keep headings with their content, using Word's own pagination rules.

    This replaces the previous approach of merging paragraphs and injecting a
    hard page break. `keep_with_next` on a heading and `keep_together` on a role
    block express the intent — "do not strand this" — and let the renderer place
    the page boundary wherever the content actually reaches it.
    """
    before_tokens = _semantic_tokens(document)
    paragraphs = document.paragraphs
    changed = set()
    roles = 0
    for index, paragraph in enumerate(paragraphs):
        text = (paragraph.text or "").strip()
        if not text or index + 1 >= len(paragraphs):
            continue
        fmt = paragraph.paragraph_format
        if _is_section_heading(text):
            fmt.keep_with_next = True
            fmt.widow_control = True
            changed.add(index)
            continue
        if _is_role_heading(paragraph):
            # The heading, and whatever line follows it, travel together.
            fmt.keep_with_next = True
            fmt.keep_together = True
            fmt.widow_control = True
            changed.add(index)
            roles += 1
            # Many résumés put the job title on one line and "Employer • dates"
            # on the next. That title is part of the same block: without this it
            # can be left alone at the foot of a page while its own dates and
            # bullets start the next one.
            for back in range(index - 1, -1, -1):
                previous = paragraphs[back]
                text_before = (previous.text or "").strip()
                if not text_before:
                    continue
                if _is_section_heading(text_before) or _is_bullet(previous) \
                        or _is_role_heading(previous):
                    break
                previous.paragraph_format.keep_with_next = True
                previous.paragraph_format.keep_together = True
                previous.paragraph_format.widow_control = True
                changed.add(back)
                break
            follower = paragraphs[index + 1]
            if (follower.text or "").strip() and not _is_role_heading(follower):
                follower.paragraph_format.widow_control = True
                changed.add(index + 1)
            continue
        if _is_bullet(paragraph):
            # A bullet that splits across pages is fine; one dangling line is not.
            fmt.widow_control = True
            changed.add(index)

    if _semantic_tokens(document) != before_tokens:
        raise RuntimeError("heading protection changed or duplicated resume text")
    if not changed:
        return None
    return {
        "type": "stabilize_page_breaks",
        "where": "section and employment headings",
        "before": "headings could be separated from their first content line",
        "after": (
            f"{len(changed)} paragraph(s) kept with their following context "
            f"across {roles} role block(s); no manual page breaks used"
        ),
        "evidence": [{
            "paragraph_indexes": sorted(changed),
            "role_blocks": roles,
            "manual_page_breaks": 0,
            "text_changed": False,
        }],
        "reason": (
            "prevents orphaned headings with the renderer's own keep-together rules, so the "
            "text still reflows instead of being frozen by a hard break"
        ),
        "source": "master_resume",
    }


def _norm_heading(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip().lower())


_SUMMARY_HEADINGS = _HEADING_KINDS["summary"]
_EXPERIENCE_HEADINGS = _HEADING_KINDS["experience"]


class _section_heading_overrides:
    """Add a person's own section names (ats_resume.json "sectionHeadings") for one tailoring.

    The heading tables are module-level, read by many helpers; this widens them
    for the duration of a call and puts them back after, so a long-lived
    worker serving several people never carries one person's names over.
    """

    def __init__(self, headings: Dict[str, Sequence[str]] | None):
        self.headings = {kind: {_norm_heading(n) for n in names or [] if str(n).strip()}
                         for kind, names in (headings or {}).items() if kind in _HEADING_KINDS}
        self.saved = None

    def __enter__(self):
        tables = [_SECTION_HEADINGS, _COMPETENCY_HEADINGS, _NON_ROLE_SECTIONS, *_HEADING_KINDS.values()]
        self.saved = [(table, set(table)) for table in tables]
        for kind, names in self.headings.items():
            _HEADING_KINDS[kind].update(names)
            _SECTION_HEADINGS.update(names)
            if kind == "skills":
                _COMPETENCY_HEADINGS.update(names)
            if kind in ("summary", "skills", "education"):
                _NON_ROLE_SECTIONS.update(names)
        return self

    def __exit__(self, *exc):
        for table, before in self.saved:
            table.clear()
            table.update(before)
        return False


def _looks_like_heading(paragraph) -> bool:
    """A short line set like a heading: capitals, a Heading style, or all bold.

    Ends the section above it even when its name is unknown, so one section's
    lines never run on into the next (R14).
    """
    text = (paragraph.text or "").strip()
    if not text or len(text) > 40 or len(text.split()) > 5 or re.search(r"[\d@|:,.;]", text):
        return False
    if _is_bullet(paragraph):
        return False
    style = (getattr(paragraph.style, "name", "") or "").lower()
    if style.startswith("heading") or style == "title":
        return True
    letters = [c for c in text if c.isalpha()]
    if letters and all(c.isupper() for c in letters) and len(letters) >= 4:
        return True
    runs = [run for run in paragraph.runs if (run.text or "").strip()]
    return bool(runs) and all(run.bold for run in runs)


def _ends_section(paragraph) -> bool:
    return _is_section_heading(paragraph.text) or _looks_like_heading(paragraph)


def _section_bounds(document, headings: set[str]) -> tuple[int, int] | None:
    """Locate a known section in the body-paragraph sequence."""
    paragraphs = document.paragraphs
    start = next(
        (index for index, para in enumerate(paragraphs) if _norm_heading(para.text) in headings),
        None,
    )
    if start is None:
        # The section holding the jobs is experience, whatever it is called (R14).
        if headings is _EXPERIENCE_HEADINGS:
            return _experience_bounds_by_roles(paragraphs)
        return None
    end = len(paragraphs)
    for index in range(start + 1, len(paragraphs)):
        if _ends_section(paragraphs[index]):
            end = index
            break
    return start + 1, end


def _experience_bounds_by_roles(paragraphs) -> tuple[int, int] | None:
    """The section around the first job line, when no heading names experience."""
    first_role = next((i for i, p in enumerate(paragraphs) if _is_role_heading(p)), None)
    if first_role is None:
        return None
    start = 0
    for index in range(first_role - 1, 0, -1):  # index 0 is the name line
        if _ends_section(paragraphs[index]):
            start = index + 1
            break
    end = len(paragraphs)
    for index in range(first_role + 1, len(paragraphs)):
        if _ends_section(paragraphs[index]) and not _is_role_heading(paragraphs[index]):
            end = index
            break
    return start, end


#: Characters a person types to start a bullet by hand. Only "• · ▪ ◦" were
#: known, so "- ", "– ", "* ", "● ", "■ " and "➢ " lines were never bullets:
#: never reordered or trimmed, and one with a date in it ("- Led the March
#: 2021 migration") became a role heading (R5). Whitespace must follow the
#: glyph, so "-5%" and "*Required" stay text.
_BULLET_GLYPHS = re.escape("•·▪◦‣⁃○●■□◆◇►▸▹➢➤✓✔-–—*")
_TYPED_BULLET_RE = re.compile(rf"^\s*[{_BULLET_GLYPHS}]\s+(?=\S)")
#: The same glyph at the start of rendered HTML, after any opening tags.
_LEADING_GLYPH_HTML_RE = re.compile(rf"^((?:<[^>]+>)*)\s*[{_BULLET_GLYPHS}]\s+(?=\S)")


def _is_bullet(paragraph) -> bool:
    style_name = (getattr(paragraph.style, "name", "") or "").lower()
    if "list" in style_name or "bullet" in style_name:
        return True
    ppr = paragraph._p.pPr
    if ppr is not None and ppr.numPr is not None:
        return True
    return bool(_TYPED_BULLET_RE.match(paragraph.text or ""))


def _nonempty_runs(paragraphs: Sequence[Any]) -> List[List[Any]]:
    """Return movable paragraph groups without moving blank spacers."""
    groups: List[List[Any]] = []
    current: List[Any] = []
    for paragraph in paragraphs:
        if (paragraph.text or "").strip():
            current.append(paragraph)
        elif current:
            groups.append(current)
            current = []
    if current:
        groups.append(current)
    return groups


def _bullet_runs(paragraphs: Sequence[Any]) -> List[List[Any]]:
    """Return contiguous bullet groups; role/header anchors remain untouched."""
    groups: List[List[Any]] = []
    current: List[Any] = []
    for paragraph in paragraphs:
        if _is_bullet(paragraph) and (paragraph.text or "").strip():
            current.append(paragraph)
        elif current:
            groups.append(current)
            current = []
    if current:
        groups.append(current)
    return groups


def _reorder_paragraph_nodes(group: Sequence[Any], ordered: Sequence[Any]) -> None:
    """Move existing XML paragraph nodes in place, without cloning content."""
    if list(group) == list(ordered):
        return
    nodes = [paragraph._p for paragraph in group]
    parent = nodes[0].getparent()
    if any(node.getparent() is not parent for node in nodes):
        raise RuntimeError("refusing to move resume content across XML parents")
    anchor = nodes[-1].getnext()
    for node in nodes:
        parent.remove(node)
    for paragraph in ordered:
        node = paragraph._p
        if anchor is None:
            parent.append(node)
        else:
            anchor.addprevious(node)


def _prioritize_group(
    group: Sequence[Any],
    *,
    keywords: Sequence[str],
    qualification_details: Dict[str, Dict[str, Any]],
    change_type: str,
    where: str,
) -> tuple[Dict[str, Any] | None, List[Dict[str, Any]]]:
    """Stably rank one exact-text paragraph group by qualification relevance."""
    ranked_items = []
    selected: List[Dict[str, Any]] = []
    for index, paragraph in enumerate(group):
        evidence = _matches_for_text(paragraph.text, keywords, qualification_details)
        key = _relevance_key(evidence)
        ranked_items.append((paragraph, index, key, evidence))
        if evidence:
            selected.append({
                "where": where,
                "text": paragraph.text,
                "original_index": index,
                "matches": evidence,
                "source": "master_resume",
            })

    ordered_items = sorted(
        ranked_items,
        key=lambda item: (-item[2][0], -item[2][1], -item[2][2], item[1]),
    )
    ordered = [item[0] for item in ordered_items]
    if list(group) == ordered or not selected:
        return None, selected

    before = [paragraph.text for paragraph in group]
    after = [paragraph.text for paragraph in ordered]
    if Counter(before) != Counter(after):
        raise RuntimeError("paragraph prioritization changed the source text multiset")
    _reorder_paragraph_nodes(group, ordered)
    return ({
        "type": change_type,
        "where": where,
        "before": before,
        "after": after,
        "reason": (
            "existing supported content ranked required before preferred/other content; "
            "paragraph text and formatting were not rewritten"
        ),
        "evidence": selected,
        "source": "master_resume",
    }, selected)


def _prioritize_existing_content(
    document,
    keywords: Sequence[str],
    qualification_details: Dict[str, Dict[str, Any]],
) -> tuple[List[Dict[str, Any]], Dict[str, List[Dict[str, Any]]], set]:
    """Prioritize summary paragraphs and bullets without changing role scope."""
    changes: List[Dict[str, Any]] = []
    selected = {"summary": [], "experience": []}
    movable_nodes = set()

    summary_bounds = _section_bounds(document, _SUMMARY_HEADINGS)
    if summary_bounds is not None:
        start, end = summary_bounds
        for group_index, group in enumerate(_nonempty_runs(document.paragraphs[start:end]), 1):
            movable_nodes.update(paragraph._p for paragraph in group)
            change, evidence = _prioritize_group(
                group,
                keywords=keywords,
                qualification_details=qualification_details,
                change_type="reorder_summary",
                where=f"professional summary group {group_index}",
            )
            selected["summary"].extend(evidence)
            if change:
                changes.append(change)

    # Re-read paragraphs after any summary movement. XML paragraph objects are
    # preserved, but their list positions have changed.
    experience_bounds = _section_bounds(document, _EXPERIENCE_HEADINGS)
    if experience_bounds is not None:
        start, end = experience_bounds
        experience_paragraphs = document.paragraphs[start:end]
        for group_index, group in enumerate(_bullet_runs(experience_paragraphs), 1):
            movable_nodes.update(paragraph._p for paragraph in group)
            first_index = experience_paragraphs.index(group[0])
            scope = "role bullet group"
            for prior in reversed(experience_paragraphs[:first_index]):
                if (prior.text or "").strip() and not _is_bullet(prior):
                    scope = prior.text.strip()
                    break
            where = f"professional experience / {scope} / group {group_index}"
            change, evidence = _prioritize_group(
                group,
                keywords=keywords,
                qualification_details=qualification_details,
                change_type="reorder_experience_bullets",
                where=where,
            )
            selected["experience"].extend(evidence)
            if change:
                changes.append(change)

    return changes, selected, movable_nodes


def _evidence_terms(
    keyword: str,
    evidence_aliases: Dict[str, Sequence[str]] | None,
) -> List[str]:
    """Return the JD term followed by configured truthful equivalents."""
    aliases = {
        re.sub(r"\s+", " ", str(term).lower()).strip(): list(values or [])
        for term, values in (evidence_aliases or {}).items()
    }
    result: List[str] = []
    seen = set()
    key = re.sub(r"\s+", " ", str(keyword).lower()).strip()
    for term in [keyword, *aliases.get(key, [])]:
        normalized = re.sub(r"\s+", " ", str(term).lower()).strip()
        if normalized and normalized not in seen:
            seen.add(normalized)
            result.append(str(term))
    return result


def _audit_supported_keywords(
    resume_text: str,
    keywords: Sequence[str],
    evidence_aliases: Dict[str, Sequence[str]] | None = None,
    vocabulary: Sequence[str] | None = None,
) -> Dict[str, Any]:
    """Boundary-aware audit used for mutation decisions.

    The general reporting audit historically uses substring matching. Tailoring
    must be stricter: e.g. ``go`` inside ``Golang`` is not evidence of Go, and
    ``C`` inside every sentence is not evidence of the C language.
    """
    present: List[str] = []
    missing: List[str] = []
    supported_by: Dict[str, List[Dict[str, str]]] = {}
    seen = set()
    keywords = [str(k) for k in keywords]
    lines = resume_text.splitlines()
    alias_map = {term: _evidence_terms(term, evidence_aliases)[1:] for term in keywords}
    for keyword in keywords:
        key = re.sub(r"\s+", " ", str(keyword).lower()).strip()
        if not key or key in seen:
            continue
        seen.add(key)
        matches = evidence.find_evidence(
            str(keyword), lines, aliases=alias_map, vocabulary=keywords if vocabulary is None else vocabulary,
        )
        target = present if matches else missing
        target.append(keyword)
        if matches:
            supported_by[str(keyword)] = matches
    return {
        "present": present,
        "missing": missing,
        "supported_by": supported_by,
    }


def _apply_llm_qualifications(
    qualifications: Dict[str, Any],
    llm: Dict[str, Sequence[str]] | None,
) -> Dict[str, Any]:
    """Upgrade requirement classifications using grounded LLM labels.

    Only ever UPGRADES confidence (unclassified -> preferred -> required); it
    never demotes a classification the job description stated explicitly through
    a real heading, because that heading is stronger evidence than a model's
    reading of the same text.

    Safety: this influences the ORDER in which already-present resume content is
    presented. It cannot add, remove, or reword a claim, so a mislabelled term
    can at worst rank two supported skills suboptimally.
    """
    if not llm:
        return qualifications

    rank = {"unclassified": 1, "preferred": 2, "required": 3}
    labels: Dict[str, str] = {}
    for classification in ("preferred", "required"):
        for phrase in llm.get(classification) or []:
            key = re.sub(r"\s+", " ", str(phrase).lower()).strip()
            if not key:
                continue
            if rank[classification] > rank.get(labels.get(key, "unclassified"), 1):
                labels[key] = classification
    if not labels:
        return qualifications

    updated = {
        "required": list(qualifications.get("required", [])),
        "preferred": list(qualifications.get("preferred", [])),
        "unclassified": list(qualifications.get("unclassified", [])),
        "items": [],
    }
    buckets = {name: set(_norm_kw(k) for k in updated[name]) for name in
               ("required", "preferred", "unclassified")}

    for item in qualifications.get("items", []):
        keyword = item.get("keyword", "")
        key = _norm_kw(keyword)
        current = item.get("classification", "unclassified")
        proposed = labels.get(key)
        if proposed and rank[proposed] > rank.get(current, 1):
            new_item = {**item, "classification": proposed, "classified_by": "llm_grounded"}
            buckets[current].discard(key)
            if keyword in updated[current]:
                updated[current].remove(keyword)
            updated[proposed].append(keyword)
            updated["items"].append(new_item)
        else:
            updated["items"].append(item)

    return updated


def _norm_kw(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").lower()).strip()


def _qualification_audit(
    qualifications: Dict[str, Any], audit: Dict[str, List[str]]
) -> Dict[str, Dict[str, List[str]]]:
    present = {
        re.sub(r"\s+", " ", str(keyword).lower()).strip()
        for keyword in audit.get("present", [])
    }
    result: Dict[str, Dict[str, List[str]]] = {}
    for classification in ("required", "preferred", "unclassified"):
        terms = list(qualifications.get(classification, []))
        result[classification] = {
            "present": [
                term for term in terms
                if re.sub(r"\s+", " ", str(term).lower()).strip() in present
            ],
            "missing": [
                term for term in terms
                if re.sub(r"\s+", " ", str(term).lower()).strip() not in present
            ],
        }
    return result


def _resume_evidence(
    resume_text: str,
    keyword: str,
    evidence_aliases: Dict[str, Sequence[str]] | None = None,
) -> List[Dict[str, str]]:
    """Return compact exact master-resume excerpts supporting a term."""
    aliases = {keyword: _evidence_terms(keyword, evidence_aliases)[1:]}
    return [
        {"keyword": keyword, **item}
        for item in evidence.find_evidence(keyword, resume_text.splitlines(), aliases=aliases, limit=3)
    ]


def _content_units(document) -> List[str]:
    """Atomic exact-text units used by the no-loss/no-copy invariant.

    A competency line is decomposed into its individual skills, the same way
    table cells already are, so REORDERING the list is order-independent while
    the skill multiset stays strictly enforced. Without this, legitimately
    reordering "Label: a, b, c" would trip the text-preservation invariant.
    """
    units = []
    for paragraph in document.paragraphs:
        if not (paragraph.text or "").strip():
            continue
        parsed = _parse_competency_line(paragraph.text) if _is_competency_paragraph(paragraph) else None
        if parsed:
            label, _sep, items = parsed
            units.extend(f"competency-item:{label}:{item}" for item in items)
        else:
            units.append(f"paragraph:{paragraph.text}")
    for table_index, table in enumerate(document.tables):
        for row_index, row in enumerate(table.rows):
            for cell_index, cell in enumerate(row.cells):
                items = _split_skill_list(cell.text)
                if len(items) > 1:
                    units.extend(
                        f"table-item:{table_index}:{row_index}:{cell_index}:{item}"
                        for item in items
                    )
                elif (cell.text or "").strip():
                    units.append(
                        f"table-cell:{table_index}:{row_index}:{cell_index}:{cell.text.strip()}"
                    )
    return units


def _normalized_unit(unit: str) -> str:
    return re.sub(r"\s+", " ", unit).strip().lower()


def _verify_truth_invariants(
    document,
    *,
    source_units: Sequence[str],
    source_nodes: Sequence[Any],
    source_styles: Dict[Any, str],
    movable_nodes: set,
) -> Dict[str, Any]:
    """Fail closed if tailoring changed claims, role scope, or formatting."""
    expected_units = Counter(source_units)
    actual_units = Counter(_content_units(document))
    text_units_preserved = actual_units == expected_units

    protected_nodes = [node for node in source_nodes if node not in movable_nodes]
    protected_set = set(protected_nodes)
    output_nodes = [paragraph._p for paragraph in document.paragraphs]
    output_protected = [node for node in output_nodes if node in protected_set]
    protected_order_preserved = (
        len(output_protected) == len(protected_nodes)
        and all(left is right for left, right in zip(output_protected, protected_nodes))
    )
    source_nodes_preserved_once = all(
        sum(node is candidate for candidate in output_nodes) == 1
        for node in source_nodes
    )
    # A source paragraph that is gone has no style (None), which fails here
    # cleanly instead of crashing inside the generator.
    output_styles = {paragraph._p: paragraph.style.name or "" for paragraph in document.paragraphs}
    paragraph_styles_preserved = all(
        source_styles[node] == output_styles.get(node)
        for node in source_nodes
    )

    before_normalized = Counter(_normalized_unit(unit) for unit in source_units)
    after_normalized = Counter(_normalized_unit(unit) for unit in _content_units(document))
    new_duplicates = sorted(
        unit for unit, count in after_normalized.items()
        if count > max(1, before_normalized.get(unit, 0))
    )

    invariants = {
        "text_units_preserved": text_units_preserved,
        "source_paragraphs_preserved_once": source_nodes_preserved_once,
        "protected_content_order_preserved": protected_order_preserved,
        "employment_facts_unchanged": text_units_preserved and protected_order_preserved,
        "employment_chronology_unchanged": protected_order_preserved,
        "paragraph_styles_preserved": paragraph_styles_preserved,
        "ats_safe_structure_preserved": paragraph_styles_preserved and protected_order_preserved,
        "new_duplicates": new_duplicates,
        "duplicate_protection_passed": not new_duplicates,
    }
    if not all((
        text_units_preserved,
        source_nodes_preserved_once,
        protected_order_preserved,
        paragraph_styles_preserved,
        not new_duplicates,
    )):
        failed = [key for key, value in invariants.items() if value is False]
        raise RuntimeError(
            "truth-preservation invariant failed before save: " + ", ".join(failed)
        )
    return invariants


def _verify_layout_invariants(
    document,
    *,
    units_before_fit: Sequence[str],
    omitted: Sequence[Dict[str, Any]],
    max_pages: int,
) -> Dict[str, Any]:
    """Fail closed if the layout phase changed anything but bullet DEPTH.

    The truth invariants earlier in the pipeline prove nothing was invented.
    These prove the page-fitting stage only ever OMITTED whole bullets that were
    already there — no wording edited, no role or heading dropped, no content
    invented, and no employment gap opened up.
    """
    remaining = Counter(_content_units(document))
    expected = Counter(units_before_fit)
    for entry in omitted:
        key = entry.get("unit") or f"paragraph:{entry['text']}"
        if expected.get(key):
            expected[key] -= 1
            if not expected[key]:
                del expected[key]
    nothing_added = all(remaining[unit] <= count for unit, count in expected.items()) \
        and set(remaining) <= set(expected)
    only_declared_removals = remaining == expected

    role_headings = [p for p in document.paragraphs if _is_role_heading(p)]
    headings = [
        p for p in document.paragraphs
        if _is_section_heading(p.text)
    ]
    orphan_roles = []
    for index, paragraph in enumerate(document.paragraphs):
        if not _is_role_heading(paragraph):
            continue
        follower = next(
            (p for p in document.paragraphs[index + 1:] if (p.text or "").strip()),
            None,
        )
        if follower is None or _is_role_heading(follower) \
                or _is_section_heading(follower.text):
            orphan_roles.append((paragraph.text or "").strip()[:80])

    manual_breaks = 'w:type="page"' in document._element.xml
    estimated = estimate_page_count(document)
    invariants = {
        "layout_omitted_only_declared_bullets": only_declared_removals,
        "layout_added_no_content": nothing_added,
        "employment_history_complete": bool(role_headings) or not omitted,
        "section_headings_intact": bool(headings) or not omitted,
        "no_manual_page_breaks": not manual_breaks,
        "estimated_pages": round(estimated, 2),
        "within_page_budget": max_pages <= 0 or estimated <= max_pages,
        "roles_without_detail": orphan_roles,
    }
    if not (only_declared_removals and nothing_added and not manual_breaks):
        failed = [key for key, value in invariants.items() if value is False]
        raise RuntimeError("layout invariant failed before save: " + ", ".join(failed))
    return invariants


def _text_box_paragraphs(paragraph) -> List[Any]:
    """Paragraphs inside the text boxes anchored in ``paragraph``, each once.

    Word stores a text box twice, as a drawing and as a VML fallback inside
    mc:Fallback; the fallback copy is skipped.
    """
    from docx.text.paragraph import Paragraph

    found = []
    for node in paragraph._p.iter():
        if not str(node.tag).endswith("}txbxContent"):
            continue
        if any(str(a.tag).endswith("}Fallback") for a in node.iterancestors()):
            continue
        for child in node:
            if str(child.tag).endswith("}p"):
                found.append(Paragraph(child, paragraph._parent))
    return found


_ALIGN_CSS = {1: "center", 2: "right", 3: "justify"}


def _alignment(paragraph):
    """The paragraph's alignment, from itself or its style chain (python-docx enum value)."""
    if paragraph.alignment is not None:
        return int(paragraph.alignment)
    style = paragraph.style
    while style is not None:
        if style.paragraph_format.alignment is not None:
            return int(style.paragraph_format.alignment)
        style = style.base_style
    return None


def _right_tab(paragraph, body: str) -> str:
    """"Title | Employer<tab>Dates" with a right tab stop: the dates go to the right edge."""
    if "\t" not in body:
        return body
    stops = list(paragraph.paragraph_format.tab_stops)
    style = paragraph.style
    while not stops and style is not None:
        stops = list(style.paragraph_format.tab_stops)
        style = style.base_style
    head, _, tail = body.rpartition("\t")
    if not any(stop.alignment == WD_TAB_ALIGNMENT.RIGHT for stop in stops) or "</" in tail:
        return body.replace("\t", " ")
    # A real space first, so text extraction reads "Corp Jan 2019", not "CorpJan".
    return f'{head.replace(chr(9), " ")} <span class="tab-right">{tail}</span>'


def _body_font(document) -> tuple[str, float]:
    """Normal's font family and size, as the document resolves them."""
    styles = pagefit._Styles(document)
    probe = document.add_paragraph()
    try:
        resolved = pagefit._Para(probe, styles)
    finally:
        probe._p.getparent().remove(probe._p)
    family = next((name for name in (resolved.font,) if name), "calibri")
    return " ".join(part.capitalize() for part in family.split()), resolved.size_pt


def docx_to_html(docx_path: str | Path) -> Dict[str, Any]:
    """An ATS-safe HTML rendering of a resume, for printing to PDF (P2-3).

    One column of real text, in document order: page-header text first,
    section headings as <h2>, role lines <h3>, bullets <li>, table rows as one
    line of cells, everything else <p>, page-footer text last. Bold stays bold
    and web or mail links stay links.

    Returns the HTML and every text it prints (``texts``), which the caller
    checks against the rendered page before writing the PDF. Both come from the
    same walk, so a part of the document the walk misses is missing from the
    check too only if it is missing from the page, never one without the other.
    It used to read body paragraphs through ``paragraph.runs``: linked text,
    tables and page headers were left off the page, and the PDF was refused
    (R1) or, for tables and headers, written without them and reported ok
    (N8, N4). Text boxes are still not read (R15).
    """
    import html as html_lib
    from docx import Document
    from docx.table import Table
    from docx.text.hyperlink import Hyperlink

    document = Document(str(docx_path))
    parts: List[str] = []
    texts: List[str] = []
    in_list = False

    def run_html(run) -> str:
        text = html_lib.escape(run.text or "")
        if not text:
            return text
        # Emphasis as the document has it (R7): it was bold only.
        if run.underline:
            text = f"<u>{text}</u>"
        if run.italic:
            text = f"<em>{text}</em>"
        return f"<strong>{text}</strong>" if run.bold else text

    def inline_html(paragraph) -> str:
        out = []
        for item in paragraph.iter_inner_content():
            if isinstance(item, Hyperlink):
                inner = "".join(run_html(run) for run in item.runs)
                url = item.url or ""
                if inner and _SAFE_LINK_RE.match(url):
                    out.append(f'<a href="{html_lib.escape(url, quote=True)}">{inner}</a>')
                else:
                    out.append(inner)
            else:
                out.append(run_html(item))
        return "".join(out) or html_lib.escape(paragraph.text or "")

    def close_list() -> None:
        nonlocal in_list
        if in_list:
            parts.append("</ul>")
            in_list = False

    def add_paragraph(paragraph, css: str | None = None) -> None:
        nonlocal in_list
        text = (paragraph.text or "").strip()
        if not text:
            return
        bullet = css is None and _is_bullet(paragraph)
        if bullet and not in_list:
            parts.append("<ul>")
            in_list = True
        if not bullet:
            close_list()
        body = _right_tab(paragraph, inline_html(paragraph))
        if bullet:
            # A typed glyph becomes the list marker, so it is not page text,
            # and the completeness check must not look for it either (N9).
            body = _LEADING_GLYPH_HTML_RE.sub(r"\1", body, count=1)
            texts.append(_TYPED_BULLET_RE.sub("", text, count=1))
            parts.append(f"<li>{body}</li>")
            return
        texts.append(text)
        align = _ALIGN_CSS.get(_alignment(paragraph))
        attrs = (f' class="{css}"' if css else "") + (f' style="text-align:{align}"' if align else "")
        if css:
            parts.append(f'<p{attrs}>{body}</p>')
        elif _is_section_heading(text):
            parts.append(f"<h2{attrs}>{body}</h2>")
        elif _is_role_heading(paragraph):
            parts.append(f"<h3{attrs}>{body}</h3>")
        else:
            parts.append(f"<p{attrs}>{body}</p>")

    def add_table(table) -> None:
        close_list()
        for row in table.rows:
            cells = []
            seen = set()
            for cell in row.cells:
                if id(cell._tc) in seen:
                    continue
                seen.add(id(cell._tc))
                lines = [p for p in cell.paragraphs if (p.text or "").strip()]
                if not lines:
                    continue
                texts.extend(p.text.strip() for p in lines)
                cells.append('<span class="cell">' + "<br>".join(inline_html(p) for p in lines) + "</span>")
            if cells:
                # Real whitespace between cells: text extraction must read
                # "Platforms SQL Server", not "PlatformsSQL Server".
                parts.append('<p class="row">' + " ".join(cells) + "</p>")

    def page_part_paragraphs(kind: str) -> List[Any]:
        found, seen = [], set()
        for section in document.sections:
            candidates = [getattr(section, kind)]
            if section.different_first_page_header_footer:
                candidates.insert(0, getattr(section, f"first_page_{kind}"))
            for part in candidates:
                if part.is_linked_to_previous:
                    continue
                for paragraph in part.paragraphs:
                    key = (paragraph.text or "").strip()
                    if key and key not in seen:
                        seen.add(key)
                        found.append(paragraph)
        return found

    for paragraph in page_part_paragraphs("header"):
        add_paragraph(paragraph, css="page-header")
    for block in document.iter_inner_content():
        if isinstance(block, Table):
            add_table(block)
        else:
            add_paragraph(block)
            # A text box's text, right after the paragraph it is anchored in
            # (R15): it was left off the page, and out of the check.
            for box_paragraph in _text_box_paragraphs(block):
                add_paragraph(box_paragraph, css="text-box")
    close_list()
    for paragraph in page_part_paragraphs("footer"):
        add_paragraph(paragraph, css="page-footer")

    # The document's own page, margins, font and size (R7). A fixed 10.5 pt
    # Calibri on 0.55 in margins made this a different document from the DOCX,
    # with its own page count.
    page = pagefit.page_metrics(document)
    inch = lambda twips: f"{twips / 1440:.2f}".rstrip("0").rstrip(".") + "in"  # noqa: E731
    font, size = _body_font(document)
    style = (
        f"@page{{size:{inch(page['width'])} {inch(page['height'])};"
        f"margin:{inch(page['top'])} {inch(page['right'])} {inch(page['bottom'])} {inch(page['left'])}}}"
        f"body{{font-family:'{font}',Carlito,Caladea,Arial,Helvetica,sans-serif;font-size:{size:g}pt;"
        "line-height:1.22;color:#000}"
        "h2{font-size:1.1em;margin:10pt 0 3pt;border-bottom:1px solid #000;text-transform:uppercase;break-after:avoid}"
        "h3{font-size:1em;margin:6pt 0 2pt;break-after:avoid}"
        "p{margin:0 0 3pt}ul{margin:0 0 4pt;padding-left:16pt}li{margin:0 0 2pt}"
        "a{color:inherit;text-decoration:none}.cell{margin-right:18pt}.tab-right{float:right}"
    )
    title = html_lib.escape(texts[0] if texts else "Resume")
    html = (
        f"<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>{title}</title>"
        f"<style>{style}</style></head><body>{''.join(parts)}</body></html>"
    )
    return {"html": html, "texts": texts}


def master_units(master_path: str | Path) -> List[Dict[str, Any]]:
    """The master resume's paragraphs as stable, citable evidence units.

    Each non-empty paragraph gets an id ``u<n>`` (its position among non-empty
    paragraphs), its exact text, its kind (``bullet``, ``role``, ``section`` or
    ``paragraph``) and the role heading it sits under. The grounded-rewrite
    layer (src/resume/rewrites.js) cites these ids as evidence; ids stay the
    same for as long as the master resume does.
    """
    from docx import Document

    document = Document(str(master_path))
    units: List[Dict[str, Any]] = []
    role = None
    for paragraph in document.paragraphs:
        text = (paragraph.text or "").strip()
        if not text:
            continue
        if _is_section_heading(text):
            kind = "section"
            role = None
        elif _is_role_heading(paragraph):
            kind = "role"
            role = text
        elif _is_bullet(paragraph):
            kind = "bullet"
        else:
            kind = "paragraph"
        units.append({"id": f"u{len(units)}", "text": paragraph.text, "kind": kind, "role": role})
    return units


def _apply_accepted_rewrites(
    document, rewrites: Sequence[Dict[str, Any]] | None
) -> tuple[List[Dict[str, Any]], Dict[str, str]]:
    """Replace the text of exactly the bullets a person accepted.

    Each rewrite names the master's ``original`` text, the ``rewrite`` that was
    verified against cited master-resume evidence and then accepted by a
    person, and that evidence. A rewrite is applied only when ``original``
    matches exactly one bullet paragraph; anything else is skipped and
    reported. The first run keeps its formatting and takes the new text.
    Returns the change records and {original_unit: rewritten_unit} so the
    truth invariant can expect these units, and only these, to differ.
    """
    changes: List[Dict[str, Any]] = []
    replaced: Dict[str, str] = {}
    for item in rewrites or []:
        original = str(item.get("original") or "")
        rewrite = str(item.get("rewrite") or "").strip()
        if not original or not rewrite or rewrite == original:
            continue
        matches = [p for p in document.paragraphs if p.text == original and _is_bullet(p)]
        if len(matches) != 1:
            changes.append({
                "type": "rewrite_skipped", "where": "experience", "before": original, "after": None,
                "reason": "the original bullet is no longer in the master resume exactly once",
                "evidence": item.get("evidence") or [], "source": "accepted_rewrite",
            })
            continue
        paragraph = matches[0]
        note = _rewrite_formatting_note(paragraph, rewrite)
        _replace_paragraph_text(paragraph, rewrite)
        if paragraph.text != rewrite:
            # Cannot happen after _replace_paragraph_text; refuse rather than
            # write a line nobody accepted.
            raise RuntimeError("an accepted rewrite did not produce exactly the accepted text")
        replaced[f"paragraph:{original}"] = f"paragraph:{paragraph.text}"
        change = {
            "type": "rewrite", "where": "experience", "before": original, "after": paragraph.text,
            "reason": "verified against the cited master-resume evidence and accepted by you",
            "evidence": item.get("evidence") or [], "source": "accepted_rewrite",
            "task": item.get("task"),
        }
        if note:
            change["formatting_note"] = note
        changes.append(change)
    return changes, replaced


def _rewrite_formatting_note(paragraph, rewrite: str) -> str | None:
    """What the original line carried that the rewritten line will not (R16).

    The rewrite takes the first run's formatting. A link in the line goes
    (its words are not the accepted words), and bold or italic on part of the
    line cannot be placed on new wording. Said in the review, not silently lost.
    """
    notes = []
    links = [link.text for link in paragraph.hyperlinks if (link.text or "").strip()]
    if links:
        names = ", ".join(links)
        notes.append(f"The original line's link ({names}) is not in the rewording.")
    looks = {(bool(run.bold), bool(run.italic), bool(run.underline))
             for run, _link in _inline_items(paragraph) if (run.text or "").strip()}
    if len(looks) > 1:
        notes.append("Bold or italic on part of the original line is not kept; the rewording uses the line's first style.")
    return " ".join(notes) or None


def _replace_paragraph_text(paragraph, text: str) -> None:
    """Make ``paragraph.text`` exactly ``text``: first run's formatting, links removed.

    Writing into run 0 and blanking ``paragraph.runs`` left hyperlink runs
    alone, so "…on the team blog" + "example.com/post" survived after the
    accepted wording (N3). Every inline run is accounted for here.
    """
    from docx.oxml.ns import qn

    items = list(_inline_items(paragraph))
    model = next((run for run, _link in items if (run.text or "").strip()), None)
    for link in list(paragraph._p.findall(qn("w:hyperlink"))):
        paragraph._p.remove(link)
    direct = paragraph.runs
    if direct:
        direct[0].text = text
        for run in direct[1:]:
            run.text = ""
        return
    new_run = paragraph.add_run(text)
    # The line was all link: keep its character formatting, not the link style.
    if model is not None and model._r.rPr is not None:
        properties = deepcopy(model._r.rPr)
        style = properties.find(qn("w:rStyle"))
        if style is not None:
            properties.remove(style)
        new_run._r.insert(0, properties)


#: Steps tailoring can do without, in the order they run, with how the review names them.
#: Table flattening is not here: a failure there still falls back to the master.
_OPTIONAL_STEPS: Dict[str, str] = {
    "rewrites": "your accepted rewordings",
    "prioritize": "reordering the summary and bullets",
    "competency_tables": "reordering skills tables",
    "competency_lines": "reordering skills lines",
    "emphasize": "bolding the posting's terms",
    "normalize_layout": "layout cleanup",
    "fit": "fitting to the page limit",
    "protect_headings": "keeping headings with their text",
}


class _StepFailed(RuntimeError):
    """An optional tailoring step whose result failed a check."""

    def __init__(self, step: str, error: Exception):
        super().__init__(f"{step}: {error}")
        self.step = step
        self.error = error


def _build_tailored(
    master_path: Path,
    *,
    skip: set,
    present: Sequence[str],
    qualification_details: Dict[str, Dict[str, Any]],
    accepted_rewrites: Sequence[Dict[str, Any]] | None,
    max_pages: int,
    keep_bullets: Sequence[str] | None,
    check_each_step: bool = False,
    measure_pages: Any = None,
) -> Dict[str, Any]:
    """One tailoring pass over a fresh copy of the master, without the ``skip`` steps.

    A step that raises is reported as ``_StepFailed``. With ``check_each_step``,
    each content step is also followed by the full truth invariants, and the
    page fit by the layout invariants, so a step that silently broke one is
    pinned too. The final checks are not attributed: they raise a plain
    RuntimeError, as before.
    """
    from docx import Document

    # Open the master read-only: we load it, mutate the in-memory copy, and save
    # to a NEW path. The master file on disk is never written.
    document = Document(str(master_path))
    state: Dict[str, Any] = {"movable_nodes": set()}

    def run(name, fn, *args, check=None, **kwargs):
        if name in skip:
            return None
        try:
            out = fn(*args, **kwargs)
            if check is not None:
                check()
            return out
        except RuntimeError as err:
            raise _StepFailed(name, err) from err

    # Accepted, evidence-verified rewrites (P1-2) are applied first, and the
    # invariant baseline is updated for exactly those units: every other unit
    # must still survive byte-for-byte, and these must be the accepted text.
    rewrite_changes, rewritten_units = run("rewrites", _apply_accepted_rewrites, document, accepted_rewrites) or ([], {})
    source_units = _content_units(document)
    source_nodes = [paragraph._p for paragraph in document.paragraphs]
    source_styles = {
        paragraph._p: paragraph.style.name or "" for paragraph in document.paragraphs
    }

    def truth():
        return _verify_truth_invariants(
            document, source_units=source_units, source_nodes=source_nodes,
            source_styles=source_styles, movable_nodes=state["movable_nodes"],
        )

    changes: List[Dict[str, Any]] = list(rewrite_changes)
    selected_content: Dict[str, Any] = {"summary": [], "experience": []}
    prioritized = run("prioritize", _prioritize_existing_content, document, present, qualification_details)
    if prioritized:
        content_changes, selected_content, state["movable_nodes"] = prioritized
        changes.extend(content_changes)
        if check_each_step:
            try:
                truth()
            except RuntimeError as err:
                raise _StepFailed("prioritize", err) from err

    check = truth if check_each_step else None
    changes.extend(run("competency_tables", _reorder_competencies, document, present, qualification_details,
                       check=check) or [])
    # Paragraph-based CORE COMPETENCIES ("Data Platforms:  Azure Databricks, …").
    # Table-only handling above missed this extremely common layout entirely.
    changes.extend(run("competency_lines", _reorder_competency_paragraphs, document, present, qualification_details,
                       check=check) or [])

    emphasized, emphasis_evidence, emphasis_mutations = run(
        "emphasize", _emphasize, document, present, qualification_details, check=check,
    ) or (0, [], [])
    if emphasized:
        changes.append({
            "type": "emphasize",
            "where": "throughout",
            "before": [
                {"text": item["text"], "bold": item["before_bold"]}
                for item in emphasis_mutations
            ],
            "after": [
                {"text": item["text"], "bold": item["after_bold"]}
                for item in emphasis_mutations
            ],
            "evidence": emphasis_evidence,
            "reason": (
                f"bolded {emphasized} existing mention(s) of supported JD terms; "
                "no text changed"
            ),
            "source": "master_resume",
        })


    invariants = truth()

    table_change = _flatten_tables_for_ats(document)
    if table_change:
        changes.append(table_change)

    # ── layout phase ─────────────────────────────────────────────────────────
    # Runs AFTER the truth invariants above, because these steps are allowed to
    # change the document's SHAPE (page breaks, blank filler, how many bullets a
    # 2017 role shows) while the checks above pin its CLAIMS. Everything the
    # layout phase may do is re-verified by `_verify_layout_invariants`.
    layout_change = run("normalize_layout", _normalize_layout, document)
    if layout_change:
        changes.append(layout_change)

    units_before_fit = _content_units(document)

    def omitted_by(fit_change):
        return (fit_change or {}).get("evidence", [{}])[0].get("omitted", [])

    def layout(fit_change):
        return _verify_layout_invariants(
            document, units_before_fit=units_before_fit, omitted=omitted_by(fit_change), max_pages=max_pages,
        )

    fitted = run("fit", _fit_to_pages, document, max_pages=max_pages, keywords=present,
                 qualification_details=qualification_details, keep_bullets=keep_bullets, measure=measure_pages)
    fit_change, fit_limitations = fitted or (None, [])
    if fitted is not None and check_each_step:
        try:
            layout(fit_change)
        except RuntimeError as err:
            raise _StepFailed("fit", err) from err
    if fit_change:
        changes.append(fit_change)

    pagination_change = run("protect_headings", _protect_headings, document)
    if pagination_change:
        changes.append(pagination_change)

    invariants.update(layout(fit_change))
    # A measured length outranks the estimate (R6).
    measured = ((fit_change or {}).get("evidence") or [{}])[0].get("measured_by")
    if measured:
        invariants["measured_pages"] = fit_change["evidence"][0]["pages"]
        invariants["within_page_budget"] = max_pages <= 0 or invariants["measured_pages"] <= max_pages
    invariants["table_text_preserved"] = True
    invariants["tables_removed_for_ats"] = len(document.tables) == 0
    invariants["page_breaks_stabilized"] = True
    invariants["role_context_text_preserved"] = True
    invariants["ats_safe_structure_preserved"] = (
        invariants["paragraph_styles_preserved"]
        and invariants["protected_content_order_preserved"]
        and invariants["tables_removed_for_ats"]
    )
    if not invariants["ats_safe_structure_preserved"]:
        raise RuntimeError("ATS-safe structure invariant failed before save")
    return {
        "document": document, "changes": changes, "rewrite_changes": rewrite_changes,
        "rewritten_units": rewritten_units, "selected_content": selected_content,
        "emphasized": emphasized, "invariants": invariants, "fit_limitations": fit_limitations,
    }


def tailor_resume(
    master_path: str | Path,
    output_dir: str | Path,
    job: Dict[str, Any],
    keywords: Iterable[str],
    patterns: Dict[str, Any] | None = None,
    *,
    max_pages: int = 2,
    required_markers: Iterable[str] | None = None,
    preferred_markers: Iterable[str] | None = None,
    evidence_aliases: Dict[str, Sequence[str]] | None = None,
    enable_rewrites: bool = False,
    now: datetime | None = None,
    output_name: str | None = None,
    llm_qualifications: Dict[str, Sequence[str]] | None = None,
    accepted_rewrites: Sequence[Dict[str, Any]] | None = None,
    keep_bullets: Sequence[str] | None = None,
    evidence_lines: Sequence[str] | None = None,
    evidence_vocabulary: Sequence[str] | None = None,
    gap_terms: Sequence[str] | None = None,
    measure_pages: Any = None,
    section_headings: Dict[str, Sequence[str]] | None = None,
) -> Dict[str, Any]:
    """Create a tailored resume for ``job`` and return a result dict.

    ``section_headings`` adds section names by kind (summary, experience,
    skills, education, other) for this call (R14).
    """
    with _section_heading_overrides(section_headings):
        return _tailor_resume(
            master_path, output_dir, job, keywords, patterns, max_pages=max_pages,
            required_markers=required_markers, preferred_markers=preferred_markers,
            evidence_aliases=evidence_aliases, enable_rewrites=enable_rewrites, now=now,
            output_name=output_name, llm_qualifications=llm_qualifications,
            accepted_rewrites=accepted_rewrites, keep_bullets=keep_bullets,
            evidence_lines=evidence_lines, evidence_vocabulary=evidence_vocabulary,
            gap_terms=gap_terms, measure_pages=measure_pages,
        )


def _tailor_resume(
    master_path: str | Path,
    output_dir: str | Path,
    job: Dict[str, Any],
    keywords: Iterable[str],
    patterns: Dict[str, Any] | None = None,
    *,
    max_pages: int = 2,
    required_markers: Iterable[str] | None = None,
    preferred_markers: Iterable[str] | None = None,
    evidence_aliases: Dict[str, Sequence[str]] | None = None,
    enable_rewrites: bool = False,
    now: datetime | None = None,
    output_name: str | None = None,
    llm_qualifications: Dict[str, Sequence[str]] | None = None,
    accepted_rewrites: Sequence[Dict[str, Any]] | None = None,
    keep_bullets: Sequence[str] | None = None,
    evidence_lines: Sequence[str] | None = None,
    evidence_vocabulary: Sequence[str] | None = None,
    gap_terms: Sequence[str] | None = None,
    measure_pages: Any = None,
) -> Dict[str, Any]:
    """The body of tailor_resume, with the heading tables already set.

    ``measure_pages`` (document -> pages, or None when it cannot say) makes the
    page fit check the rendered length instead of trusting the estimate (R6);
    tailor_cli passes LibreOffice's when it is installed.

    The three ``evidence_``/``gap_`` options make the packet's gaps the score's
    gaps (audit R13): the runner sends the master resume's lines exactly as the
    scorer read them, the scorer's vocabulary (context for everyday terms) and
    the terms that can be a gap at all (skills, never a job title). Without
    them the tailor reads the master itself, as before.

    The function may reorder exact existing content and change emphasis. It
    never rewrites claims on its own: the only reworded text it writes is
    ``accepted_rewrites`` (evidence-verified and accepted by a person).
    ``enable_rewrites`` is accepted only so callers get an explicit policy
    response; it does not enable free-form rewriting.

    Returns the output path plus qualification audit, selected content,
    provenance records, gaps, rewrite policy, and verified invariants.
    Raises FileNotFoundError if the master is missing.
    """
    master_path = Path(master_path)
    if not master_path.exists():
        raise FileNotFoundError(f"Master resume not found: {master_path}")

    keywords = list(keywords)
    resume_text = "\n".join(str(line) for line in evidence_lines) if evidence_lines else read_docx_text(master_path)
    audit = _audit_supported_keywords(resume_text, keywords, evidence_aliases, evidence_vocabulary)
    qualifications = classify_qualification_keywords(
        job.get("jd_text", ""),
        keywords,
        required_markers=list(required_markers or _DEFAULT_REQUIRED_MARKERS),
        preferred_markers=list(preferred_markers or _DEFAULT_PREFERRED_MARKERS),
        vocabulary=evidence_vocabulary,
    )
    # Grounded requirement classification from the optional LLM layer.
    # Marker-based classification depends on a posting having explicit
    # "Required/Preferred qualifications" headings. Many real postings are a
    # single blob whose only cue is an inline "(Databricks preferred)", leaving
    # every term unclassified and the ranking with no requirement signal at all.
    # The LLM read the same posting and labelled them; applying that here only
    # changes ORDERING PRIORITY, never content, so a wrong label can at worst
    # order two supported skills suboptimally.
    qualifications = _apply_llm_qualifications(qualifications, llm_qualifications)
    qualifications["audit"] = _qualification_audit(qualifications, audit)
    qualification_details = _keyword_details(qualifications)

    # Each optional step runs in _build_tailored. A step whose result fails a
    # check is skipped and the copy is rebuilt from the master without it (R11):
    # one bad step used to discard the whole tailoring. The truth and layout
    # invariants are unchanged and still run on the final document; anything
    # they reject that no single optional step explains still fails closed.
    # The first pass checks once at the end, as before. Only when that fails is
    # the pass repeated with a check after every step, to find which one to
    # leave out, so a resume that tailors cleanly pays nothing extra.
    skipped: Dict[str, str] = {}
    diagnose = False
    for _attempt in range(len(_OPTIONAL_STEPS) + 2):
        try:
            built = _build_tailored(
                master_path, skip=set(skipped), present=audit["present"],
                qualification_details=qualification_details, accepted_rewrites=accepted_rewrites,
                max_pages=max_pages, keep_bullets=keep_bullets, check_each_step=diagnose,
                measure_pages=measure_pages,
            )
            break
        except _StepFailed as failed:
            if failed.step in skipped:
                raise failed.error from failed
            skipped[failed.step] = str(failed.error)
        except RuntimeError:
            if diagnose:
                raise
            diagnose = True
    else:  # pragma: no cover - every optional step skipped and still failing
        raise RuntimeError("tailoring could not finish with any combination of steps")

    document = built["document"]
    changes = built["changes"]
    rewrite_changes = built["rewrite_changes"]
    rewritten_units = built["rewritten_units"]
    selected_content = built["selected_content"]
    emphasized = built["emphasized"]
    invariants = built["invariants"]

    limitations = [
        (
            f"{len([c for c in rewrite_changes if c['type'] == 'rewrite'])} bullet(s) use a rewording you "
            "accepted, each verified against cited lines of your master resume; nothing else was reworded."
            if any(c["type"] == "rewrite" for c in rewrite_changes) else
            "Free-form bullet and summary rewriting is disabled: no approved claim-level "
            "evidence map is available. Tailoring is limited to exact-text reordering and "
            "format emphasis."
        ),
        (
            "Required/preferred classification is deterministic and limited to the "
            "caller-supplied keyword set; it does not infer unconfigured qualifications "
            "from arbitrary prose."
        ),
        (
            "Configured evidence aliases may support a JD term when the master resume "
            "contains a truthful equivalent (for example, PySpark supports Spark). "
            "The audit records the exact alias and source excerpt."
        ),
        (
            "Content prioritization moves only intact summary paragraphs and contiguous "
            "Word list bullets within their original role; it does not split sentences or "
            "restructure text boxes. Generated copies flatten tables to an ordered, "
            "single-column ATS-safe layout without changing their words."
        ),
    ]
    # Requirements the resume does NOT evidence. Reported, never inserted.
    gaps = []
    has_jd_text = bool((job.get("jd_text") or "").strip())
    gap_keys = None if gap_terms is None else {_norm_kw(term) for term in gap_terms}
    title = str(job.get("title") or "")
    title_vocabulary = keywords if evidence_vocabulary is None else evidence_vocabulary
    for keyword in audit.get("missing", []):
        key = re.sub(r"\s+", " ", str(keyword).lower()).strip()
        detail = qualification_details.get(key, {})
        if gap_keys is not None:
            # The scorer's rules (R13): a job title or an industry is not a
            # skill you can be missing, and a gap is something the posting's
            # body or its title asks for.
            if key not in gap_keys:
                continue
            if not detail.get("jd_evidence") and not evidence.shows(str(keyword), title, vocabulary=title_vocabulary):
                continue
        # Stored score keywords can outlive a later JD refresh. Never display a
        # purported gap when the current non-empty JD has no occurrence/evidence.
        elif has_jd_text and not detail.get("jd_evidence"):
            continue
        gaps.append({
            "keyword": keyword,
            "qualification": detail.get("classification", "unclassified"),
            "action": "not added — no supporting experience in the master resume",
            "reason": "boundary-aware search found no evidence for this requirement",
            "evidence": {
                "jd": detail.get("jd_evidence", []),
                "master_resume": [],
            },
        })
    gaps.sort(
        key=lambda gap: -_QUALIFICATION_WEIGHT.get(gap["qualification"], 1)
    )

    applied_rewrites = [c for c in rewrite_changes if c["type"] == "rewrite"]
    rewrite_policy = {
        "mode": "evidence_accepted" if applied_rewrites else "disabled",
        "requested": bool(enable_rewrites),
        "applied": len(applied_rewrites),
        "reason": (
            "Only bullets whose rewrite was verified against cited master-resume evidence and "
            "accepted by a person were changed; every other unit is preserved exactly."
            if applied_rewrites else
            "Claim rewriting requires an approved claim-level evidence map; none is accepted "
            "by this deterministic tailor."
        ),
    }
    if applied_rewrites:
        rewrite_policy["rewritten_units"] = len(rewritten_units)
    if enable_rewrites and not applied_rewrites:
        limitations.append(
            "A rewrite was requested but deliberately not performed because supported rewriting is unavailable."
        )

    limitations.extend(built["fit_limitations"])
    skipped_steps = [
        {"step": name, "label": _OPTIONAL_STEPS[name], "reason": reason} for name, reason in skipped.items()
    ]
    for item in skipped_steps:
        changes.append({
            "type": "step_skipped",
            "where": item["label"],
            "before": f"{item['label']} was attempted",
            "after": "left out; the rest of the tailoring was kept",
            "evidence": [{"step": item["step"], "check_failed": item["reason"]}],
            "reason": "its result failed a check, so the resume was rebuilt without that step",
            "source": "master_resume",
        })
    if skipped_steps:
        limitations.append(
            f"Skipped {len(skipped_steps)} tailoring step(s) whose result failed a check: "
            + ", ".join(item["label"] for item in skipped_steps)
            + ". Everything else was tailored as usual."
        )

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    filename = output_name or output_filename(
        job.get("company", "company"), job.get("title", "role"), now
    )
    if Path(filename).name != filename:
        raise ValueError("output_name must be a filename, not a path")
    output_path = output_dir / filename
    if output_path.resolve() == master_path.resolve():
        raise ValueError("refusing to overwrite the master resume")
    document.save(str(output_path))

    return {
        "output_path": str(output_path),
        "audit": audit,
        "qualifications": qualifications,
        "emphasized": emphasized,
        "changes": changes,
        "gaps": gaps,
        "selected_content": selected_content,
        "rewrite_policy": rewrite_policy,
        "invariants": invariants,
        "limitations": limitations,
        "skipped_steps": skipped_steps,
    }

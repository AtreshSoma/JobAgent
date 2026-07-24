"""Deterministic resume tailoring.

Produces a per-job tailored copy of the master resume WITHOUT inventing any
content. The master file is opened read-only (we never call ``save`` on it).

Tailoring actions (all honest, content-preserving):
  1. Classify requested terms as required, preferred, or unclassified from the
     job description's explicit qualification headings.
  2. Reorder existing summary paragraphs and bullet runs, within their original
     sections/roles, so supported required content appears before preferred
     content. Paragraphs are moved intact; none are copied, deleted, or edited.
  3. Emphasize (bold) existing runs that mention a matched job keyword.
  4. Reorder the comma-separated skill lists in the CORE COMPETENCIES table so
     the skills this JD asks for come FIRST in each category. Pure permutation
     of existing items — nothing is added, removed, or reworded.
  5. Optionally insert a "most relevant to this role" line built ONLY from
     keywords that are both requested by the job AND already present in the
     resume. It is anchored just above the CORE COMPETENCIES / PROFESSIONAL
     SUMMARY heading so ATS parsers see the job's own terminology up top.
  6. Flatten layout tables into single-column paragraphs in the generated copy,
     preserving their exact text/runs so ATS parsers read content in order.
  7. Save the result to a per-job .docx in the job's output folder.

Free-form rewriting is intentionally disabled. Without a separately approved,
claim-level evidence map, even plausible wording changes can silently invent
scope, ownership, technologies, or metrics. This module therefore performs only
exact-text movement and formatting changes whose provenance is auditable.

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

from humanizer import humanize
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
_EMPLOYMENT_DATE_RE = re.compile(
    r"\b(?:january|february|march|april|may|june|july|august|september|"
    r"october|november|december)\s+\d{4}\b|\bpresent\b",
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


def _phrase_pattern(phrase: str) -> re.Pattern:
    """Boundary-aware matcher that remains tolerant of tech punctuation."""
    return re.compile(
        rf"(?<![a-z0-9]){re.escape((phrase or '').strip())}(?![a-z0-9])",
        re.IGNORECASE,
    )


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
) -> List[Dict[str, Any]]:
    """Return grounded keyword evidence for one existing resume fragment."""
    matched: List[Dict[str, Any]] = []
    for keyword in keywords:
        if not keyword or not _phrase_pattern(str(keyword)).search(text or ""):
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


def _emphasize(
    document,
    keywords: List[str],
    qualification_details: Dict[str, Dict[str, Any]],
) -> tuple[int, List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Bold runs that contain a matched keyword.

    Returns ``(count, evidence)`` where evidence lists, per keyword, the
    existing resume text that mentions it — proof the emphasis is grounded in
    real content, not injected.
    """
    count = 0
    evidence_by_keyword: Dict[str, Dict[str, Any]] = {}
    mutations: List[Dict[str, Any]] = []
    for para in _iter_all_paragraphs(document):
        if _norm_heading(para.text).startswith("most relevant to this role:"):
            continue
        for run in para.runs:
            text = run.text or ""
            if not text:
                continue
            hits = [
                keyword for keyword in keywords
                if keyword and _phrase_pattern(str(keyword)).search(text)
            ]
            if hits:
                before_bold = run.bold
                if before_bold is True:
                    continue
                run.bold = True
                count += 1
                mutations.append({
                    "text": text,
                    "paragraph": (para.text or "").strip(),
                    "before_bold": before_bold,
                    "after_bold": True,
                })
                for keyword in hits:
                    key = re.sub(r"\s+", " ", str(keyword).lower()).strip()
                    detail = qualification_details.get(key, {})
                    evidence_by_keyword.setdefault(key, {
                        "keyword": keyword,
                        "qualification": detail.get("classification", "unclassified"),
                        "resume_text": (para.text or "").strip()[:240],
                        "jd_evidence": detail.get("jd_evidence", []),
                    })
    return count, list(evidence_by_keyword.values()), mutations


def _split_skill_list(text: str) -> List[str]:
    """Split a comma-separated competency cell into items (trimmed, non-empty)."""
    return [item.strip() for item in (text or "").split(",") if item.strip()]


def _set_cell_text_preserving(cell, text: str) -> None:
    """Replace a table cell's text while keeping the first run's formatting."""
    para = cell.paragraphs[0]
    if para.runs:
        para.runs[0].text = text
        for run in para.runs[1:]:
            run.text = ""
    else:
        para.add_run(text)


_COMPETENCY_HEADINGS = {
    "core competencies", "technical skills", "skills", "key skills",
    "areas of expertise", "technologies",
}
_SECTION_HEADINGS = _COMPETENCY_HEADINGS | {
    "professional summary", "summary", "profile", "career summary",
    "professional experience", "work experience", "experience", "employment history",
    "education", "certifications", "projects", "selected projects", "publications",
    "awards", "additional information",
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
                run for run in value_cell.paragraphs[0].runs if (run.text or "")
            ]
            if len(nonempty_runs) > 1:
                continue
            before_items = _split_skill_list(value_cell.text)
            if len(before_items) < 2:
                continue
            evidence_by_item = {
                item: _matches_for_text(item, keywords, qualification_details)
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


def _semantic_tokens(document) -> Counter:
    """Content-token multiset used to prove table flattening lost no words."""
    tokens = []
    for paragraph in _iter_all_paragraphs(document):
        tokens.extend(re.findall(
            r"[a-z0-9][a-z0-9+#./%_-]*", paragraph.text or "", re.IGNORECASE
        ))
    return Counter(token.lower() for token in tokens)


def _copy_cell_content(target, cell) -> None:
    """Append a cell's text/runs to a body paragraph with formatting intact."""
    wrote = False
    for paragraph in cell.paragraphs:
        if wrote and (paragraph.text or "").strip():
            target.add_run(" ")
        if paragraph.runs:
            for run in paragraph.runs:
                if not run.text:
                    continue
                new_run = target.add_run(run.text)
                if run._r.rPr is not None:
                    new_run._r.insert(0, deepcopy(run._r.rPr))
                wrote = True
        elif (paragraph.text or "").strip():
            target.add_run(paragraph.text)
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
            for cell_index, cell in enumerate(cells):
                if cell_index:
                    paragraph.add_run("  ")
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


def _stabilize_page_breaks(document) -> Dict[str, Any] | None:
    """Prevent section/role headings from being orphaned at a page bottom."""
    before_tokens = _semantic_tokens(document)
    paragraphs = document.paragraphs
    changed = set()
    grouped_roles = []
    role_contexts = []
    for index, paragraph in enumerate(paragraphs):
        text = (paragraph.text or "").strip()
        if not text:
            continue
        if _norm_heading(text) in _SECTION_HEADINGS and index + 1 < len(paragraphs):
            paragraph.paragraph_format.keep_with_next = True
            changed.add(index)
        if not _EMPLOYMENT_DATE_RE.search(text):
            continue
        # Output from a previous tailoring pass already groups role/date/first
        # content into one paragraph with a line break. Treat it as complete;
        # otherwise a second Re-tailor would incorrectly absorb the preceding
        # paragraph and then one additional bullet on every run.
        if "<w:br" in paragraph._p.xml:
            paragraph.paragraph_format.keep_together = True
            paragraph.paragraph_format.widow_control = True
            changed.add(index)
            continue
        if index > 0:
            role_contexts.append((index - 1, index))
        # A role heading normally precedes the company/location/date line. Keep
        # both with the project lead (and that lead with the first bullet) so a
        # page never ends with an empty-looking role shell.
        for candidate in (index - 1, index, index + 1):
            if 0 <= candidate < len(paragraphs) and (paragraphs[candidate].text or "").strip():
                paragraphs[candidate].paragraph_format.keep_with_next = True
                changed.add(candidate)

    # Work backwards so removing source paragraphs never changes which saved
    # paragraph objects belong to a later role.
    for role_index, date_index in reversed(role_contexts):
        role = paragraphs[role_index]
        first_content = paragraphs[date_index + 1] if date_index + 1 < len(paragraphs) else None
        sources = [paragraphs[date_index]]
        first_text = (first_content.text or "").strip() if first_content is not None else ""
        # Group exactly the first content paragraph (project lead OR first
        # bullet) into the same keep-together paragraph. This is stronger and
        # more portable than keep-with-next, which Chromium-style DOCX renderers
        # can ignore and otherwise strands whichever role happens to hit the
        # page bottom. Later bullets remain ordinary paragraphs.
        group_first_content = bool(
            first_content is not None
            and first_text
            and "<w:br" not in role._p.xml
            and _norm_heading(first_text) not in _SECTION_HEADINGS
            and not _EMPLOYMENT_DATE_RE.search(first_text)
        )
        if group_first_content:
            sources.append(first_content)
        # Some headless renderers ignore keep-with-next and handle explicit page
        # breaks inconsistently. Preserve every run but group each short role
        # title and employer/date into one continuous paragraph. Avoid manual
        # line breaks because a few engines split at the break even when the
        # paragraph is marked keep-together.
        for source in sources:
            if source is first_content:
                role.add_run().add_break()
                role.add_run("    ")
            else:
                role.add_run("  |  ")
            source_properties = source._p.pPr
            for child in list(source._p):
                if child is not source_properties:
                    role._p.append(deepcopy(child))
            source._p.getparent().remove(source._p)
        role.paragraph_format.keep_together = True
        role.paragraph_format.widow_control = True
        role.paragraph_format.keep_with_next = False
        grouped_roles.append(role_index)

    grouped_roles.sort()
    # Long resumes in this template are intentionally two pages. Artifact-tool
    # (and some browser viewers) ignore keep-together at a page boundary, so the
    # third role can leave its heading at the bottom of page 1. A hard break in
    # its own empty paragraph is consistently honored and gives a clean split:
    # two most-recent roles on page 1, older experience + education on page 2.
    # It adds no text and is idempotent across Re-tailor runs.
    rendered_paragraphs = document.paragraphs
    roles = [p for p in rendered_paragraphs if _EMPLOYMENT_DATE_RE.search((p.text or "").strip())]
    word_count = len(re.findall(r"\b\w+\b", " ".join(p.text or "" for p in rendered_paragraphs)))
    boundary_breaks = 0
    if word_count >= 700 and len(roles) >= 3:
        target = roles[2]
        current_paragraphs = document.paragraphs
        target_index = next(i for i, paragraph in enumerate(current_paragraphs) if paragraph._p is target._p)
        prior = current_paragraphs[target_index - 1] if target_index > 0 else None
        if prior is None or 'w:type="page"' not in prior._p.xml:
            from docx.enum.text import WD_BREAK

            breaker = target.insert_paragraph_before()
            breaker.add_run().add_break(WD_BREAK.PAGE)
            boundary_breaks = 1

    if _semantic_tokens(document) != before_tokens:
        raise RuntimeError("role context grouping changed or duplicated resume text")

    if not changed:
        return None
    return {
        "type": "stabilize_page_breaks",
        "where": "section and employment headings",
        "before": "headings could be separated from their first content line",
        "after": (
            f"{len(changed)} paragraph(s) kept with their following context; "
            f"{len(grouped_roles)} dense role context block(s) grouped"
        ),
        "evidence": [{
            "paragraph_indexes": sorted(changed),
            "grouped_role_indexes": grouped_roles,
            "role_boundary_page_breaks": boundary_breaks,
            "text_changed": False,
        }],
        "reason": "prevents orphaned headings while leaving all resume text and chronology unchanged",
        "source": "master_resume",
    }


# Headings we prefer to anchor the per-job focus line above (in priority order).
# Placed just before the first match so the job's own terminology sits near the
# top of the resume, where ATS keyword parsers weigh it most.
_FOCUS_ANCHORS = ("core competencies", "professional summary", "professional experience")


def _norm_heading(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip().lower())


_SUMMARY_HEADINGS = {"professional summary", "summary", "profile", "career summary"}
_EXPERIENCE_HEADINGS = {
    "professional experience", "work experience", "experience", "employment history",
}


def _section_bounds(document, headings: set[str]) -> tuple[int, int] | None:
    """Locate a known section in the body-paragraph sequence."""
    paragraphs = document.paragraphs
    start = next(
        (index for index, para in enumerate(paragraphs) if _norm_heading(para.text) in headings),
        None,
    )
    if start is None:
        return None
    end = len(paragraphs)
    for index in range(start + 1, len(paragraphs)):
        if _norm_heading(paragraphs[index].text) in _SECTION_HEADINGS:
            end = index
            break
    return start + 1, end


def _is_bullet(paragraph) -> bool:
    style_name = (getattr(paragraph.style, "name", "") or "").lower()
    if "list" in style_name or "bullet" in style_name:
        return True
    ppr = paragraph._p.pPr
    if ppr is not None and ppr.numPr is not None:
        return True
    return bool(re.match(r"^\s*[•·▪◦]\s+", paragraph.text or ""))


def _nonempty_runs(paragraphs: Sequence[Any]) -> List[List[Any]]:
    """Return movable paragraph groups without moving spacers/focus lines."""
    groups: List[List[Any]] = []
    current: List[Any] = []
    for paragraph in paragraphs:
        is_focus_line = _norm_heading(paragraph.text).startswith(
            "most relevant to this role:"
        )
        if (paragraph.text or "").strip() and not is_focus_line:
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


def _insert_focus_line(
    document, present: List[str], patterns: Dict[str, Any] | None
) -> tuple[str, bool]:
    """Insert a per-job focus line built only from ``present`` keywords.

    The line is anchored above the first matching heading in ``_FOCUS_ANCHORS``
    (falling back to the top of the document). Returns ``(text, inserted)``.
    An existing focus line is reused to prevent duplicate content.
    """
    label = "Most relevant to this role"
    text = humanize(f"{label}: {', '.join(present)}.", patterns or {})

    for paragraph in document.paragraphs:
        if _norm_heading(paragraph.text).startswith(_norm_heading(label) + ":"):
            return paragraph.text, False

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
    return text, True


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
    for keyword in keywords:
        key = re.sub(r"\s+", " ", str(keyword).lower()).strip()
        if not key or key in seen:
            continue
        seen.add(key)
        matches: List[Dict[str, str]] = []
        for term in _evidence_terms(str(keyword), evidence_aliases):
            for line in resume_text.splitlines():
                clean = re.sub(r"\s+", " ", line).strip()
                if clean and _phrase_pattern(term).search(clean):
                    matches.append({
                        "matched_term": term,
                        "resume_text": clean[:300],
                    })
                    break
        target = present if matches else missing
        target.append(keyword)
        if matches:
            supported_by[str(keyword)] = matches
    return {
        "present": present,
        "missing": missing,
        "supported_by": supported_by,
    }


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
    found: List[Dict[str, str]] = []
    for term in _evidence_terms(keyword, evidence_aliases):
        for line in resume_text.splitlines():
            clean = re.sub(r"\s+", " ", line).strip()
            if clean and _phrase_pattern(term).search(clean):
                found.append({
                    "keyword": keyword,
                    "matched_term": term,
                    "resume_text": clean[:300],
                })
                break
        if len(found) == 3:
            break
    return found


def _content_units(document) -> List[str]:
    """Atomic exact-text units used by the no-loss/no-copy invariant."""
    units = [
        f"paragraph:{paragraph.text}"
        for paragraph in document.paragraphs
        if (paragraph.text or "").strip()
    ]
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
    inserted_focus_text: str | None,
) -> Dict[str, Any]:
    """Fail closed if tailoring changed claims, role scope, or formatting."""
    expected_units = Counter(source_units)
    if inserted_focus_text:
        expected_units[f"paragraph:{inserted_focus_text}"] += 1
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
    paragraph_styles_preserved = all(
        source_styles[node] == next(
            paragraph.style.name or ""
            for paragraph in document.paragraphs
            if paragraph._p is node
        )
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


def tailor_resume(
    master_path: str | Path,
    output_dir: str | Path,
    job: Dict[str, Any],
    keywords: Iterable[str],
    patterns: Dict[str, Any] | None = None,
    *,
    add_summary_line: bool = False,
    required_markers: Iterable[str] | None = None,
    preferred_markers: Iterable[str] | None = None,
    evidence_aliases: Dict[str, Sequence[str]] | None = None,
    enable_rewrites: bool = False,
    now: datetime | None = None,
    output_name: str | None = None,
) -> Dict[str, Any]:
    """Create a tailored resume for ``job`` and return a result dict.

    The function may reorder exact existing content and change emphasis. It
    never rewrites claims. ``enable_rewrites`` is accepted only so callers get
    an explicit policy response; it does not enable an unsafe implementation.

    Returns the output path plus qualification audit, selected content,
    provenance records, gaps, rewrite policy, and verified invariants.
    Raises FileNotFoundError if the master is missing.
    """
    from docx import Document

    master_path = Path(master_path)
    if not master_path.exists():
        raise FileNotFoundError(f"Master resume not found: {master_path}")

    keywords = list(keywords)
    resume_text = read_docx_text(master_path)
    audit = _audit_supported_keywords(resume_text, keywords, evidence_aliases)
    qualifications = classify_qualification_keywords(
        job.get("jd_text", ""),
        keywords,
        required_markers=list(required_markers or _DEFAULT_REQUIRED_MARKERS),
        preferred_markers=list(preferred_markers or _DEFAULT_PREFERRED_MARKERS),
    )
    qualifications["audit"] = _qualification_audit(qualifications, audit)
    qualification_details = _keyword_details(qualifications)

    # Open the master read-only: we load it, mutate the in-memory copy, and save
    # to a NEW path. The master file on disk is never written.
    document = Document(str(master_path))
    source_units = _content_units(document)
    source_nodes = [paragraph._p for paragraph in document.paragraphs]
    source_styles = {
        paragraph._p: paragraph.style.name or "" for paragraph in document.paragraphs
    }
    changes: List[Dict[str, Any]] = []

    content_changes, selected_content, movable_nodes = _prioritize_existing_content(
        document, audit["present"], qualification_details
    )
    changes.extend(content_changes)

    competency_changes = _reorder_competencies(
        document, audit["present"], qualification_details
    )
    changes.extend(competency_changes)

    emphasized, emphasis_evidence, emphasis_mutations = _emphasize(
        document, audit["present"], qualification_details
    )
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

    summary_line = None
    focus_line_inserted = False
    limitations = [
        (
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
    if add_summary_line and audit["present"]:
        indexed_present = list(enumerate(audit["present"]))
        ranked_present = [
            keyword for _index, keyword in sorted(
                indexed_present,
                key=lambda pair: (
                    -_QUALIFICATION_WEIGHT.get(
                        qualification_details.get(
                            re.sub(r"\s+", " ", str(pair[1]).lower()).strip(), {}
                        ).get("classification", "unclassified"),
                        1,
                    ),
                    pair[0],
                ),
            )
        ]
        summary_line, focus_line_inserted = _insert_focus_line(
            document, ranked_present, patterns
        )
        if focus_line_inserted:
            focus_evidence = []
            for keyword in ranked_present:
                key = re.sub(r"\s+", " ", str(keyword).lower()).strip()
                detail = qualification_details.get(key, {})
                focus_evidence.append({
                    "keyword": keyword,
                    "qualification": detail.get("classification", "unclassified"),
                    "master_resume_evidence": _resume_evidence(
                        resume_text, str(keyword), evidence_aliases
                    ),
                    "jd_evidence": detail.get("jd_evidence", []),
                })
            changes.append({
                "type": "focus_line",
                "where": "above the first recognized resume section",
                "before": "",
                "after": summary_line,
                "evidence": focus_evidence,
                "reason": (
                    "surfaces only terms already evidenced in the master resume, with "
                    "required terms listed first"
                ),
                "source": "master_resume",
            })
        else:
            limitations.append(
                "An existing 'Most relevant to this role' line was reused; a duplicate was not inserted."
            )

    # Requirements the resume does NOT evidence. Reported, never inserted.
    gaps = []
    has_jd_text = bool((job.get("jd_text") or "").strip())
    for keyword in audit.get("missing", []):
        key = re.sub(r"\s+", " ", str(keyword).lower()).strip()
        detail = qualification_details.get(key, {})
        # Stored score keywords can outlive a later JD refresh. Never display a
        # purported gap when the current non-empty JD has no occurrence/evidence.
        if has_jd_text and not detail.get("jd_evidence"):
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

    rewrite_policy = {
        "mode": "disabled",
        "requested": bool(enable_rewrites),
        "applied": 0,
        "reason": (
            "Claim rewriting requires an approved claim-level evidence map; none is accepted "
            "by this deterministic tailor."
        ),
    }
    if enable_rewrites:
        limitations.append(
            "A rewrite was requested but deliberately not performed because supported rewriting is unavailable."
        )

    invariants = _verify_truth_invariants(
        document,
        source_units=source_units,
        source_nodes=source_nodes,
        source_styles=source_styles,
        movable_nodes=movable_nodes,
        inserted_focus_text=summary_line if focus_line_inserted else None,
    )

    table_change = _flatten_tables_for_ats(document)
    if table_change:
        changes.append(table_change)
    pagination_change = _stabilize_page_breaks(document)
    if pagination_change:
        changes.append(pagination_change)
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
        "summary_line": summary_line,
        "changes": changes,
        "gaps": gaps,
        "selected_content": selected_content,
        "rewrite_policy": rewrite_policy,
        "invariants": invariants,
        "limitations": limitations,
    }

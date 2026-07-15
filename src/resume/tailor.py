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
  6. Save the result to a per-job .docx in the job's output folder.

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


def _audit_supported_keywords(resume_text: str, keywords: Sequence[str]) -> Dict[str, List[str]]:
    """Boundary-aware audit used for mutation decisions.

    The general reporting audit historically uses substring matching. Tailoring
    must be stricter: e.g. ``go`` inside ``Golang`` is not evidence of Go, and
    ``C`` inside every sentence is not evidence of the C language.
    """
    normalized_resume = re.sub(r"\s+", " ", resume_text or "")
    present: List[str] = []
    missing: List[str] = []
    seen = set()
    for keyword in keywords:
        key = re.sub(r"\s+", " ", str(keyword).lower()).strip()
        if not key or key in seen:
            continue
        seen.add(key)
        target = present if _phrase_pattern(str(keyword)).search(normalized_resume) else missing
        target.append(keyword)
    return {"present": present, "missing": missing}


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


def _resume_evidence(resume_text: str, keyword: str) -> List[Dict[str, str]]:
    """Return compact exact master-resume excerpts supporting a term."""
    found: List[Dict[str, str]] = []
    for line in resume_text.splitlines():
        clean = re.sub(r"\s+", " ", line).strip()
        if clean and _phrase_pattern(str(keyword)).search(clean):
            found.append({"keyword": keyword, "resume_text": clean[:300]})
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
    audit = _audit_supported_keywords(resume_text, keywords)
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
            "Content prioritization moves only intact summary paragraphs and contiguous "
            "Word list bullets within their original role; it does not split sentences or "
            "restructure complex tables/text boxes."
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
                    "master_resume_evidence": _resume_evidence(resume_text, str(keyword)),
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
    for keyword in audit.get("missing", []):
        key = re.sub(r"\s+", " ", str(keyword).lower()).strip()
        detail = qualification_details.get(key, {})
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

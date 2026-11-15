"""The PDF is the document you approve (audit R7).

The Chromium PDF was the resume re-typeset with a fixed stylesheet (10.5 pt,
0.55 in margins, bold only), so its pages and look could differ from the DOCX
the page fit was computed for. Now LibreOffice, when installed, renders the
DOCX itself and goes first; the Chromium fallback carries the document's own
font, size, margins, alignment, italics, underlines and right-aligned dates.
"""
from __future__ import annotations

import re

import pytest
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT
from docx.shared import Inches, Pt

import pagefit
import pdfExport
import resume_corpus as corpus
import tailor


def test_libreoffice_goes_first_and_word_is_not_tried_when_it_works(tmp_path, monkeypatch):
    calls = []

    def libre(docx, pdf, timeout=0):
        calls.append("libreoffice")
        pdf.write_bytes(b"%PDF-1.4 /Type /Page /Count 1")
        return {"exported": True, "pdf_path": str(pdf), "pages": 1, "reason": "ok (LibreOffice)"}

    monkeypatch.setattr(pdfExport, "find_soffice", lambda: "/usr/bin/soffice")
    monkeypatch.setattr(pdfExport, "_export_with_libreoffice", libre)
    monkeypatch.setattr(pdfExport, "_export_with_word", lambda *a, **k: calls.append("word") or None)
    result = pdfExport.export_to_pdf(corpus.build("baseline", tmp_path))
    assert result["reason"] == "ok (LibreOffice)"
    assert calls == ["libreoffice"]


def test_word_is_the_fallback_when_libreoffice_fails(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(pdfExport, "find_soffice", lambda: "/usr/bin/soffice")
    monkeypatch.setattr(pdfExport, "_export_with_libreoffice",
                        lambda *a, **k: calls.append("libreoffice") or {"exported": False, "reason": "boom"})
    monkeypatch.setattr(pdfExport, "_export_with_word", lambda *a, **k: calls.append("word") or "no Word here")
    result = pdfExport.export_to_pdf(corpus.build("baseline", tmp_path))
    assert calls == ["libreoffice", "word"]
    assert result["exported"] is False and "boom" in result["reason"] and "no Word here" in result["reason"]


@pytest.mark.skipif(not pagefit.measurement_available(), reason="LibreOffice is not installed")
def test_the_pdf_has_the_pages_the_fit_measured(tmp_path):
    master = corpus.build("georgia_spaced", tmp_path)
    result = pdfExport.export_to_pdf(master)
    assert result["exported"] and result["reason"] == "ok (LibreOffice)"
    assert result["pages"] == pagefit.measure_pages(master)


def _styled(tmp_path):
    doc = Document()
    normal = doc.styles["Normal"]
    normal.font.name = "Georgia"
    normal.font.size = Pt(11.5)
    section = doc.sections[0]
    section.left_margin = section.right_margin = Inches(0.7)
    section.top_margin = section.bottom_margin = Inches(0.6)
    name = doc.add_paragraph("Jordan Example")
    name.alignment = WD_ALIGN_PARAGRAPH.CENTER
    doc.add_paragraph("PROFESSIONAL EXPERIENCE")
    role = doc.add_paragraph("Senior Data Engineer | Example Corp\tJan 2019 - Present")
    role.paragraph_format.tab_stops.add_tab_stop(Inches(7.1), WD_TAB_ALIGNMENT.RIGHT)
    bullet = doc.add_paragraph(style="List Bullet")
    bullet.add_run("Moved jobs to ")
    bullet.add_run("Spark").italic = True
    bullet.add_run(" and wrote the ")
    bullet.add_run("runbook").underline = True
    bullet.add_run(".")
    path = tmp_path / "styled.docx"
    doc.save(str(path))
    return path


def test_the_html_carries_the_documents_own_font_size_and_margins(tmp_path):
    html = tailor.docx_to_html(_styled(tmp_path))["html"]
    assert "font-family:'Georgia'" in html.replace('"', "'")
    assert "font-size:11.5pt" in html
    assert re.search(r"@page\{size:8\.5in 11in;margin:0\.6in 0\.7in 0\.6in 0\.7in\}", html)


def test_the_html_carries_italics_underlines_and_alignment(tmp_path):
    html = tailor.docx_to_html(_styled(tmp_path))["html"]
    assert "<em>Spark</em>" in html
    assert "<u>runbook</u>" in html
    assert '<p style="text-align:center">Jordan Example</p>' in html


def test_right_tabbed_dates_stay_at_the_right_edge(tmp_path):
    rendering = tailor.docx_to_html(_styled(tmp_path))
    assert '<span class="tab-right">Jan 2019 - Present</span>' in rendering["html"]
    # The completeness check still finds the whole line.
    assert "Senior Data Engineer | Example Corp\tJan 2019 - Present" in rendering["texts"]

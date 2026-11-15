"""The page estimate reads styles and fonts, calibrated against LibreOffice (audit R6)."""
from __future__ import annotations

from pathlib import Path

import pytest
from docx import Document

import pagefit
import tailor
from pagefit_fixtures import MEASURED, VARIANTS, build, build_repeat

REPO = Path(__file__).resolve().parents[2]
EXAMPLE = REPO / "resumes" / "base" / "MASTER_RESUME.example.docx"


def _doc(name, tmp_path):
    if name == "example master":
        return Document(str(EXAMPLE))
    path = tmp_path / "v.docx"
    doc = build_repeat(int(name.split("b")[-1])) if name.startswith("repeat") else build(**VARIANTS[name])
    doc.save(str(path))
    return Document(str(path))


@pytest.mark.parametrize("name", list(MEASURED))
def test_the_estimate_is_within_an_eighth_of_a_page_of_libreoffice(name, tmp_path):
    estimate = pagefit.estimate_page_count(_doc(name, tmp_path))
    assert abs(estimate - MEASURED[name][0]) <= 0.125, (name, estimate)


def test_it_reads_spacing_and_fonts_set_on_styles_and_defaults(tmp_path):
    """The old estimate saw none of these: same text, very different lengths."""
    plain = pagefit.estimate_page_count(_doc("calibri11 single 0after b30", tmp_path))
    styled = pagefit.estimate_page_count(_doc("georgia12 1.15 6after b30", tmp_path))
    assert styled >= plain * 1.25


def test_the_tailor_uses_it():
    assert tailor.estimate_page_count is pagefit.estimate_page_count


@pytest.mark.skipif(not pagefit.measurement_available(), reason="LibreOffice is not installed")
@pytest.mark.parametrize("name", ["default b14", "georgia12 1.15 6after b30", "example master"])
def test_libreoffice_still_measures_what_was_recorded(name, tmp_path):
    path = EXAMPLE if name == "example master" else tmp_path / "v.docx"
    if name != "example master":
        build(**VARIANTS[name]).save(str(path))
    assert pagefit.measure_pages(path) == MEASURED[name][1]


def test_without_libreoffice_measurement_says_so(monkeypatch, tmp_path):
    monkeypatch.setattr(pagefit, "libreoffice", lambda: None)
    assert pagefit.measure_pages(EXAMPLE) is None


# ── the measured fit ─────────────────────────────────────────────────────────

JOB = {"company": "Example", "title": "Data Engineer", "jd_text": "Required: SQL and Python."}


def _long_master(tmp_path, old_bullets=10):
    doc = Document()
    for text in ("Candidate Name", "PROFESSIONAL EXPERIENCE", "Senior Data Engineer", "Acme - Remote - March 2022 - Present"):
        doc.add_paragraph(text)
    for i in range(4):
        doc.add_paragraph(f"Delivered SQL and Python platform outcome {i} for finance.", style="List Bullet")
    doc.add_paragraph("BI Developer")
    doc.add_paragraph("Older Co - Remote - January 2018 - December 2019")
    for i in range(old_bullets):
        doc.add_paragraph(f"Produced routine monthly spreadsheets {i} for the regional office.", style="List Bullet")
    path = tmp_path / "long.docx"
    doc.save(str(path))
    return path


class FakeRenderer:
    """Pages = 2 while more than `fits_at` bullets remain, else 1; counts calls."""

    def __init__(self, fits_at):
        self.fits_at = fits_at
        self.calls = 0

    def __call__(self, document):
        self.calls += 1
        bullets = sum(1 for p in document.paragraphs if p.style.name == "List Bullet")
        return 1 if bullets <= self.fits_at else 2


def _fit(result):
    return next((c for c in result["changes"] if c["type"] == "fit_to_page_budget"), None)


def test_the_render_decides_how_many_bullets_go(tmp_path):
    render = FakeRenderer(fits_at=9)  # 14 bullets: five must go
    result = tailor.tailor_resume(_long_master(tmp_path), tmp_path / "out", JOB, ["sql", "python"], {},
                                  max_pages=1, measure_pages=render)
    evidence = _fit(result)["evidence"][0]
    assert len(evidence["omitted"]) == 5
    assert evidence == {**evidence, "pages": 1, "measured_by": "LibreOffice"}
    assert result["invariants"]["measured_pages"] == 1
    assert result["invariants"]["within_page_budget"] is True
    assert render.calls <= 8


def test_bullets_the_estimate_would_drop_needlessly_are_kept(tmp_path, monkeypatch):
    # The estimate says five pages; the render says it all fits on one.
    monkeypatch.setattr(tailor, "estimate_page_count", lambda document: 5.0)
    render = FakeRenderer(fits_at=99)
    result = tailor.tailor_resume(_long_master(tmp_path), tmp_path / "out", JOB, ["sql", "python"], {},
                                  max_pages=1, measure_pages=render)
    assert _fit(result) is None
    assert not any("over the" in line for line in result["limitations"])


def test_a_document_the_estimate_thought_fit_is_trimmed_when_it_renders_long(tmp_path):
    render = FakeRenderer(fits_at=12)
    result = tailor.tailor_resume(_long_master(tmp_path), tmp_path / "out", JOB, ["sql", "python"], {},
                                  max_pages=5, measure_pages=lambda d: 6 if render(d) == 2 else 5)
    assert len(_fit(result)["evidence"][0]["omitted"]) == 2


def test_when_the_render_cannot_say_the_estimate_decides(tmp_path):
    result = tailor.tailor_resume(_long_master(tmp_path), tmp_path / "out", JOB, ["sql", "python"], {},
                                  max_pages=0.2, measure_pages=lambda d: None)
    evidence = _fit(result)["evidence"][0]
    assert evidence["measured_by"] is None and evidence["omitted"]


@pytest.mark.skipif(not pagefit.measurement_available(), reason="LibreOffice is not installed")
def test_with_libreoffice_the_tailored_file_renders_within_budget(tmp_path):
    from pagefit_fixtures import build_repeat
    master = tmp_path / "dense.docx"
    doc = build_repeat(14)
    doc.add_paragraph("Data Engineer")
    doc.add_paragraph("Older Co - Remote - January 2018 - December 2019")
    for i in range(24):
        doc.add_paragraph(f"Produced routine monthly spreadsheets {i} for the regional office. " * 2, style="List Bullet")
    doc.save(str(master))
    result = tailor.tailor_resume(master, tmp_path / "out", JOB, ["sql", "python"], {},
                                  max_pages=2, measure_pages=pagefit.measure_document)
    assert pagefit.measure_pages(result["output_path"]) <= 2
    assert _fit(result)["evidence"][0]["measured_by"] == "LibreOffice"

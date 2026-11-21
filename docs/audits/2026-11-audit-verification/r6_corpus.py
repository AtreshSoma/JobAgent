"""R6/R7 measurement: estimated vs Word-rendered page counts (fictional resumes).

Usage: python -I r6_corpus.py <repo_root> <out_dir>
Prints JSON lines: name, estimate, word_pages.
"""
import json
import shutil
import sys
from pathlib import Path

repo = Path(sys.argv[1]).resolve()
out = Path(sys.argv[2]).resolve()
out.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(repo / "src" / "resume"))

from docx import Document  # noqa: E402
from docx.shared import Pt, Inches  # noqa: E402

import tailor  # noqa: E402
from pdfExport import export_to_pdf  # noqa: E402

BULLET = ("Designed and maintained batch and streaming data pipelines that fed finance, "
          "operations and product reporting for regional teams, cutting refresh time by {n}%.")


def build(name, *, font="Calibri", size=11, spacing=None, after=None, roles=4, bullets=7, indent=None):
    d = Document()
    normal = d.styles["Normal"]
    normal.font.name = font
    normal.font.size = Pt(size)
    if spacing is not None:
        normal.paragraph_format.line_spacing = spacing
    if after is not None:
        normal.paragraph_format.space_after = Pt(after)
    sec = d.sections[0]
    sec.left_margin = sec.right_margin = Inches(0.75)
    sec.top_margin = sec.bottom_margin = Inches(0.6)
    d.add_paragraph("Jordan Example")
    d.add_paragraph("Springfield, IL | 555-010-0000 | jordan@example.com")
    d.add_paragraph("PROFESSIONAL SUMMARY")
    d.add_paragraph("Data engineer with ten years of experience building reliable reporting platforms "
                    "for finance and operations teams across several industries.")
    d.add_paragraph("PROFESSIONAL EXPERIENCE")
    for r in range(roles):
        d.add_paragraph(f"Data Engineer | Example Corp {r} | Jan {2022 - 3 * r} - Dec {2024 - 3 * r}")
        for b in range(bullets):
            p = d.add_paragraph(BULLET.format(n=10 + b), style="List Bullet")
            if indent is not None:
                p.paragraph_format.left_indent = Inches(indent)
    d.add_paragraph("EDUCATION")
    d.add_paragraph("B.S. Computer Science, Example University")
    path = out / f"{name}.docx"
    d.save(path)
    return path


variants = [
    build("calibri11_4x7"),
    build("calibri11_4x9", bullets=9),
    build("calibri11_spacing115_after6", spacing=1.15, after=6),
    build("times10_tight", font="Times New Roman", size=10, bullets=9),
    build("georgia12", font="Georgia", size=12),
    build("calibri11_indent05", indent=0.5, bullets=8),
]
example = repo / "resumes" / "base" / "MASTER_RESUME.example.docx"
if example.exists():
    target = out / "shipped_example.docx"
    shutil.copy(example, target)
    variants.append(target)

for path in variants:
    est = tailor.estimate_page_count(Document(str(path)))
    res = export_to_pdf(str(path), str(path.with_suffix(".pdf")))
    print(json.dumps({"name": path.stem, "estimate": round(est, 2),
                      "word_pages": res.get("page_count") or res.get("pages"),
                      "exported": res.get("exported"), "reason": res.get("reason")}), flush=True)

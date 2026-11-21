"""Reproduction harness for audit findings R1-R5 (fictional data only).

Usage: python -I r1_r5_harness.py <repo_root> <out_dir>
"""
import json
import sys
from pathlib import Path

repo = Path(sys.argv[1]).resolve()
out = Path(sys.argv[2]).resolve()
out.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(repo / "src" / "resume"))

from docx import Document  # noqa: E402
from docx.opc.constants import RELATIONSHIP_TYPE as RT  # noqa: E402
from docx.oxml import OxmlElement  # noqa: E402
from docx.oxml.ns import qn  # noqa: E402

import tailor  # noqa: E402


def add_hyperlink(paragraph, url, text):
    r_id = paragraph.part.relate_to(url, RT.HYPERLINK, is_external=True)
    link = OxmlElement("w:hyperlink")
    link.set(qn("r:id"), r_id)
    run = OxmlElement("w:r")
    t = OxmlElement("w:t")
    t.text = text
    run.append(t)
    link.append(run)
    paragraph._p.append(link)


doc = Document()
doc.add_paragraph("Jordan Example")
contact = doc.add_paragraph("Springfield, IL | 555-010-0000 | ")
add_hyperlink(contact, "mailto:jordan@example.com", "jordan@example.com")
doc.add_paragraph("PROFESSIONAL SUMMARY")
doc.add_paragraph(
    "Data engineer who owned the go-live of three platforms and partnered with R&D. "
    "I excel at turning messy sources into reliable reporting."
)
doc.add_paragraph("EDUCATION")
doc.add_paragraph("B.S. Computer Science, Example University, 2012 - 2016")
doc.add_paragraph("PROFESSIONAL EXPERIENCE")
doc.add_paragraph("Senior Data Engineer | Example Corp | Jan 2019 - Present")
doc.add_paragraph("Built data pipelines for finance reporting, cutting refresh time by 40%.", style="List Bullet")
doc.add_paragraph("- Led the March 2021 migration to Airflow.")
for i in range(1, 9):
    doc.add_paragraph(f"Maintained internal reporting job number {i} for the operations group.", style="List Bullet")
doc.add_paragraph("Data Engineer | Sample LLC | Jun 2016 - Dec 2018")
for i in range(1, 9):
    doc.add_paragraph(f"Supported nightly batch loads for business unit {i} across regions.", style="List Bullet")

master = out / "master_r1_r5.docx"
doc.save(master)

keywords = ["data pipeline", "spark", "go", "r", "excel", "airflow"]
jd = (
    "Required qualifications: experience building a data pipeline; Spark; Go; R; Excel; Airflow.\n"
)
result = tailor.tailor_resume(
    master, out / "tailored", {"company": "Example Co", "title": "Data Engineer", "jd_text": jd},
    keywords, {}, max_pages=1, add_summary_line=True,
)

report = {}
# R2 / R3: present vs missing
report["present"] = result["audit"]["present"]
report["missing"] = result["audit"]["missing"]
report["supported_by"] = {k: [m["resume_text"][:90] for m in v] for k, v in result["audit"]["supported_by"].items()}
report["summary_line"] = result["summary_line"]
emph = next((c for c in result["changes"] if c["type"] == "emphasize"), None)
report["bolded"] = [a["text"] for a in (emph or {}).get("after", [])]
report["bolded_where"] = [e["resume_text"][:70] for e in (emph or {}).get("evidence", [])]

# R1: html from the tailored output and from the master
for label, path in (("master", master), ("tailored", Path(result["output_path"]))):
    rendering = tailor.docx_to_html(path)
    report[f"R1_{label}_html_has_email"] = "jordan@example.com" in rendering["html"]
    report[f"R1_{label}_texts_have_email"] = any("jordan@example.com" in t for t in rendering["texts"])
report["tailored_path"] = result["output_path"]

# R4 / R5: master_units kinds
units = tailor.master_units(master)
report["units"] = [(u["kind"], u["text"][:60], (u["role"] or "")[:40]) for u in units]

# R4: roles as the page fit sees them
fit = next((c for c in result["changes"] if c["type"] == "fit_to_page_budget"), None)
if fit:
    ev = fit["evidence"][0]
    report["fit_roles_kept"] = ev["roles_kept"]
    report["fit_omitted"] = [(o["role"][:50], o["text"][:50]) for o in ev["omitted"]]
report["limitations_tail"] = result["limitations"][4:]

print(json.dumps(report, indent=1, ensure_ascii=False))

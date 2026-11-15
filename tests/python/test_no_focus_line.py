"""The "Most relevant to this role" line is gone (audit R9).

It was text the master resume never contained, in the config's lowercase
spelling ("go, r, excel"), and it contradicted "nothing is added". Off by
default but one setting away. The option is removed, not hidden.
"""
from __future__ import annotations

import inspect
import json
import subprocess
import sys
from pathlib import Path

from docx import Document

import tailor

REPO = Path(__file__).resolve().parents[2]


def _master(tmp_path):
    doc = Document()
    for line in ("PROFESSIONAL SUMMARY", "Data engineer building Airflow and Spark pipelines.",
                 "CORE COMPETENCIES", "Data Platforms:  Airflow, Spark, SQL"):
        doc.add_paragraph(line)
    path = tmp_path / "master.docx"
    doc.save(str(path))
    return path


def test_the_tailor_has_no_focus_line_option():
    assert "add_summary_line" not in inspect.signature(tailor.tailor_resume).parameters
    assert not hasattr(tailor, "_insert_focus_line")


def test_a_request_that_still_asks_for_it_adds_no_line(tmp_path):
    request = {
        "master_path": str(_master(tmp_path)), "output_dir": str(tmp_path / "out"),
        "job": {"company": "Example", "title": "Data Engineer", "jd_text": "Required: Airflow and Spark."},
        "keywords": ["airflow", "spark"], "patterns": {}, "add_summary_line": True,
    }
    done = subprocess.run([sys.executable, str(REPO / "src" / "resume" / "tailor_cli.py")],
                          input=json.dumps(request), capture_output=True, text=True, check=True)
    response = json.loads(done.stdout)
    assert response["ok"] is True
    assert "summary_line" not in response
    texts = [p.text for p in Document(response["output_path"]).paragraphs]
    assert not any(t.lower().startswith("most relevant to this role") for t in texts)
    assert not any(c["type"] == "focus_line" for c in response["changes"])

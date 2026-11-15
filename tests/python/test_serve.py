"""One long-lived Python per worker (audit R17): tailor_cli.py --serve."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import resume_corpus as corpus

CLI = Path(__file__).resolve().parents[2] / "src" / "resume" / "tailor_cli.py"


def _serve(lines):
    done = subprocess.run([sys.executable, str(CLI), "--serve"], input="".join(lines),
                          capture_output=True, text=True, timeout=120, check=True)
    return [json.loads(line) for line in done.stdout.splitlines() if line.strip()]


def test_answers_each_request_on_its_own_line_with_its_id(tmp_path):
    master = corpus.build("baseline", tmp_path)
    replies = _serve([
        json.dumps({"_id": 1, "mode": "html", "docx_path": str(master)}) + "\n",
        json.dumps({"_id": 2, "mode": "units", "master_path": str(master)}) + "\n",
        json.dumps({"_id": 3, "mode": "html"}) + "\n",
    ])
    assert [r["_id"] for r in replies] == [1, 2, 3]
    assert replies[0]["ok"] and corpus.EMAIL in replies[0]["html"]
    assert replies[1]["ok"] and replies[1]["units"]
    assert replies[2] == {"_id": 3, "ok": False, "error": "docx_path is required"}


def test_a_bad_line_is_answered_and_the_worker_carries_on(tmp_path):
    master = corpus.build("baseline", tmp_path)
    replies = _serve(["not json\n", json.dumps({"_id": 9, "mode": "units", "master_path": str(master)}) + "\n"])
    assert replies[0]["ok"] is False and "invalid JSON" in replies[0]["error"]
    assert replies[1]["_id"] == 9 and replies[1]["ok"]


def test_without_serve_it_still_answers_one_request():
    done = subprocess.run([sys.executable, str(CLI)], input=json.dumps({"mode": "html"}),
                          capture_output=True, text=True, timeout=60, check=True)
    assert json.loads(done.stdout) == {"ok": False, "error": "docx_path is required"}

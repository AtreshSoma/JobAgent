"""Small JSON bridge for on-demand DOCX-to-PDF resume previews."""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


def main() -> int:
    try:
        request = json.loads(sys.stdin.read() or "{}")
        from pdfExport import export_to_pdf

        result = export_to_pdf(request.get("docx_path", ""), request.get("pdf_path") or None)
        print(json.dumps(result))
    except Exception as err:  # noqa: BLE001 - process boundary must return JSON
        print(json.dumps({"exported": False, "pdf_path": None, "reason": f"{type(err).__name__}: {err}"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

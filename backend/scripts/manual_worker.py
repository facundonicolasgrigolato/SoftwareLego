"""Worker persistente (stdin/stdout JSONL) para metadatos y renderizado PNG de manuales PDF."""

from __future__ import annotations

import base64
import json
import sys
from collections import OrderedDict
from pathlib import Path

import pymupdf

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.config import AppPaths  # noqa: E402
from app.manual_viewer import find_set_pdf  # noqa: E402

MAX_OPEN_DOCS = 4


class ManualWorker:
    def __init__(self, sets_dir: Path | None = None) -> None:
        self.sets_dir = sets_dir or AppPaths().sets_dir
        self._path_cache: dict[tuple[str, str], Path] = {}
        self._docs: OrderedDict[Path, pymupdf.Document] = OrderedDict()

    def clear_cache(self) -> None:
        self._path_cache.clear()
        for doc in self._docs.values():
            try:
                doc.close()
            except Exception:
                pass
        self._docs.clear()

    def _resolve_pdf(self, set_number: str, source_pdf: str) -> Path | None:
        key = (set_number, source_pdf)
        cached = self._path_cache.get(key)
        if cached and cached.is_file():
            return cached
        found = find_set_pdf(self.sets_dir, set_number, source_pdf or None)
        if found is not None:
            self._path_cache[key] = found
        return found

    def _get_doc(self, pdf_path: Path) -> pymupdf.Document:
        if pdf_path in self._docs:
            self._docs.move_to_end(pdf_path)
            return self._docs[pdf_path]
        doc = pymupdf.open(pdf_path)
        self._docs[pdf_path] = doc
        while len(self._docs) > MAX_OPEN_DOCS:
            _, oldest = self._docs.popitem(last=False)
            try:
                oldest.close()
            except Exception:
                pass
        return doc

    def handle_request(self, req: dict) -> dict:
        req_id = req.get("id")
        action = req.get("action")
        if action == "clear_cache":
            self.clear_cache()
            return {"id": req_id, "ok": True}

        set_number = str(req.get("set") or "")
        source_pdf = str(req.get("source") or "")
        pdf_path = self._resolve_pdf(set_number, source_pdf)
        if not pdf_path:
            return {"id": req_id, "ok": False, "error": "No se encontró el archivo PDF en Sets/."}

        doc = self._get_doc(pdf_path)
        if action == "info":
            aspects = [
                round(float(page.rect.height) / max(1.0, float(page.rect.width)), 4)
                for page in doc
            ]
            return {
                "id": req_id,
                "ok": True,
                "payload": {
                    "ok": True,
                    "filename": pdf_path.name,
                    "pageCount": len(doc),
                    "pageAspects": aspects,
                },
            }

        if action == "page":
            if len(doc) == 0:
                return {"id": req_id, "ok": False, "error": "El PDF no contiene páginas."}
            page_1based = int(req.get("page") or 1)
            scale = max(1.0, min(3.0, float(req.get("scale") or 2.0)))
            idx = max(0, min(len(doc) - 1, page_1based - 1))
            pix = doc[idx].get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
            png_b64 = base64.b64encode(pix.tobytes("png")).decode("ascii")
            return {"id": req_id, "ok": True, "png_b64": png_b64}

        return {"id": req_id, "ok": False, "error": f"Acción desconocida: {action}"}


def main() -> int:
    worker = ManualWorker()
    try:
        for raw_line in sys.stdin:
            line = raw_line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
                resp = worker.handle_request(req)
            except Exception as exc:
                req_id = None
                try:
                    req_id = json.loads(line).get("id")
                except Exception:
                    pass
                resp = {"id": req_id, "ok": False, "error": str(exc) or exc.__class__.__name__}
            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()
    finally:
        worker.clear_cache()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

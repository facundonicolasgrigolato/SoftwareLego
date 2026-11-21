"""CLI auxiliar para obtener metadatos o renderizar páginas de manuales PDF."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.config import AppPaths  # noqa: E402
from app.manual_viewer import find_set_pdf, get_manual_info, render_manual_page_png  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Renderiza páginas de manuales LEGO PDF.")
    parser.add_argument("--set", dest="set_number", required=True)
    parser.add_argument("--source", dest="source_pdf", default="")
    parser.add_argument("--info", action="store_true")
    parser.add_argument("--page", type=int, default=1)
    parser.add_argument("--scale", type=float, default=2.0)
    args = parser.parse_args()

    paths = AppPaths()
    pdf_path = find_set_pdf(paths.sets_dir, args.set_number, args.source_pdf or None)
    if not pdf_path:
        if args.info:
            print(json.dumps({"ok": False, "error": "No se encontró el archivo PDF en Sets/."}))
        else:
            sys.stderr.write("No se encontró el archivo PDF en Sets/.\n")
        return 1

    if args.info:
        info = get_manual_info(pdf_path)
        print(json.dumps(info))
        return 0

    png_bytes = render_manual_page_png(pdf_path, args.page, scale=args.scale)
    sys.stdout.buffer.write(png_bytes)
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

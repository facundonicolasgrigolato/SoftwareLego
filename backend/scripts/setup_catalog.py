"""Descarga los catálogos offline (Rebrickable + LDraw) y construye `data/catalog.sqlite`."""

from __future__ import annotations

import argparse
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.config import (  # noqa: E402
    LDRAW_COMPLETE_ZIP_URL,
    REBRICKABLE_BASE_URL,
    REBRICKABLE_FILES,
    AppPaths,
)
from app.db.catalog import build_catalog_database  # noqa: E402


def download_file(url: str, dest: Path, force: bool = False) -> None:
    """Descarga un archivo por HTTP con stream a disco (soporta reintento limpio via `.part`)."""
    if dest.exists() and not force:
        print(f"[SKIP] Ya existe: {dest.name}")
        return

    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = dest.with_suffix(dest.suffix + ".part")
    print(f"[DOWN] Descargando {url} -> {dest}")
    req = urllib.request.Request(url, headers={"User-Agent": "SoftwareLego/0.1"})
    with urllib.request.urlopen(req, timeout=120) as resp, tmp_path.open("wb") as out:
        shutil.copyfileobj(resp, out, length=1024 * 256)
    tmp_path.replace(dest)
    size_mb = dest.stat().st_size / (1024 * 1024)
    print(f"[OK]   {dest.name} ({size_mb:.2f} MB)")


def extract_ldraw_zip(zip_path: Path, ldraw_dir: Path, force: bool = False) -> None:
    """Extrae `complete.zip` de LDraw en `data/ldraw` evitando path traversal."""
    has_parts = (ldraw_dir / "parts").is_dir() or (ldraw_dir / "ldraw" / "parts").is_dir()
    if has_parts and not force:
        print(f"[SKIP] Biblioteca LDraw ya extraída en {ldraw_dir}")
        return

    if force and ldraw_dir.exists():
        shutil.rmtree(ldraw_dir)
    ldraw_dir.mkdir(parents=True, exist_ok=True)

    print(f"[UNZIP] Extrayendo {zip_path.name} en {ldraw_dir} ...")
    base_resolved = ldraw_dir.resolve()
    with zipfile.ZipFile(zip_path, "r") as zf:
        for member in zf.infolist():
            target = (ldraw_dir / member.filename).resolve()
            if not str(target).startswith(str(base_resolved)):
                raise RuntimeError(f"Ruta insegura dentro del ZIP: {member.filename}")
        zf.extractall(ldraw_dir)
    print("[OK]   Biblioteca LDraw extraída.")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Prepara el catálogo local offline (Rebrickable CSV + LDraw + SQLite)."
    )
    parser.add_argument(
        "--force-download",
        action="store_true",
        help="Vuelve a descargar Rebrickable CSVs y LDraw complete.zip aunque ya existan.",
    )
    parser.add_argument(
        "--rebuild-only",
        action="store_true",
        help="No descarga ni descomprime; solo reconstruye `catalog.sqlite` desde archivos locales.",
    )
    args = parser.parse_args()

    paths = AppPaths()
    paths.ensure_directories()

    ldraw_zip = paths.data_dir / "complete.zip"
    if not args.rebuild_only:
        for filename in REBRICKABLE_FILES:
            download_file(
                f"{REBRICKABLE_BASE_URL}/{filename}",
                paths.rebrickable_dir / filename,
                force=args.force_download,
            )
        download_file(LDRAW_COMPLETE_ZIP_URL, ldraw_zip, force=args.force_download)
        extract_ldraw_zip(ldraw_zip, paths.ldraw_dir, force=args.force_download)

    print(f"[DB] Construyendo {paths.catalog_db_path} ...")
    counts = build_catalog_database(
        db_path=paths.catalog_db_path,
        rebrickable_dir=paths.rebrickable_dir,
        ldraw_dir=paths.ldraw_dir,
    )
    print("[OK] Catálogo SQLite construido:")
    for table, total in counts.items():
        print(f"     - {table}: {total:,}")


if __name__ == "__main__":
    main()

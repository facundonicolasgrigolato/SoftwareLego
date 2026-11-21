"""Configuración centralizada de rutas y orígenes de datos del backend."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

# Raíz del proyecto: .../SoftwareLego
ROOT_DIR: Path = Path(__file__).resolve().parents[2]
SETS_DIR: Path = ROOT_DIR / "Sets"
DATA_DIR: Path = ROOT_DIR / "data"
REBRICKABLE_DIR: Path = DATA_DIR / "rebrickable"
LDRAW_DIR: Path = DATA_DIR / "ldraw"
OMR_DIR: Path = DATA_DIR / "omr"
CATALOG_DB_PATH: Path = DATA_DIR / "catalog.sqlite"
OVERRIDES_PATH: Path = DATA_DIR / "overrides.json"
API_CACHE_PATH: Path = DATA_DIR / "api_cache.json"
API_CONFIG_PATH: Path = DATA_DIR / "api_config.json"
OUTPUT_DIR: Path = ROOT_DIR / "output"
OUTPUT_SETS_DIR: Path = OUTPUT_DIR / "sets"
OUTPUT_COVERS_DIR: Path = OUTPUT_DIR / "covers"

REBRICKABLE_BASE_URL = "https://cdn.rebrickable.com/media/downloads"
REBRICKABLE_FILES: tuple[str, ...] = (
    "colors.csv.gz",
    "parts.csv.gz",
    "part_relationships.csv.gz",
    "elements.csv.gz",
    "sets.csv.gz",
)
LDRAW_COMPLETE_ZIP_URL = "https://library.ldraw.org/library/updates/complete.zip"

SCHEMA_VERSION = "1.0.0"


@dataclass(frozen=True)
class AppPaths:
    """Agrupa las rutas de trabajo para facilitar testing con directorios temporales."""

    root_dir: Path = ROOT_DIR
    sets_dir: Path = SETS_DIR
    data_dir: Path = DATA_DIR
    rebrickable_dir: Path = REBRICKABLE_DIR
    ldraw_dir: Path = LDRAW_DIR
    omr_dir: Path = OMR_DIR
    catalog_db_path: Path = CATALOG_DB_PATH
    overrides_path: Path = OVERRIDES_PATH
    api_cache_path: Path = API_CACHE_PATH
    api_config_path: Path = API_CONFIG_PATH
    output_sets_dir: Path = OUTPUT_SETS_DIR
    output_covers_dir: Path = OUTPUT_COVERS_DIR

    def resolve_ldraw_parts_root(self) -> Path:
        """Devuelve la carpeta raíz que contiene `parts/` y `p/` de LDraw."""
        nested = self.ldraw_dir / "ldraw"
        if (nested / "parts").is_dir():
            return nested
        return self.ldraw_dir

    def ensure_directories(self) -> None:
        """Crea los directorios necesarios si todavía no existen."""
        for directory in (
            self.sets_dir,
            self.data_dir,
            self.rebrickable_dir,
            self.ldraw_dir,
            self.omr_dir,
            self.output_sets_dir,
            self.output_covers_dir,
        ):
            directory.mkdir(parents=True, exist_ok=True)

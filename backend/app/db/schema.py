"""Esquema SQLite del catálogo offline (Rebrickable + LDraw)."""

from __future__ import annotations

import sqlite3

SCHEMA_SQL = """
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ldraw_colors (
    code INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    rgb TEXT NOT NULL,
    alpha INTEGER NOT NULL DEFAULT 255,
    finish TEXT
);

CREATE TABLE IF NOT EXISTS colors (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    rgb TEXT NOT NULL,
    is_trans INTEGER NOT NULL DEFAULT 0,
    ldraw_code INTEGER
);

CREATE TABLE IF NOT EXISTS parts (
    part_num TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    part_cat_id INTEGER,
    part_material TEXT
);

CREATE TABLE IF NOT EXISTS elements (
    element_id TEXT PRIMARY KEY,
    part_num TEXT NOT NULL,
    color_id INTEGER NOT NULL,
    design_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_elements_part_num ON elements(part_num);
CREATE INDEX IF NOT EXISTS idx_elements_design_id ON elements(design_id);

CREATE TABLE IF NOT EXISTS part_relationships (
    rel_type TEXT NOT NULL,
    child_part_num TEXT NOT NULL,
    parent_part_num TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_part_rel_child ON part_relationships(child_part_num);

CREATE TABLE IF NOT EXISTS sets (
    set_num TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    year INTEGER,
    theme_id INTEGER,
    num_parts INTEGER
);

CREATE TABLE IF NOT EXISTS ldraw_parts (
    ldraw_id TEXT PRIMARY KEY,
    rel_path TEXT NOT NULL,
    title TEXT
);
"""


def reset_database(conn: sqlite3.Connection) -> None:
    """Elimina tablas existentes y recrea el esquema limpio."""
    tables = (
        "metadata",
        "ldraw_colors",
        "colors",
        "parts",
        "elements",
        "part_relationships",
        "sets",
        "ldraw_parts",
    )
    for table in tables:
        conn.execute(f"DROP TABLE IF EXISTS {table}")
    conn.executescript(SCHEMA_SQL)
    conn.commit()

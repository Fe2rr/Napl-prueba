-- NAPL Catalog Database Schema (Separate from Ratings/Votes DB)

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS platforms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS games (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    year TEXT NOT NULL DEFAULT '',
    genre TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    cover_url TEXT NOT NULL DEFAULT '',
    launchbox_url TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    port_id TEXT NOT NULL DEFAULT '',
    game_slug TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT '',
    project TEXT NOT NULL DEFAULT '',
    link TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    developer TEXT NOT NULL DEFAULT '',
    version TEXT NOT NULL DEFAULT '',
    last_update TEXT NOT NULL DEFAULT '',
    date_added TEXT NOT NULL DEFAULT '',
    needs_files TEXT NOT NULL DEFAULT '',
    data_url TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    works TEXT NOT NULL DEFAULT '',
    controller_support TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (game_slug) REFERENCES games(slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ports_game_slug ON ports(game_slug);
CREATE INDEX IF NOT EXISTS idx_ports_port_id ON ports(port_id);
CREATE INDEX IF NOT EXISTS idx_ports_platform ON ports(platform);
CREATE INDEX IF NOT EXISTS idx_ports_project ON ports(project);

-- Official Android devices catalog (from jaredrummler/AndroidDeviceNames)
CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_devices_name ON devices(name);

-- Community compatibility reports (Works Yes/No + validated device_id)
CREATE TABLE IF NOT EXISTS compatibility_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    port_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    device_id TEXT NOT NULL REFERENCES devices(id),
    works INTEGER NOT NULL CHECK (works IN (0, 1)),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(port_id, token_hash, device_id)
);

CREATE INDEX IF NOT EXISTS idx_compat_port_id ON compatibility_reports(port_id);

-- Game popularity & visits (replaces Google Apps Script)
CREATE TABLE IF NOT EXISTS game_visit_totals (
    game_slug TEXT PRIMARY KEY,
    game_name TEXT NOT NULL DEFAULT '',
    visits INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS game_visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_slug TEXT NOT NULL,
    game_name TEXT NOT NULL DEFAULT '',
    visited_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_visits_slug_date ON game_visits(game_slug, visited_at);
CREATE INDEX IF NOT EXISTS idx_visits_date ON game_visits(visited_at);

-- Broken / dead link reports
CREATE TABLE IF NOT EXISTS link_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    port_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    reason TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(port_id, token_hash)
);

CREATE INDEX IF NOT EXISTS idx_link_reports_port_id ON link_reports(port_id);

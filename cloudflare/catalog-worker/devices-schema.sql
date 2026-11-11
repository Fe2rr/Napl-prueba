-- NAPL device database schema
CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_devices_name ON devices(name);

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
CREATE INDEX IF NOT EXISTS idx_compat_device_id ON compatibility_reports(device_id);

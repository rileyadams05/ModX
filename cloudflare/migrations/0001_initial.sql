PRAGMA foreign_keys = ON;

CREATE TABLE games (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  steamgriddb_id INTEGER UNIQUE,
  artwork_url TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_games_normalized_title ON games(normalized_title);

CREATE TABLE game_executables (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  executable_name TEXT NOT NULL,
  normalized_executable TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(game_id, normalized_executable)
);

CREATE INDEX idx_game_executables_lookup
  ON game_executables(normalized_executable);

CREATE TABLE table_releases (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  notes TEXT,
  contributor_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'approved', 'rejected')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_table_releases_game_status
  ON table_releases(game_id, status, created_at DESC);

CREATE TABLE table_release_executables (
  table_release_id TEXT NOT NULL REFERENCES table_releases(id) ON DELETE CASCADE,
  game_executable_id TEXT NOT NULL REFERENCES game_executables(id) ON DELETE CASCADE,
  PRIMARY KEY(table_release_id, game_executable_id)
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  entity_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

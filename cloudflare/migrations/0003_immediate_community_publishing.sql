PRAGMA foreign_keys = OFF;

CREATE TABLE table_releases_v3 (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  notes TEXT,
  contributor_name TEXT,
  status TEXT NOT NULL DEFAULT 'published'
    CHECK(status IN ('published', 'taken_down')),
  github_owner TEXT,
  github_repo TEXT,
  github_branch TEXT,
  github_path TEXT,
  github_blob_sha TEXT,
  download_url TEXT,
  offline_only_confirmed INTEGER NOT NULL DEFAULT 1
    CHECK(offline_only_confirmed IN (0, 1)),
  uploader_abuse_key TEXT,
  scan_status TEXT NOT NULL DEFAULT 'passed'
    CHECK(scan_status IN ('passed', 'rejected')),
  scan_result_json TEXT,
  takedown_reason TEXT,
  taken_down_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO table_releases_v3 (
  id, game_id, version, object_key, original_filename, sha256, file_size,
  notes, contributor_name, status, github_owner, github_repo, github_branch,
  github_path, github_blob_sha, download_url, offline_only_confirmed,
  scan_status, scan_result_json, created_at, updated_at
)
SELECT
  id, game_id, version, object_key, original_filename, sha256, file_size,
  notes, contributor_name,
  CASE WHEN status IN ('pending', 'approved') THEN 'published' ELSE 'taken_down' END,
  github_owner, github_repo, github_branch, github_path, github_blob_sha,
  download_url, 1, 'passed', '{"migration":"legacy-record"}',
  created_at, updated_at
FROM table_releases;

CREATE TABLE table_release_executables_v3 (
  table_release_id TEXT NOT NULL REFERENCES table_releases_v3(id) ON DELETE CASCADE,
  game_executable_id TEXT NOT NULL REFERENCES game_executables(id) ON DELETE CASCADE,
  PRIMARY KEY(table_release_id, game_executable_id)
);

INSERT INTO table_release_executables_v3 (table_release_id, game_executable_id)
SELECT table_release_id, game_executable_id FROM table_release_executables;

DROP TABLE table_release_executables;
DROP TABLE table_releases;
ALTER TABLE table_releases_v3 RENAME TO table_releases;
ALTER TABLE table_release_executables_v3 RENAME TO table_release_executables;

CREATE INDEX idx_table_releases_game_status
  ON table_releases(game_id, status, created_at DESC);
CREATE UNIQUE INDEX idx_table_releases_github_path
  ON table_releases(github_owner, github_repo, github_path);

CREATE TABLE blocked_games (
  game_id TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE table_reports (
  id TEXT PRIMARY KEY,
  table_release_id TEXT NOT NULL REFERENCES table_releases(id) ON DELETE CASCADE,
  reporter_abuse_key TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN (
    'online_or_multiplayer_cheating',
    'malware_or_unsafe_code',
    'stolen_or_misleading',
    'other'
  )),
  details TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'resolved')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  UNIQUE(table_release_id, reporter_abuse_key, reason)
);

CREATE INDEX idx_table_reports_status_created
  ON table_reports(status, created_at DESC);

CREATE TABLE abuse_blocks (
  uploader_abuse_key TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

PRAGMA foreign_keys = ON;

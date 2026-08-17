PRAGMA foreign_keys = ON;

CREATE TABLE table_release_platform_executables (
  table_release_id TEXT NOT NULL REFERENCES table_releases(id) ON DELETE CASCADE,
  platform_id TEXT NOT NULL CHECK(platform_id IN ('windows', 'linux', 'steamos', 'macos')),
  executable_name TEXT NOT NULL,
  normalized_executable TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(table_release_id, platform_id, normalized_executable)
);

CREATE INDEX idx_table_platform_executable_lookup
  ON table_release_platform_executables(platform_id, normalized_executable);

INSERT OR IGNORE INTO table_release_platform_executables (
  table_release_id,
  platform_id,
  executable_name,
  normalized_executable
)
SELECT
  tre.table_release_id,
  'windows',
  ge.executable_name,
  ge.normalized_executable
FROM table_release_executables tre
JOIN game_executables ge ON ge.id = tre.game_executable_id;

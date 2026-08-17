PRAGMA foreign_keys = ON;

ALTER TABLE table_releases ADD COLUMN service_scope TEXT NOT NULL DEFAULT 'single'
  CHECK(service_scope IN ('single', 'multiple'));
ALTER TABLE table_releases ADD COLUMN game_executable_sha256 TEXT;
ALTER TABLE table_releases ADD COLUMN game_executable_file_size INTEGER;

CREATE TABLE table_release_services (
  table_release_id TEXT NOT NULL REFERENCES table_releases(id) ON DELETE CASCADE,
  service_name TEXT NOT NULL,
  normalized_service TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(table_release_id, normalized_service)
);

CREATE INDEX idx_table_release_services_lookup
  ON table_release_services(normalized_service, table_release_id);

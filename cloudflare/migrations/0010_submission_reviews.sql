PRAGMA foreign_keys = ON;

CREATE TABLE game_eligibility (
  game_id TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('eligible', 'online_only', 'server_sided', 'unsuitable', 'review')),
  reason TEXT,
  reviewed_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE submission_reviews (
  id TEXT PRIMARY KEY,
  listing_id TEXT REFERENCES table_releases(id) ON DELETE SET NULL,
  listing_draft_id TEXT NOT NULL,
  review_type TEXT NOT NULL DEFAULT 'initial' CHECK(review_type IN ('initial', 'release_update')),
  uploader_abuse_key TEXT NOT NULL,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  game_executable TEXT NOT NULL,
  game_fingerprint TEXT NOT NULL,
  game_executable_size INTEGER,
  maintenance_mode TEXT NOT NULL CHECK(maintenance_mode IN ('author', 'community')),
  repository_owner TEXT NOT NULL,
  repository_name TEXT NOT NULL,
  repository_url TEXT NOT NULL,
  release_url TEXT NOT NULL,
  release_id TEXT NOT NULL,
  release_tag TEXT NOT NULL,
  release_commit_sha TEXT NOT NULL,
  release_published_at TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  asset_name TEXT NOT NULL,
  asset_url TEXT NOT NULL,
  asset_size INTEGER NOT NULL,
  asset_sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'processing', 'completed')),
  stage TEXT NOT NULL DEFAULT 'queued',
  decision TEXT CHECK(decision IN ('pass', 'review', 'reject')),
  confidence REAL,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  flags_json TEXT NOT NULL DEFAULT '[]',
  checks_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  completed_at TEXT,
  consumed_at TEXT
);

CREATE INDEX idx_submission_reviews_uploader
  ON submission_reviews(uploader_abuse_key, created_at DESC);

CREATE INDEX idx_submission_reviews_release
  ON submission_reviews(repository_owner, repository_name, release_id, asset_id, game_fingerprint);

CREATE INDEX idx_submission_reviews_updates
  ON submission_reviews(listing_id, release_id, asset_id, created_at DESC);

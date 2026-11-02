-- Cloudflare D1 schema for DBD Tracker Community (Optimized for Low Read/Write Quota)
-- Execute with: npx wrangler d1 execute dbd-tracker-community --file=schema.sql

CREATE TABLE IF NOT EXISTS community_accounts (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  email TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
DROP INDEX IF EXISTS idx_accounts_token_hash;
CREATE INDEX IF NOT EXISTS idx_accounts_email_lower ON community_accounts(LOWER(email));

CREATE TABLE IF NOT EXISTS community_submissions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES community_accounts(id) ON DELETE CASCADE,
  payload_hash TEXT NOT NULL,
  match_count INTEGER NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'accepted',
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_id, payload_hash)
);
DROP INDEX IF EXISTS idx_submissions_owner_hash;

CREATE TABLE IF NOT EXISTS community_matches (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES community_accounts(id) ON DELETE CASCADE,
  official_match_id TEXT,
  match_hash TEXT NOT NULL,
  played_at TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('survivor', 'killer')),
  character_id TEXT,
  map_id TEXT,
  killer_id TEXT,
  result TEXT,
  kills_count INTEGER CHECK (kills_count IS NULL OR (kills_count BETWEEN 0 AND 4)),
  duration_sec INTEGER CHECK (duration_sec IS NULL OR (duration_sec BETWEEN 0 AND 86400)),
  score INTEGER CHECK (score IS NULL OR (score BETWEEN 0 AND 1000000)),
  patch_version TEXT,
  platform TEXT,
  region TEXT,
  source TEXT NOT NULL DEFAULT 'official_stats',
  loadout_json TEXT NOT NULL DEFAULT '{}',
  participants_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_id, match_hash)
);
DROP INDEX IF EXISTS idx_comm_matches_played;
DROP INDEX IF EXISTS idx_comm_matches_query;
CREATE INDEX IF NOT EXISTS idx_comm_matches_owner_played ON community_matches(owner_id, played_at DESC);

-- Legacy tables kept for backward compatibility with older records
CREATE TABLE IF NOT EXISTS community_match_loadouts (
  match_id TEXT PRIMARY KEY REFERENCES community_matches(id) ON DELETE CASCADE,
  perks_json TEXT NOT NULL DEFAULT '[]',
  item_id TEXT,
  addons_json TEXT NOT NULL DEFAULT '[]',
  offering_id TEXT,
  killer_perks_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS community_match_participants (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES community_matches(id) ON DELETE CASCADE,
  character_id TEXT,
  role TEXT CHECK (role IN ('survivor', 'killer')),
  result TEXT,
  perks_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE (match_id, character_id, role)
);

-- Key-Value metadata & pre-serialized snapshots (1-row reads for stats and user summaries)
CREATE TABLE IF NOT EXISTS community_meta (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Consolidated public statistics tables (Updated incrementally on ingest)
CREATE TABLE IF NOT EXISTS public_character_stats (
  patch_version TEXT NOT NULL,
  role TEXT NOT NULL,
  character_id TEXT NOT NULL,
  match_count INTEGER NOT NULL,
  escapes INTEGER NOT NULL,
  kills INTEGER NOT NULL,
  average_score INTEGER,
  PRIMARY KEY (patch_version, role, character_id)
);

CREATE TABLE IF NOT EXISTS public_map_stats (
  patch_version TEXT NOT NULL,
  role TEXT NOT NULL,
  map_id TEXT NOT NULL,
  match_count INTEGER NOT NULL,
  escapes INTEGER NOT NULL,
  kills INTEGER NOT NULL,
  PRIMARY KEY (patch_version, role, map_id)
);

CREATE TABLE IF NOT EXISTS public_killer_stats (
  patch_version TEXT NOT NULL,
  killer_id TEXT NOT NULL,
  match_count INTEGER NOT NULL,
  kills INTEGER NOT NULL,
  average_kills REAL,
  PRIMARY KEY (patch_version, killer_id)
);

CREATE TABLE IF NOT EXISTS public_perk_stats (
  patch_version TEXT NOT NULL,
  role TEXT NOT NULL,
  perk_id TEXT NOT NULL,
  usage_count INTEGER NOT NULL,
  PRIMARY KEY (patch_version, role, perk_id)
);

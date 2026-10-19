// SQLite catalog schema. Times are ISO 8601 UTC strings; *_json columns hold JSON text.
export const SCHEMA_VERSION = 3;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- A host computer or a guest (VM, sandbox, container runtime) reached through a host.
CREATE TABLE IF NOT EXISTS machines (
  id          TEXT PRIMARY KEY,                 -- hub, laptop, server, mini, server/colima, ...
  name        TEXT NOT NULL,
  os          TEXT NOT NULL,                    -- windows | macos | linux
  kind        TEXT NOT NULL CHECK (kind IN ('host','guest')),
  parent_id   TEXT REFERENCES machines(id),     -- host of a guest
  guest_type  TEXT,                             -- colima | wsl | sbx | docker
  address     TEXT,
  state       TEXT NOT NULL DEFAULT 'unknown',  -- reachable | unreachable | stopped | unknown | paused
  last_seen   TEXT,
  last_scan   TEXT
);

-- One place packages come from on one machine (a Homebrew prefix, the app folders, winget, ...).
CREATE TABLE IF NOT EXISTS sources (
  id          INTEGER PRIMARY KEY,
  machine_id  TEXT NOT NULL REFERENCES machines(id),
  kind        TEXT NOT NULL,                    -- brew | cask | mas | app | pkgutil | launchd | npm | uv | winget | registry | ...
  location    TEXT NOT NULL DEFAULT '',         -- prefix or root the source covers
  enabled     INTEGER NOT NULL DEFAULT 1,
  UNIQUE (machine_id, kind, location)
);

-- What one ecosystem calls a thing. Never merged on its own.
CREATE TABLE IF NOT EXISTS packages (
  id          INTEGER PRIMARY KEY,
  ecosystem   TEXT NOT NULL,                    -- brew | cask | winget | bundle | pkgutil | npm | pypi | image | ...
  key         TEXT NOT NULL,                    -- formula name, bundle id, winget id, image repo, ...
  name        TEXT NOT NULL,
  publisher   TEXT,
  homepage    TEXT,
  category    TEXT,
  category_source TEXT,                         -- source | generated | manual
  description TEXT,
  description_source TEXT,                      -- source | generated | manual (a manual text is never overwritten)
  description_confidence REAL,
  description_at TEXT,
  UNIQUE (ecosystem, key)
);

-- The same software across packages. Groups form only from deterministic mappings or a confirmed merge.
CREATE TABLE IF NOT EXISTS items (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  manual      INTEGER NOT NULL DEFAULT 0,       -- no canonical version source
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS item_links (
  package_id  INTEGER PRIMARY KEY REFERENCES packages(id),
  item_id     INTEGER NOT NULL REFERENCES items(id),
  basis       TEXT NOT NULL CHECK (basis IN ('deterministic','confirmed')),
  evidence_json TEXT NOT NULL DEFAULT '{}'
);

-- One package, on one machine, at one location, owned by one source.
CREATE TABLE IF NOT EXISTS installs (
  id          INTEGER PRIMARY KEY,
  machine_id  TEXT NOT NULL REFERENCES machines(id),
  source_id   INTEGER NOT NULL REFERENCES sources(id),
  package_id  INTEGER NOT NULL REFERENCES packages(id),
  location    TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL,                    -- package | app | binary | service | image | runtime | vm
  version     TEXT,                             -- as reported; null when the source gives none
  digest      TEXT,                             -- images
  details_json TEXT NOT NULL DEFAULT '{}',
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  removed_at  TEXT,
  UNIQUE (machine_id, source_id, package_id, location)
);
CREATE INDEX IF NOT EXISTS installs_machine ON installs(machine_id, removed_at);

-- Every version answer, kept with where it came from.
CREATE TABLE IF NOT EXISTS assertions (
  id          INTEGER PRIMARY KEY,
  package_id  INTEGER NOT NULL REFERENCES packages(id),
  source      TEXT NOT NULL,                    -- brew-api | winget | npm | pypi | github | sparkle | vendor | registry | ...
  channel     TEXT NOT NULL CHECK (channel IN ('stable','beta','unknown')),
  version     TEXT NOT NULL,
  installable INTEGER NOT NULL DEFAULT 0,       -- the owning adapter can install this version
  advisory    INTEGER NOT NULL DEFAULT 0,       -- vendor-page answers never enable a button
  observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS assertions_pkg ON assertions(package_id, observed_at);

CREATE TABLE IF NOT EXISTS priority_flags (
  package_id  INTEGER NOT NULL REFERENCES packages(id),
  version     TEXT NOT NULL,
  flags_json  TEXT NOT NULL,
  source      TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (package_id, version, source)
);

CREATE TABLE IF NOT EXISTS constraints (
  id          INTEGER PRIMARY KEY,
  install_id  INTEGER REFERENCES installs(id),
  package_id  INTEGER REFERENCES packages(id),
  type        TEXT NOT NULL CHECK (type IN ('freeze','gated_range','project_selector','compat_range','advisory')),
  hard        INTEGER NOT NULL DEFAULT 0,
  spec        TEXT NOT NULL,                    -- version, range or selector text
  origin      TEXT NOT NULL,                    -- file or command that states it
  detail_json TEXT NOT NULL DEFAULT '{}',
  observed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY,
  batch_id    TEXT NOT NULL,
  machine_id  TEXT NOT NULL REFERENCES machines(id),
  install_id  INTEGER REFERENCES installs(id),
  action      TEXT NOT NULL,
  target      TEXT,
  channel     TEXT,
  state       TEXT NOT NULL DEFAULT 'queued',   -- queued | preflight | running | done | failed | stopped
  requested_at TEXT NOT NULL,
  started_at  TEXT,
  from_version TEXT,
  message     TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS job_steps (
  id          INTEGER PRIMARY KEY,
  job_id      INTEGER NOT NULL REFERENCES jobs(id),
  seq         INTEGER NOT NULL,
  name        TEXT NOT NULL,
  state       TEXT NOT NULL,
  output      TEXT,
  at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS findings (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,                    -- duplicate | standardization | merge_proposal | new_install | ...
  subject_json TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'open',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS briefs (
  id          INTEGER PRIMARY KEY,
  path        TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'waiting',
  created_at  TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY,
  at          TEXT NOT NULL,
  machine_id  TEXT,
  kind        TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  machine_id TEXT,
  machine_name TEXT,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  target_type TEXT,
  target_id INTEGER,
  state TEXT NOT NULL CHECK (state IN ('open','acknowledged','resolved')),
  acknowledged_at TEXT,
  resolved_at TEXT,
  muted INTEGER NOT NULL DEFAULT 0,
  condition_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS alerts_active_key ON alerts(key) WHERE state <> 'resolved';
CREATE INDEX IF NOT EXISTS alerts_counts ON alerts(muted, state, severity, at);

CREATE TABLE IF NOT EXISTS alert_mutes (
  key TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS health_targets (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('domain','listener')),
  label TEXT NOT NULL,
  machine_id TEXT,
  port INTEGER,
  url TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'unknown' CHECK (state IN ('up','slow','down','failing','not-http','unknown')),
  failures INTEGER NOT NULL DEFAULT 0,
  last_ok_at TEXT,
  last_probe_at TEXT,
  last_status INTEGER,
  last_latency_ms INTEGER,
  last_error TEXT,
  tls_not_after TEXT,
  gone_at TEXT
);

CREATE TABLE IF NOT EXISTS health_samples (
  id INTEGER PRIMARY KEY,
  target_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('domain','listener')),
  at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  status INTEGER,
  latency_ms INTEGER,
  error TEXT,
  tls_not_after TEXT
);
CREATE INDEX IF NOT EXISTS health_samples_target ON health_samples(target_key, at, id);

CREATE TABLE IF NOT EXISTS meter_samples (
  id INTEGER PRIMARY KEY,
  machine_id TEXT NOT NULL,
  at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS meter_samples_machine ON meter_samples(machine_id, at, id);

CREATE TABLE IF NOT EXISTS outages (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('machine','url','service','flapping','monitor-gap')),
  machine_id TEXT,
  label TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  ended_at TEXT,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS outages_open ON outages(key) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS outages_history ON outages(started_at, id);

CREATE TABLE IF NOT EXISTS watch_state (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  machine_id TEXT,
  label TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  first_failed_at TEXT,
  last_state TEXT NOT NULL DEFAULT 'up',
  last_checked_at TEXT,
  last_ok_at TEXT,
  episodes_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS alert_baseline (
  machine_id TEXT PRIMARY KEY REFERENCES machines(id),
  event_id INTEGER NOT NULL,
  at TEXT NOT NULL
);

-- What each source produced or failed on, per scan. Absence from the catalog never means "not installed".
CREATE TABLE IF NOT EXISTS coverage (
  id          INTEGER PRIMARY KEY,
  machine_id  TEXT NOT NULL REFERENCES machines(id),
  source_kind TEXT NOT NULL,
  location    TEXT NOT NULL DEFAULT '',
  ran_at      TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('ok','partial','failed','skipped')),
  found       INTEGER NOT NULL DEFAULT 0,
  message     TEXT
);

-- Model decision calls: minimized input, output, and what the owner actually did.
CREATE TABLE IF NOT EXISTS decisions (
  id          INTEGER PRIMARY KEY,
  question    TEXT NOT NULL,
  input_json  TEXT NOT NULL,
  output_json TEXT NOT NULL,
  outcome_json TEXT,
  at          TEXT NOT NULL
);

-- How one install relates to another on the same machine, from a rule that can be checked (a path, an id).
CREATE TABLE IF NOT EXISTS install_relations (
  install_id  INTEGER NOT NULL REFERENCES installs(id),
  related_id  INTEGER NOT NULL REFERENCES installs(id),
  relation    TEXT NOT NULL,                    -- part_of | runs | links_to
  rule        TEXT NOT NULL,
  PRIMARY KEY (install_id, related_id, relation)
);

CREATE TABLE IF NOT EXISTS dependency_edges (
  id              INTEGER PRIMARY KEY,
  machine_id      TEXT NOT NULL REFERENCES machines(id),
  from_install_id INTEGER NOT NULL REFERENCES installs(id),
  to_install_id   INTEGER REFERENCES installs(id),
  to_ecosystem    TEXT NOT NULL,
  to_key          TEXT NOT NULL,
  to_name         TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('library','runtime')),
  "constraint"    TEXT,
  built_against   TEXT,
  source          TEXT NOT NULL,                  -- brew-deps | npm-engines | pyvenv | ai-reviewed
  evidence        TEXT NOT NULL,
  observed_at     TEXT NOT NULL,
  UNIQUE (from_install_id, to_ecosystem, to_key, kind, source)
);
CREATE INDEX IF NOT EXISTS dependency_target ON dependency_edges(to_install_id);
CREATE INDEX IF NOT EXISTS dependency_identity ON dependency_edges(machine_id, to_ecosystem, to_key);

CREATE TABLE IF NOT EXISTS listeners (
  id              INTEGER PRIMARY KEY,
  machine_id      TEXT NOT NULL REFERENCES machines(id),
  port            INTEGER NOT NULL,
  protocol        TEXT NOT NULL CHECK (protocol = 'tcp'),
  address         TEXT NOT NULL,
  bind            TEXT NOT NULL CHECK (bind IN ('loopback','all','lan')),
  pid             INTEGER,
  process_name    TEXT,
  process_path    TEXT,
  script_path     TEXT,
  ppid            INTEGER,
  owner           TEXT,
  container_name  TEXT,
  container_image TEXT,
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  gone_at         TEXT,
  expected_down   INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS listener_identity ON listeners(machine_id, port, protocol, COALESCE(container_name, ''), COALESCE(process_name, ''));

CREATE TABLE IF NOT EXISTS descriptions (
  subject       TEXT NOT NULL,
  text          TEXT NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('hand','project','public')),
  generated     INTEGER NOT NULL CHECK (generated IN (0, 1)),
  confidence    REAL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  model_label   TEXT,
  input_hash    TEXT,
  at            TEXT NOT NULL,
  PRIMARY KEY (subject, source)
);

-- Live service rows. program is an executable path with the arguments removed.
CREATE TABLE IF NOT EXISTS services (
  id            INTEGER PRIMARY KEY,
  machine_id    TEXT NOT NULL REFERENCES machines(id),
  kind          TEXT NOT NULL CHECK (kind IN ('windows-service','scheduled-task','launchd','systemd')),
  domain        TEXT NOT NULL CHECK (domain IN ('system','gui')),
  name          TEXT NOT NULL,
  display_name  TEXT,
  program       TEXT,
  state         TEXT NOT NULL CHECK (state IN ('running','stopped','disabled','other')),
  start_mode    TEXT CHECK (start_mode IN ('auto','manual','disabled','boot')),
  enabled       INTEGER CHECK (enabled IN (0, 1)),
  pid           INTEGER,
  run_as        TEXT,
  uid           INTEGER,
  keep_alive    INTEGER,
  plist         TEXT,
  triggers      TEXT,
  last_run      TEXT,
  last_result   TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  gone_at       TEXT,
  expected_down INTEGER NOT NULL DEFAULT 0,
  UNIQUE (machine_id, kind, domain, name)
);

CREATE TABLE IF NOT EXISTS launch_recipes (
  id INTEGER PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(id),
  root TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('package-json','launch-json','compose')),
  name TEXT NOT NULL,
  argv_json TEXT NOT NULL,
  port INTEGER,
  hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('proposed','approved','rejected','unsupported')),
  reason TEXT,
  detail TEXT,
  proposed_at TEXT NOT NULL,
  decided_at TEXT,
  last_seen_at TEXT NOT NULL,
  gone_at TEXT,
  UNIQUE (machine_id, root, source, name)
);

CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  finished_at TEXT,
  machine_id TEXT NOT NULL REFERENCES machines(id),
  target TEXT NOT NULL CHECK (target IN ('service','listener','recipe','stack')),
  row_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('start','stop','restart','disable','enable')),
  hard INTEGER NOT NULL CHECK (hard IN (0,1)),
  mechanism TEXT NOT NULL,
  command TEXT NOT NULL,
  admin TEXT NOT NULL CHECK (admin IN ('none','uac','sudo')),
  state TEXT NOT NULL CHECK (state IN ('running','done','failed','waiting','confirmed','expired','declined')),
  exit_code INTEGER,
  message TEXT,
  plan_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS actions_machine ON actions(machine_id, id);

-- Full-text index over what a person searches for. Kept in step with the packages table by triggers.
CREATE VIRTUAL TABLE IF NOT EXISTS packages_fts USING fts5(
  name, key, description, publisher, content = 'packages', content_rowid = 'id'
);
CREATE TRIGGER IF NOT EXISTS packages_ai AFTER INSERT ON packages BEGIN
  INSERT INTO packages_fts(rowid, name, key, description, publisher) VALUES (new.id, new.name, new.key, new.description, new.publisher);
END;
CREATE TRIGGER IF NOT EXISTS packages_ad AFTER DELETE ON packages BEGIN
  INSERT INTO packages_fts(packages_fts, rowid, name, key, description, publisher) VALUES ('delete', old.id, old.name, old.key, old.description, old.publisher);
END;
CREATE TRIGGER IF NOT EXISTS packages_au AFTER UPDATE ON packages BEGIN
  INSERT INTO packages_fts(packages_fts, rowid, name, key, description, publisher) VALUES ('delete', old.id, old.name, old.key, old.description, old.publisher);
  INSERT INTO packages_fts(rowid, name, key, description, publisher) VALUES (new.id, new.name, new.key, new.description, new.publisher);
END;

-- Dated usage observations with their origin. An unreadable signal is recorded with available = 0, never inferred.
CREATE TABLE IF NOT EXISTS usage_signals (
  id          INTEGER PRIMARY KEY,
  install_id  INTEGER NOT NULL REFERENCES installs(id),
  kind        TEXT NOT NULL,                    -- last_used | use_count | running | autostart | referenced | ai_use_7d | ai_use_30d | ai_last_used | dependent
  value       TEXT,                             -- ISO time for last_used, a number, or 0/1
  available   INTEGER NOT NULL DEFAULT 1,
  origin      TEXT NOT NULL,                    -- spotlight | userassist | bam | ps | launchd | services | repos | miner | deps
  observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_install ON usage_signals(install_id, kind, observed_at);

CREATE TABLE IF NOT EXISTS ai_use_checkpoints (
  machine_id TEXT NOT NULL REFERENCES machines(id),
  agent      TEXT NOT NULL,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (machine_id, agent)
);

CREATE TABLE IF NOT EXISTS saved_filters (
  name        TEXT PRIMARY KEY,
  spec_json   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS changelog_summaries (
  package_id  INTEGER NOT NULL REFERENCES packages(id),
  version     TEXT NOT NULL,
  summary     TEXT NOT NULL,
  source_url  TEXT NOT NULL,
  model       TEXT NOT NULL,
  flags_json  TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (package_id, version)
);

-- When each source was last asked about each package, and how it went, so a lookup is cached per package and a
-- package a source does not know is not asked again until the cache lapses.
CREATE TABLE IF NOT EXISTS research_log (
  package_id  INTEGER NOT NULL REFERENCES packages(id),
  source      TEXT NOT NULL,
  checked_at  TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('ok','notfound','failed')),
  message     TEXT,
  PRIMARY KEY (package_id, source)
);

CREATE TABLE IF NOT EXISTS support_windows (
  package_id  INTEGER NOT NULL REFERENCES packages(id),
  cycle       TEXT NOT NULL,
  eol         TEXT,
  eol_passed  INTEGER NOT NULL CHECK (eol_passed IN (0,1)),
  latest      TEXT,
  lts         INTEGER NOT NULL CHECK (lts IN (0,1)),
  observed_at TEXT NOT NULL,
  PRIMARY KEY (package_id, cycle)
);

-- Off everywhere in v1.
CREATE TABLE IF NOT EXISTS auto_apply (
  machine_id  TEXT NOT NULL,
  item_id     INTEGER,
  class       TEXT,
  enabled     INTEGER NOT NULL DEFAULT 0
);

-- Cloudflare catalog. Rows are replaced on a successful read. The token, account id and API bodies are not stored.
CREATE TABLE IF NOT EXISTS cf_zones (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cf_dns (
  id      INTEGER PRIMARY KEY,
  zone    TEXT NOT NULL,
  name    TEXT NOT NULL,
  type    TEXT NOT NULL CHECK (type IN ('A','AAAA','CNAME')),
  content TEXT NOT NULL,
  proxied INTEGER NOT NULL CHECK (proxied IN (0, 1))
);

CREATE TABLE IF NOT EXISTS cf_tunnels (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('healthy','degraded','down','inactive')),
  connections    INTEGER NOT NULL,
  remote_managed INTEGER NOT NULL CHECK (remote_managed IN (0, 1))
);

CREATE TABLE IF NOT EXISTS cf_ingress (
  id        INTEGER PRIMARY KEY,
  tunnel_id TEXT NOT NULL,
  position  INTEGER NOT NULL,
  hostname  TEXT,
  path      TEXT,
  service   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cf_access_apps (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  domain   TEXT NOT NULL,
  policies INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cf_worker_routes (
  id      INTEGER PRIMARY KEY,
  zone    TEXT NOT NULL,
  pattern TEXT NOT NULL,
  script  TEXT
);

-- Git facts of the projects found under projectRoots. The remote is stored as host, owner and repository only, never as the raw URL.
CREATE TABLE IF NOT EXISTS project_git (
  machine_id     TEXT NOT NULL REFERENCES machines(id),
  root           TEXT NOT NULL,
  remote_url     TEXT,
  remote_host    TEXT,
  remote_owner   TEXT,
  remote_repo    TEXT,
  author_email   TEXT,
  last_commit_at TEXT,
  read_at        TEXT NOT NULL,
  PRIMARY KEY (machine_id, root)
);

CREATE TABLE IF NOT EXISTS cf_reader (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  state        TEXT NOT NULL CHECK (state IN ('never','fresh','stale','failed','off')),
  last_read_at TEXT,
  error        TEXT
);
`;

/** Columns added to `packages` in version 2, applied to a version 1 catalog. */
export const V2_PACKAGE_COLUMNS = [
  "publisher TEXT",
  "homepage TEXT",
  "category TEXT",
  "category_source TEXT",
  "description TEXT",
  "description_source TEXT",
  "description_confidence REAL",
  "description_at TEXT",
];

export const JOB_COLUMNS = ["batch_id TEXT NOT NULL DEFAULT ''", "started_at TEXT", "from_version TEXT", "message TEXT"];
export const SERVICE_COLUMNS = ["uid INTEGER", "keep_alive INTEGER", "plist TEXT", "expected_down INTEGER NOT NULL DEFAULT 0"];

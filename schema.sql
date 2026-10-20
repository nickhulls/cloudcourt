CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  provider TEXT NOT NULL,
  change_text TEXT NOT NULL,
  verdict TEXT NOT NULL,
  risk_score INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload TEXT NOT NULL,
  previous_hash TEXT NOT NULL,
  event_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (case_id) REFERENCES cases(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_case_seq ON events(case_id, seq);
CREATE INDEX IF NOT EXISTS idx_cases_created_at ON cases(created_at DESC);

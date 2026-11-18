export const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  original_name TEXT NOT NULL,
  stored_path TEXT,
  sha256 TEXT,
  raw_text TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  note_date TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  raw_markdown TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'validated',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_notes_date ON notes(note_date);
CREATE INDEX IF NOT EXISTS ix_notes_created ON notes(created_at);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'word',
  headword TEXT NOT NULL,
  headword_norm TEXT NOT NULL,
  pos TEXT,
  phonetic TEXT,
  meanings TEXT NOT NULL DEFAULT '[]',
  collocations TEXT NOT NULL DEFAULT '[]',
  examples TEXT NOT NULL DEFAULT '[]',
  extra TEXT,
  accepted_zh TEXT NOT NULL DEFAULT '[]',
  learned_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_items_headword ON items(headword_norm);

CREATE TABLE IF NOT EXISTS note_items (
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  raw_line TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (note_id, item_id)
);
CREATE INDEX IF NOT EXISTS ix_note_items_item ON note_items(item_id);

CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,
  due_at TEXT NOT NULL,
  stability REAL,
  difficulty REAL,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  state INTEGER NOT NULL DEFAULT 0,
  last_review TEXT,
  suspended INTEGER NOT NULL DEFAULT 0,
  needs_check INTEGER NOT NULL DEFAULT 0,
  learn_mark INTEGER NOT NULL DEFAULT 0,
  buried_until TEXT,
  fsrs_json TEXT NOT NULL,
  UNIQUE(item_id, direction)
);
CREATE INDEX IF NOT EXISTS ix_cards_due ON cards(due_at);
CREATE INDEX IF NOT EXISTS ix_cards_item ON cards(item_id);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  reviewed_at TEXT NOT NULL,
  rating INTEGER NOT NULL,
  answer TEXT,
  correct INTEGER,
  elapsed_ms INTEGER,
  mode TEXT NOT NULL DEFAULT 'longterm',
  judge_by TEXT,
  exam_id INTEGER
);
CREATE INDEX IF NOT EXISTS ix_reviews_card ON reviews(card_id, reviewed_at);
CREATE INDEX IF NOT EXISTS ix_reviews_time ON reviews(reviewed_at);

CREATE TABLE IF NOT EXISTS exams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  exam_date TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '{}',
  level TEXT NOT NULL DEFAULT 'dictate',
  target_retention REAL NOT NULL DEFAULT 0.95,
  daily_minutes INTEGER NOT NULL DEFAULT 20,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pronunciations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word_norm TEXT NOT NULL,
  accent TEXT NOT NULL,
  source TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  bytes INTEGER,
  fetched_at TEXT NOT NULL,
  UNIQUE(word_norm, accent, source)
);

CREATE TABLE IF NOT EXISTS ai_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  model TEXT,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(kind, cache_key)
);

CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT,
  model TEXT,
  prompt_tokens INTEGER DEFAULT 0,
  cached_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS validation_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id INTEGER REFERENCES notes(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
  field TEXT,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  suggestion TEXT,
  resolved INTEGER NOT NULL DEFAULT 0
);

-- 未入库草稿：识别完成即落盘，直到入库或用户主动取消才删除
CREATE TABLE IF NOT EXISTS import_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sha256 TEXT,
  file_name TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  original_path TEXT,
  stored_path TEXT,
  payload TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft',
  edited INTEGER NOT NULL DEFAULT 0,
  note_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_import_drafts_status ON import_drafts(status, updated_at);
CREATE INDEX IF NOT EXISTS ix_import_drafts_sha ON import_drafts(sha256);
`

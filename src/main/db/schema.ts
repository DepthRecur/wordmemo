/** 当前数据库结构版本；迁移函数据此判断是否需要先备份（PRAGMA user_version） */
export const SCHEMA_VERSION = 3

/**
 * 「多个库」是从这个版本开始的结构版本。
 * 低于它的库才算老库（需要建默认库并把笔记收进去）；之后**允许一个库都没有**，
 * 所以启动时不能再补默认库，否则用户删空的库会自己长回来。
 */
export const DECKS_SCHEMA_VERSION = 2

export const SCHEMA = `
-- 笔记库（PLAN-DECKS）：库 = 笔记容器 + 学习范围，卡片与进度仍然全局一份
CREATE TABLE IF NOT EXISTS decks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT,
  name TEXT NOT NULL,
  color TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  -- NULL = 用全局 settings.newPerDay
  new_per_day INTEGER,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_decks_name ON decks(name COLLATE NOCASE);

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
  -- 同步用的稳定 id（PLAN-SYNC §3.2）。唯一索引由 migrateUids 建：老库还没补上
  -- 这一列时，SCHEMA 里的 CREATE UNIQUE INDEX 会直接报错（和 ix_notes_deck 同一个坑）
  uid TEXT,
  source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  -- 不写 REFERENCES：老库只能用 ALTER ADD COLUMN 带 DEFAULT 补列，
  -- 而 SQLite 不允许「REFERENCES + 非 NULL DEFAULT」，为了新老库结构一致就不加外键
  deck_id INTEGER NOT NULL DEFAULT 1,
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
-- ix_notes_deck 由 migrateDecks 建：老库还没有 deck_id 列时不能在这里建（会直接报错）

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT,
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
  uid TEXT,
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
  uid TEXT,
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
  provider TEXT NOT NULL DEFAULT 'deepseek',
  kind TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  model TEXT,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(provider, kind, cache_key)
);

CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL DEFAULT 'deepseek',
  at TEXT NOT NULL,
  kind TEXT,
  model TEXT,
  prompt_tokens INTEGER DEFAULT 0,
  cached_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  -- provider / catalog / snapshot / none（none = 这个模型没有价格，只统计 token）
  cost_source TEXT,
  priced_at TEXT
);

-- 运行时模型目录（P2）：每行一个模型，fetched_at 取该 provider 的最新时间
CREATE TABLE IF NOT EXISTS ai_catalog (
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (provider, model_id)
);

-- 运行时价格（P2）：每行一家，payload 是 { models: { id: {input,output,cacheRead?} } }
CREATE TABLE IF NOT EXISTS ai_pricing (
  provider TEXT NOT NULL PRIMARY KEY,
  payload TEXT NOT NULL,
  fetched_at TEXT NOT NULL
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
  -- 这份草稿入库时进的库；NULL = 老草稿，入库时进当前库
  deck_id INTEGER,
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

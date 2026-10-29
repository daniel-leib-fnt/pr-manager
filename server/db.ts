import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { config } from './config.ts';

export type Role = 'own' | 'review';
export type PrState = 'open' | 'merged' | 'closed' | 'dropped';
export type ReviewState = 'none' | 'draft' | 'submitted';

export interface Pr {
  id: number;
  url: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  role: Role;
  head_ref: string;
  head_sha: string;
  base_ref: string;
  is_cross_repo: number;
  is_draft: number;
  state: PrState;
  gh_updated_at: string;
  check_state: string | null;
  summary: string | null;
  worktree: string | null;
  session_id: string | null;
  paused: number;
  blocked: string | null;
  agent_running: number;
  dirty_by_agent: number;
  interrupted: number;
  batch_head_sha: string | null;
  last_event_at: string | null;
  ci_attempts: number;
  in_review_search: number;
  review_state: ReviewState;
  review_verdict: string | null;
  review_body: string | null;
  review_draft_sha: string | null;
  reviewed_sha: string | null;
  reviewed_at: string | null;
  review_out_of_date: number;
  ignored: number;
  created_at: string;
}

export type CommentKind = 'thread' | 'issue_comment' | 'review_body' | 'ci' | 'instruction';
// new: not triaged yet; fixed: changed locally, waiting for push; proposal: waiting for me;
// accepted: I accepted, agent has to implement; skipped: I skipped, reply pending;
// done: finished; gone: deleted on GitHub.
export type CommentState = 'new' | 'fixed' | 'proposal' | 'accepted' | 'skipped' | 'done' | 'gone';

export interface Comment {
  id: number;
  pr_id: number;
  kind: CommentKind;
  gh_key: string;
  thread_id: string | null;
  reply_to_db_id: number | null;
  last_seen_gh_id: string | null;
  author: string | null;
  body: string;
  path: string | null;
  line: number | null;
  url: string | null;
  state: CommentState;
  proposal: string | null;
  reply_draft: string | null;
  reply_edited: number;
  skip_reason: string | null;
  auto: number;
  note: string | null;
  /** Text of the checklist line this item stands for; null for a whole comment. */
  task: string | null;
  /** JSON TaskSource of the comment holding the checklist line. */
  task_source: string | null;
  /** 1 when the reply asks the reviewer to clarify: no box is checked and the thread stays unresolved. */
  clarify: number;
  created_at: string;
  updated_at: string;
}

export interface Question {
  id: number;
  pr_id: number;
  comment_id: number | null;
  question: string;
  options: string | null;
  answer: string | null;
  state: 'open' | 'answered' | 'sent';
  created_at: string;
}

export interface Finding {
  id: number;
  pr_id: number;
  kind: 'finding' | 'thread_reply';
  path: string | null;
  line: number | null;
  thread_id: string | null;
  reply_to_db_id: number | null;
  in_diff: number;
  body: string;
  state: 'draft' | 'skipped' | 'submitted';
  created_at: string;
}

export type WorkKind =
  | 'summarize'
  | 'comments'
  | 'answers'
  | 'review'
  | 'followup_review'
  | 'rebase'
  | 'close_batch';

export interface WorkItem {
  id: number;
  pr_id: number;
  kind: WorkKind;
  payload: string | null;
  state: 'queued' | 'in_progress' | 'done' | 'failed';
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const schema = `
CREATE TABLE IF NOT EXISTS prs (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  role TEXT NOT NULL,
  head_ref TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  is_cross_repo INTEGER NOT NULL DEFAULT 0,
  is_draft INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'open',
  gh_updated_at TEXT NOT NULL DEFAULT '',
  check_state TEXT,
  summary TEXT,
  worktree TEXT,
  session_id TEXT,
  paused INTEGER NOT NULL DEFAULT 0,
  blocked TEXT,
  agent_running INTEGER NOT NULL DEFAULT 0,
  dirty_by_agent INTEGER NOT NULL DEFAULT 0,
  interrupted INTEGER NOT NULL DEFAULT 0,
  batch_head_sha TEXT,
  last_event_at TEXT,
  ci_attempts INTEGER NOT NULL DEFAULT 0,
  in_review_search INTEGER NOT NULL DEFAULT 0,
  review_state TEXT NOT NULL DEFAULT 'none',
  review_verdict TEXT,
  review_body TEXT,
  review_draft_sha TEXT,
  reviewed_sha TEXT,
  reviewed_at TEXT,
  review_out_of_date INTEGER NOT NULL DEFAULT 0,
  ignored INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY,
  pr_id INTEGER NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  gh_key TEXT NOT NULL,
  thread_id TEXT,
  reply_to_db_id INTEGER,
  last_seen_gh_id TEXT,
  author TEXT,
  body TEXT NOT NULL,
  path TEXT,
  line INTEGER,
  url TEXT,
  state TEXT NOT NULL DEFAULT 'new',
  proposal TEXT,
  reply_draft TEXT,
  reply_edited INTEGER NOT NULL DEFAULT 0,
  skip_reason TEXT,
  auto INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  task TEXT,
  task_source TEXT,
  clarify INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (pr_id, gh_key)
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY,
  pr_id INTEGER NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
  comment_id INTEGER,
  question TEXT NOT NULL,
  options TEXT,
  answer TEXT,
  state TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY,
  pr_id INTEGER NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'finding',
  path TEXT,
  line INTEGER,
  thread_id TEXT,
  reply_to_db_id INTEGER,
  in_diff INTEGER NOT NULL DEFAULT 1,
  body TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS work_items (
  id INTEGER PRIMARY KEY,
  pr_id INTEGER NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload TEXT,
  state TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

export type Db = ReturnType<typeof openDb>;

export function openDb(path = join(config.stateDir, 'pr-manager.db')) {
  if (path !== ':memory:') mkdirSync(config.stateDir, { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(schema);
  // Columns added after the first release; CREATE TABLE IF NOT EXISTS does not add them.
  const migrations: [string, string, string][] = [
    ['prs', 'ignored', 'INTEGER NOT NULL DEFAULT 0'],
    ['comments', 'task', 'TEXT'],
    ['comments', 'task_source', 'TEXT'],
    ['comments', 'clarify', 'INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [table, column, type] of migrations) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (cols.some((c) => c.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    // Checklist items are new: re-read every PR once, so open boxes on unchanged PRs are found too.
    if (column === 'task') db.exec(`UPDATE prs SET gh_updated_at = ''`);
  }

  const all = <T>(sql: string, ...params: SQLInputValue[]) => db.prepare(sql).all(...params) as unknown as T[];
  const get = <T>(sql: string, ...params: SQLInputValue[]) => db.prepare(sql).get(...params) as unknown as T | undefined;
  const run = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).run(...params);

  // Updates the given columns of one row; keys are trusted column names from our own code.
  const update = (table: string, id: number, fields: Record<string, SQLInputValue>) => {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const extra = table === 'comments' ? `, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` : '';
    run(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')}${extra} WHERE id = ?`, ...keys.map((k) => fields[k]), id);
  };

  const insert = (table: string, fields: Record<string, SQLInputValue>) => {
    const keys = Object.keys(fields);
    const res = run(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, ...keys.map((k) => fields[k]));
    return Number(res.lastInsertRowid);
  };

  return {
    raw: db,
    all,
    get,
    run,
    update,
    insert,
    pr: (id: number) => get<Pr>('SELECT * FROM prs WHERE id = ?', id),
    prByUrl: (url: string) => get<Pr>('SELECT * FROM prs WHERE url = ?', url),
    prs: () => all<Pr>('SELECT * FROM prs ORDER BY repo, number'),
    comments: (prId: number) => all<Comment>('SELECT * FROM comments WHERE pr_id = ? ORDER BY id', prId),
    comment: (id: number) => get<Comment>('SELECT * FROM comments WHERE id = ?', id),
    questions: (prId: number) => all<Question>('SELECT * FROM questions WHERE pr_id = ? ORDER BY id', prId),
    findings: (prId: number) => all<Finding>('SELECT * FROM findings WHERE pr_id = ? ORDER BY id', prId),
    workItems: (prId: number) => all<WorkItem>('SELECT * FROM work_items WHERE pr_id = ? ORDER BY id', prId),
    enqueue: (prId: number, kind: WorkKind, payload?: unknown) => {
      // One queued item per kind and PR is enough; the session sees the current state anyway.
      const existing = get<WorkItem>(`SELECT * FROM work_items WHERE pr_id = ? AND kind = ? AND state = 'queued'`, prId, kind);
      if (existing) return existing.id;
      return insert('work_items', { pr_id: prId, kind, payload: payload === undefined ? null : JSON.stringify(payload) });
    },
    kvGet: (key: string) => get<{ value: string }>('SELECT value FROM kv WHERE key = ?', key)?.value,
    kvSet: (key: string, value: string) => run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value),
    transaction: <T>(fn: () => T): T => {
      db.exec('BEGIN');
      try {
        const res = fn();
        db.exec('COMMIT');
        return res;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

export const now = () => new Date().toISOString();

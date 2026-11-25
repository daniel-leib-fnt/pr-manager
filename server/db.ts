import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { config } from './config.ts';
import type { Comment, Finding, FollowUp, OwnFields, Pr, PrBase, PrFields, Question, ReviewFields, WorkItem, WorkKind } from './model.ts';

const OWN_COLUMNS = [
  'batch_head_sha',
  'last_event_at',
  'ci_attempts',
  'ready',
  'self_review_sha',
  'self_review_state',
  'self_review_result',
  'self_review_round',
  'push_after',
  'open_threads',
] as const satisfies readonly (keyof OwnFields)[];

const REVIEW_COLUMNS = [
  'in_review_search',
  'review_state',
  'review_verdict',
  'review_body',
  'review_draft_sha',
  'reviewed_sha',
  'reviewed_at',
  'review_out_of_date',
  'review_threads',
  'head_seen_at',
  'review_without_build',
] as const satisfies readonly (keyof ReviewFields)[];

/** The table that holds the fields of each role, one row per PR of that role. */
const ROLE_TABLES = { own: { table: 'own_prs', columns: OWN_COLUMNS }, review: { table: 'review_prs', columns: REVIEW_COLUMNS } } as const;

/** The tables `update` and `insert` write, with their rows. PRs go through `insertPr` and `updatePr`. */
interface Rows {
  comments: Comment;
  questions: Question;
  findings: Finding;
  work_items: WorkItem;
  follow_ups: FollowUp;
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
  ignored INTEGER NOT NULL DEFAULT 0,
  kept TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS own_prs (
  pr_id INTEGER PRIMARY KEY REFERENCES prs(id) ON DELETE CASCADE,
  batch_head_sha TEXT,
  last_event_at TEXT,
  ci_attempts INTEGER NOT NULL DEFAULT 0,
  ready INTEGER NOT NULL DEFAULT 0,
  self_review_sha TEXT,
  self_review_state TEXT,
  self_review_result TEXT,
  self_review_round INTEGER NOT NULL DEFAULT 0,
  push_after TEXT,
  open_threads TEXT
);
CREATE TABLE IF NOT EXISTS review_prs (
  pr_id INTEGER PRIMARY KEY REFERENCES prs(id) ON DELETE CASCADE,
  in_review_search INTEGER NOT NULL DEFAULT 0,
  review_state TEXT NOT NULL DEFAULT 'none',
  review_verdict TEXT,
  review_body TEXT,
  review_draft_sha TEXT,
  reviewed_sha TEXT,
  reviewed_at TEXT,
  review_out_of_date INTEGER NOT NULL DEFAULT 0,
  review_threads TEXT,
  head_seen_at TEXT,
  review_without_build INTEGER NOT NULL DEFAULT 0
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
  outdated INTEGER NOT NULL DEFAULT 0,
  diff_hunk TEXT,
  url TEXT,
  state TEXT NOT NULL DEFAULT 'new',
  proposal TEXT,
  reply_draft TEXT,
  reply_edited INTEGER NOT NULL DEFAULT 0,
  skip_reason TEXT,
  decision TEXT,
  auto INTEGER NOT NULL DEFAULT 0,
  risk TEXT,
  confidence TEXT,
  reason TEXT,
  by_agent INTEGER NOT NULL DEFAULT 0,
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
CREATE TABLE IF NOT EXISTS follow_ups (
  id INTEGER PRIMARY KEY,
  pr_id INTEGER NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
  comment_id INTEGER,
  text TEXT NOT NULL,
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
  resolve INTEGER NOT NULL DEFAULT 0,
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

/** Columns added after the first release; CREATE TABLE IF NOT EXISTS does not add them. */
const ADDED_COLUMNS: [string, string, string][] = [
  ['comments', 'decision', 'TEXT'],
  ['comments', 'outdated', 'INTEGER NOT NULL DEFAULT 0'],
  ['comments', 'diff_hunk', 'TEXT'],
  ['findings', 'resolve', 'INTEGER NOT NULL DEFAULT 0'],
  ['comments', 'risk', 'TEXT'],
  ['comments', 'confidence', 'TEXT'],
  ['comments', 'reason', 'TEXT'],
  ['comments', 'by_agent', 'INTEGER NOT NULL DEFAULT 0'],
  ['prs', 'kept', 'TEXT'],
  ['own_prs', 'open_threads', 'TEXT'],
  ['review_prs', 'head_seen_at', 'TEXT'],
  ['review_prs', 'review_without_build', 'INTEGER NOT NULL DEFAULT 0'],
];

/** Role columns that `prs` gained before the role tables existed; a database older than them gets them first. */
const LEGACY_PR_COLUMNS: [string, string, string][] = [
  ['prs', 'review_threads', 'TEXT'],
  ['prs', 'self_review_sha', 'TEXT'],
  ['prs', 'self_review_state', 'TEXT'],
  ['prs', 'self_review_result', 'TEXT'],
  ['prs', 'self_review_round', 'INTEGER NOT NULL DEFAULT 0'],
  ['prs', 'push_after', 'TEXT'],
  ['prs', 'open_threads', 'TEXT'],
  ['prs', 'head_seen_at', 'TEXT'],
  ['prs', 'review_without_build', 'INTEGER NOT NULL DEFAULT 0'],
];

function migrate(db: DatabaseSync, path: string) {
  const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  const add = (list: [string, string, string][]) => {
    for (const [table, column, type] of list) {
      if (columns(table).includes(column)) continue;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      // Existing thread rows get their hunk on the next ingest, which a reset update time forces.
      if (column === 'diff_hunk') db.exec(`UPDATE prs SET gh_updated_at = '' WHERE role = 'own' AND state = 'open'`);
    }
  };
  add(ADDED_COLUMNS);

  // Until the role tables existed, `prs` held the fields of both roles: move them, then drop them from `prs`.
  if (columns('prs').includes('review_state')) {
    const backup = `${path}.before-role-tables`;
    if (path !== ':memory:' && !existsSync(backup)) db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
    add(LEGACY_PR_COLUMNS);
    db.exec('BEGIN');
    try {
      for (const [role, { table, columns: cols }] of Object.entries(ROLE_TABLES)) {
        db.exec(`INSERT INTO ${table} (pr_id, ${cols.join(', ')}) SELECT id, ${cols.join(', ')} FROM prs WHERE role = '${role}'`);
        for (const c of cols) db.exec(`ALTER TABLE prs DROP COLUMN ${c}`);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  // Recreated on every start, so the view always shows the columns the tables have now.
  db.exec(`
    DROP VIEW IF EXISTS pr_view;
    CREATE VIEW pr_view AS
      SELECT p.*, ${OWN_COLUMNS.map((c) => `o.${c}`).join(', ')}, ${REVIEW_COLUMNS.map((c) => `r.${c}`).join(', ')}
      FROM prs p LEFT JOIN own_prs o ON o.pr_id = p.id LEFT JOIN review_prs r ON r.pr_id = p.id`);
}

export function openDb(path = join(config.stateDir, 'pr-manager.db')) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(schema);
  migrate(db, path);

  const all = <T>(sql: string, ...params: SQLInputValue[]) => db.prepare(sql).all(...params) as unknown as T[];
  const get = <T>(sql: string, ...params: SQLInputValue[]) => db.prepare(sql).get(...params) as unknown as T | undefined;
  const run = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).run(...params);

  type Fields = Record<string, SQLInputValue | undefined>;
  // Table and column names are trusted: they come from our own code, never from input.
  const set = (table: string, key: string, id: number, fields: Fields, extra = '') => {
    const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
    if (keys.length === 0) return 1;
    const res = run(
      `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')}${extra} WHERE ${key} = ?`,
      ...keys.map((k) => fields[k]!),
      id,
    );
    return Number(res.changes);
  };
  const add = (table: string, fields: Fields) => {
    const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
    const res = run(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, ...keys.map((k) => fields[k]!));
    return Number(res.lastInsertRowid);
  };
  const pick = (fields: Fields, columns: readonly string[]) =>
    Object.fromEntries(Object.entries(fields).filter(([k]) => columns.includes(k)));
  const roleColumns: readonly string[] = [...OWN_COLUMNS, ...REVIEW_COLUMNS];
  const baseOf = (fields: Fields) => Object.fromEntries(Object.entries(fields).filter(([k]) => !roleColumns.includes(k)));

  /** Updates the given columns of one row. */
  const update = <T extends keyof Rows>(table: T, id: number, fields: Partial<Rows[T]>) => {
    set(table, 'id', id, fields as Fields, table === 'comments' ? `, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` : '');
  };

  const insert = <T extends keyof Rows>(table: T, fields: Partial<Rows[T]>) => add(table, fields as Fields);

  /**
   * Updates a PR, each column in the table that holds it. A column of the other role is a bug in the caller
   * and throws, instead of being dropped silently.
   */
  const updatePr = (id: number, fields: Partial<PrFields>) => {
    set('prs', 'id', id, baseOf(fields));
    for (const [role, { table, columns }] of Object.entries(ROLE_TABLES)) {
      const part = pick(fields, columns);
      if (!set(table, 'pr_id', id, part)) throw new Error(`PR ${id} is not of role ${role}: cannot set ${Object.keys(part).join(', ')}.`);
    }
  };

  /** Inserts a PR together with the row of its role. */
  const insertPr = (
    fields: Pick<PrBase, 'url' | 'repo' | 'number' | 'title' | 'author' | 'role' | 'head_ref' | 'head_sha' | 'base_ref'> &
      Partial<PrFields>,
  ) =>
    transaction(() => {
      const id = add('prs', baseOf(fields));
      const { table, columns } = ROLE_TABLES[fields.role];
      add(table, { pr_id: id, ...pick(fields, columns) });
      return id;
    });

  function transaction<T>(fn: () => T): T {
    db.exec('BEGIN');
    try {
      const res = fn();
      db.exec('COMMIT');
      return res;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  return {
    all,
    get,
    run,
    update,
    insert,
    updatePr,
    insertPr,
    pr: (id: number) => get<Pr>('SELECT * FROM pr_view WHERE id = ?', id),
    prByUrl: (url: string) => get<Pr>('SELECT * FROM pr_view WHERE url = ?', url),
    prs: () => all<Pr>('SELECT * FROM pr_view ORDER BY repo, number'),
    /** PRs matching a condition on the columns of `pr_view`, written by our own code. */
    prsWhere: (condition: string, ...params: SQLInputValue[]) => all<Pr>(`SELECT * FROM pr_view WHERE ${condition}`, ...params),
    /** Sessions pr-manager started; an interactive session is any other. */
    ownSessionIds: () =>
      new Set(all<{ session_id: string }>('SELECT session_id FROM prs WHERE session_id IS NOT NULL').map((r) => r.session_id)),
    comments: (prId: number) => all<Comment>('SELECT * FROM comments WHERE pr_id = ? ORDER BY id', prId),
    comment: (id: number) => get<Comment>('SELECT * FROM comments WHERE id = ?', id),
    questions: (prId: number) => all<Question>('SELECT * FROM questions WHERE pr_id = ? ORDER BY id', prId),
    findings: (prId: number) => all<Finding>('SELECT * FROM findings WHERE pr_id = ? ORDER BY id', prId),
    followUps: (prId: number) => all<FollowUp>('SELECT * FROM follow_ups WHERE pr_id = ? ORDER BY id', prId),
    workItems: (prId: number) => all<WorkItem>('SELECT * FROM work_items WHERE pr_id = ? ORDER BY id', prId),
    enqueue: (prId: number, kind: WorkKind, payload?: unknown) => {
      // One queued item per kind and PR is enough; the session sees the current state anyway.
      const existing = get<WorkItem>(`SELECT * FROM work_items WHERE pr_id = ? AND kind = ? AND state = 'queued'`, prId, kind);
      if (existing) return existing.id;
      return add('work_items', { pr_id: prId, kind, payload: payload === undefined ? null : JSON.stringify(payload) });
    },
    kvGet: (key: string) => get<{ value: string }>('SELECT value FROM kv WHERE key = ?', key)?.value,
    kvSet: (key: string, value: string) =>
      run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value),
    transaction,
  };
}

export const now = () => new Date().toISOString();

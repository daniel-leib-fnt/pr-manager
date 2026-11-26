import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openDb } from '../server/db.ts';
import type { OwnPr, ReviewPr } from '../server/model.ts';

const base = { repo: 'o/r', number: 1, title: 't', author: 'a', head_ref: 'h', head_sha: 'a1', base_ref: 'main' };

test('a PR is one row of its role: base and role columns read as one, each written to its table', () => {
  const db = openDb(':memory:');
  const own = db.insertPr({ ...base, url: 'own', role: 'own', ready: 1 });
  const review = db.insertPr({ ...base, url: 'review', role: 'review', in_review_search: 1 });

  const o = db.pr(own) as OwnPr;
  assert.deepEqual([o.role, o.ready, o.ci_attempts, o.batch_head_sha, o.paused], ['own', 1, 0, null, 0]);
  const r = db.pr(review) as ReviewPr;
  assert.deepEqual([r.role, r.in_review_search, r.review_state, r.reviewed_sha], ['review', 1, 'none', null]);

  db.updatePr(own, { title: 'new', batch_head_sha: 'a1' });
  db.updatePr(review, { blocked: 'why', review_state: 'draft' });
  assert.deepEqual([db.pr(own)!.title, (db.pr(own) as OwnPr).batch_head_sha], ['new', 'a1']);
  assert.deepEqual([db.pr(review)!.blocked, (db.pr(review) as ReviewPr).review_state], ['why', 'draft']);
  assert.equal(db.prsWhere(`role = 'own' AND batch_head_sha = ?`, 'a1').length, 1);
});

test('a column of the other role is rejected instead of dropped', () => {
  const db = openDb(':memory:');
  const own = db.insertPr({ ...base, url: 'own', role: 'own' });
  const review = db.insertPr({ ...base, url: 'review', role: 'review' });
  assert.throws(() => db.updatePr(own, { review_state: 'draft' }), /not of role review/);
  assert.throws(() => db.updatePr(review, { batch_head_sha: 'a1' }), /not of role own/);
});

test('removing a PR removes the row of its role', () => {
  const db = openDb(':memory:');
  const own = db.insertPr({ ...base, url: 'own', role: 'own' });
  db.run('DELETE FROM prs WHERE id = ?', own);
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM own_prs')!.n, 0);
});

test('a database from before the role tables is migrated without losing a value, and backed up first', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'prm-db-')), 'pr-manager.db');
  const legacy = new DatabaseSync(path);
  legacy.exec(readFileSync(join(import.meta.dirname, 'legacy-schema.sql'), 'utf8'));
  legacy.exec(`
    INSERT INTO prs (url, repo, number, title, author, role, head_ref, head_sha, base_ref, paused, kept, batch_head_sha, last_event_at,
      ci_attempts, ready, self_review_state, self_review_round, push_after)
      VALUES ('own', 'o/r', 1, 't', 'me', 'own', 'h', 'a1', 'main', 1, 'kept', 'b0', '2026-11-01T00:00:00Z', 2, 1, 'failed', 1, '2026-11-02T00:00:00Z');
    INSERT INTO prs (url, repo, number, title, author, role, head_ref, head_sha, base_ref, in_review_search, review_state, review_verdict,
      review_body, review_draft_sha, reviewed_sha, reviewed_at, review_out_of_date, review_threads)
      VALUES ('review', 'o/r', 2, 't', 'bob', 'review', 'h2', 'c1', 'main', 1, 'submitted', 'APPROVE', 'ok', 'c0', 'c0', '2026-11-03T00:00:00Z', 1, '[]');
    INSERT INTO comments (pr_id, kind, gh_key, body) VALUES (1, 'thread', 'thread:x', 'b');
  `);
  legacy.close();

  const db = openDb(path);
  assert.ok(existsSync(`${path}.before-role-tables`), 'the old database is kept as a backup');
  const own = db.prByUrl('own') as OwnPr;
  assert.deepEqual(
    [own.paused, own.kept, own.batch_head_sha, own.last_event_at, own.ci_attempts, own.ready, own.self_review_state, own.self_review_round],
    [1, 'kept', 'b0', '2026-11-01T00:00:00Z', 2, 1, 'failed', 1],
  );
  assert.ok(!('push_after' in own), 'the veto window is gone');
  const review = db.prByUrl('review') as ReviewPr;
  assert.deepEqual(
    [review.in_review_search, review.review_state, review.review_verdict, review.review_body, review.review_draft_sha, review.reviewed_sha],
    [1, 'submitted', 'APPROVE', 'ok', 'c0', 'c0'],
  );
  assert.deepEqual([review.reviewed_at, review.review_out_of_date, review.review_threads], ['2026-11-03T00:00:00Z', 1, '[]']);
  assert.equal(db.comments(own.id).length, 1);
  const columns = db.all<{ name: string }>('PRAGMA table_info(prs)').map((c) => c.name);
  assert.ok(!columns.includes('review_state') && !columns.includes('batch_head_sha'), 'the role columns left the base table');
  assert.ok(!columns.includes('push_after'), 'a column that went away is dropped from the base table too');

  // Opening it again migrates nothing and changes nothing.
  const again = openDb(path);
  assert.deepEqual(again.prByUrl('own'), own);
  assert.deepEqual(again.prByUrl('review'), review);
});

test('a follow-up from before the severity counts as an action', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'prm-db-')), 'pr-manager.db');
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE follow_ups (id INTEGER PRIMARY KEY, pr_id INTEGER NOT NULL, comment_id INTEGER, text TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL DEFAULT '2026-11-01T00:00:00Z');
    INSERT INTO follow_ups (pr_id, text) VALUES (1, 'Check it.');
  `);
  old.close();
  assert.equal(openDb(path).followUps(1)[0].severity, 'action');
});

test('a database that still has the veto window column loses it', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'prm-db-')), 'pr-manager.db');
  const first = openDb(path);
  const id = first.insertPr({ ...base, url: 'own', role: 'own' });
  first.run('ALTER TABLE own_prs ADD COLUMN push_after TEXT');
  first.run(`UPDATE own_prs SET push_after = '2026-11-02T00:00:00Z' WHERE pr_id = ?`, id);
  const again = openDb(path);
  assert.ok(!again.all<{ name: string }>('PRAGMA table_info(own_prs)').some((c) => c.name === 'push_after'));
  assert.equal(again.pr(id)!.url, 'own');
});

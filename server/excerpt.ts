import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

/** A few lines of a file around the line a comment or finding points to. */
export interface Excerpt {
  /** Number of the first line in `text`, 1-based. */
  start: number;
  line: number;
  text: string;
}

/** The lines around `line` (1-based), or null when the file has no such line. */
export function cut(content: string, line: number, around = 3): Excerpt | null {
  const lines = content.split('\n');
  if (line < 1 || line > lines.length) return null;
  const start = Math.max(1, line - around);
  return { start, line, text: lines.slice(start - 1, line + around).join('\n') };
}

/** Reads the excerpt from the PR's worktree; a missing file or a path outside the worktree gives null. */
export function excerpt(worktree: string | null, path: string | null, line: number | null): Excerpt | null {
  if (!worktree || !path || !line) return null;
  const rel = relative(worktree, resolve(worktree, path));
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  try {
    return cut(readFileSync(resolve(worktree, rel), 'utf8'), line);
  } catch {
    return null;
  }
}

/**
 * The commented line and up to `before` lines above it, from the diff hunk GitHub keeps with a review comment.
 * The hunk ends at the commented line; a last line starting with `-` puts the comment on the old side.
 */
export function fromHunk(hunk: string, before = 6): Excerpt | null {
  const [header, ...lines] = hunk.split('\n');
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
  if (!m || !lines.length) return null;
  const old = lines.at(-1)!.startsWith('-');
  const side = lines.filter((l) => !l.startsWith(old ? '+' : '-')).map((l) => l.slice(1));
  const line = Number(old ? m[1] : m[2]) + side.length - 1;
  const shown = side.slice(-(before + 1));
  return { start: line - shown.length + 1, line, text: shown.join('\n') };
}

/**
 * The excerpt for a review comment: the current file from the worktree, or the hunk GitHub kept when the
 * worktree cannot provide it or the thread is outdated, since the current file no longer holds the commented code.
 */
export function commentExcerpt(
  worktree: string | null,
  c: { path: string | null; line: number | null; outdated: number; diff_hunk: string | null },
): Excerpt | null {
  const fromWorktree = c.outdated ? null : excerpt(worktree, c.path, c.line);
  return fromWorktree ?? (c.diff_hunk ? fromHunk(c.diff_hunk) : null);
}

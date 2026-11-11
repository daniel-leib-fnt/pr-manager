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

import { createHash } from 'node:crypto';

// Markdown task-list line: "- [ ] text", "* [x] text" or "+ [ ] text", optionally indented or quoted.
const TASK = /^(\s*(?:>\s*)*[-*+]\s+\[)([ xX])(\]\s+)(.*?)\s*$/;
const FENCE = /^\s*(```|~~~)/;

export interface Task {
  text: string;
  checked: boolean;
  /** Index of the line in the body split at '\n'. */
  line: number;
}

/** Task-list lines of a comment body, outside fenced code blocks. */
export function parseTasks(body: string): Task[] {
  const out: Task[] = [];
  let fenced = false;
  body.split('\n').forEach((raw, line) => {
    if (FENCE.test(raw)) fenced = !fenced;
    if (fenced) return;
    const m = TASK.exec(raw.replace(/\r$/, ''));
    if (m && m[4]) out.push({ text: m[4], checked: m[2] !== ' ', line });
  });
  return out;
}

export const hasTasks = (body: string) => parseTasks(body).length > 0;

/** Whether the body has text besides its task lines; only then does a checked box get a reply as well. */
export function hasProse(body: string): boolean {
  const taskLines = new Set(parseTasks(body).map((t) => t.line));
  return body.split('\n').some((l, i) => !taskLines.has(i) && l.trim() !== '');
}

/**
 * The body with the first unchecked line whose text is `text` checked off, everything else byte for byte
 * unchanged; null when there is no such line (edited away or already checked).
 */
export function checkTask(body: string, text: string): string | null {
  const lines = body.split('\n');
  const t = parseTasks(body).find((x) => !x.checked && x.text === text);
  if (!t) return null;
  const raw = lines[t.line];
  const pre = TASK.exec(raw.replace(/\r$/, ''))![1];
  lines[t.line] = `${pre}x${raw.slice(pre.length + 1)}`;
  return lines.join('\n');
}

/** Stable key of a task line within its source comment; repeated identical lines are told apart by occurrence. */
export function taskKeys(sourceKey: string, tasks: Task[]): string[] {
  const seen = new Map<string, number>();
  return tasks.map((t) => {
    const n = seen.get(t.text) ?? 0;
    seen.set(t.text, n + 1);
    const hash = createHash('sha256').update(t.text).digest('hex').slice(0, 12);
    return `task:${sourceKey}:${hash}${n ? `:${n}` : ''}`;
  });
}

/** Where a checklist line lives on GitHub, for checking its box. */
export interface TaskSource {
  type: 'issue_comment' | 'review' | 'review_comment';
  id: number;
}

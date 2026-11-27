import type { Comment, Question } from './api';
import type { Choice } from './components/choice-group';
import type { Message } from './components/conversation';
import type { Action, Decision, Draft } from './pr-view';

/** Helpers of the decision list of my PR, shared by the Decisions tab, its cards and the Done tab. */

export const ACTIONS: Choice<Action>[] = [
  { value: 'accept', label: 'Accept', tone: 'ok', help: 'The agent implements the proposal; the thread is resolved.' },
  { value: 'reject', label: 'Reject', tone: 'warn', help: 'No code change; a reply declines it and the thread is resolved.' },
  { value: 'reply', label: 'Reply', tone: 'info', help: 'No code change; a reply only, the thread stays open.' },
  {
    value: 'skip',
    label: 'Skip',
    tone: 'plain',
    help: 'Nothing is posted and nothing is resolved. A skipped thread keeps the PR with me until it is answered or resolved on GitHub.',
  },
];

export const LABEL: Record<Action, string> = { accept: 'Accept', reject: 'Reject', reply: 'Reply', skip: 'Skip' };
export const TAG_CLASS: Record<Action, string> = { accept: 'ok', reject: 'warn', reply: 'info', skip: '' };
const DONE_LABEL: Record<Action, string> = { accept: 'Accepted', reject: 'Rejected', reply: 'Replied', skip: 'Skipped' };

/** One entry of the decision list of my PR: a comment or a question of the agent. */
export interface Entry {
  key: string;
  comment?: Comment;
  question?: Question;
  /** open: waits for a decision; settled: fixed or skipped, waiting for push; working: with the agent; done: on GitHub. */
  stage: 'open' | 'settled' | 'working' | 'done';
  /** When a done item was finished; the Done tab groups by its day. */
  at?: string;
}

/** The decision a fixed or skipped comment stands for, shown on its folded card. */
export function settledDecision(c: Comment): Action | null {
  if (c.state === 'fixed') return c.clarify ? 'reply' : 'accept';
  if (c.state === 'skipped') return c.skip_reason?.trim() ? 'reject' : 'skip';
  return null;
}

/** Bot markup such as `<!-- ccr-overview-v2 -->` carries nothing for a reader. */
const stripMarkup = (text: string) => text.replace(/<!--[\s\S]*?-->/g, '').trim();

/** A thread body holds its comments as `@author (date):` blocks separated by `---` (see poller.ts). */
export function messages(c: Comment): Message[] {
  const parts = c.kind === 'thread' ? c.body.split('\n\n---\n\n') : [c.body];
  return parts.map((part) => {
    const m = /^@(\S+) \(([^)]*)\):\n([\s\S]*)$/.exec(part);
    return m ? { author: m[1], at: m[2], text: stripMarkup(m[3]) } : { author: c.author ?? c.kind, at: null, text: stripMarkup(part) };
  });
}

/** First line of the actual comment text, skipping headers, bot markup and Markdown decoration. */
export function headline(c: Comment): string {
  if (c.task) return c.task;
  const text = messages(c).at(-1)?.text ?? c.body;
  const line = text.split('\n').find((l) => l.trim() && l.trim() !== '---');
  return (line ?? text)
    .replace(/^[#>*\-\s]+/, '')
    .trim()
    .slice(0, 160);
}

export function kindLabel(c: Comment) {
  return {
    thread: 'thread',
    issue_comment: 'comment',
    review_body: 'review',
    ci: 'ci',
    instruction: 'instruction',
    conflict: 'conflict',
    self_review: 'self-review',
  }[c.kind];
}

/** The reply posted for an item: the reply draft, or the reason of a rejection. */
export const replyOf = (c: Comment) => c.reply_draft?.trim() || c.skip_reason?.trim() || null;

/** How a finished item ended, as the tag on its row. */
export function outcome(e: Entry): { text: string; cls: string; agent?: boolean } {
  const q = e.question;
  if (q) return { text: q.state === 'withdrawn' ? 'Withdrawn' : 'Answered', cls: '' };
  const c = e.comment!;
  if (c.decision) return { text: DONE_LABEL[c.decision], cls: TAG_CLASS[c.decision], agent: !!c.by_agent };
  if (c.kind !== 'ci' && c.note?.startsWith('Dismissed')) return { text: 'Dismissed', cls: '' };
  if (c.auto || c.kind === 'ci' || c.kind === 'conflict' || c.kind === 'self_review') return { text: 'Fixed', cls: 'ok' };
  return { text: 'Done', cls: '' };
}

/** My decision on a proposal, created in the draft on first access. */
export function decisionOf(draft: Draft, c: Comment): Decision {
  return (draft.decisions[c.id] ??= {
    action: '',
    proposal: c.proposal ?? '',
    replyDraft: '',
    writeReply: false,
  });
}

/** On a proposal: my choice if I made one, else the agent's pre-decision. Elsewhere: what the item stands for. */
export function actionOf(draft: Draft, c: Comment): Action | '' {
  if (c.state !== 'proposal') return settledDecision(c) ?? '';
  return draft.decisions[c.id]?.action || c.decision || '';
}

/** Whether the agent's pre-decision still stands: I neither chose differently nor wrote a reply. */
export function agentChoice(draft: Draft, c: Comment) {
  const d = draft.decisions[c.id];
  return !!c.decision && (!d || ((!d.action || d.action === c.decision) && !d.replyDraft.trim() && d.proposal === (c.proposal ?? '')));
}

/** Whether an open entry has my decision or answer. */
export function isDecided(draft: Draft, e: Entry) {
  if (e.comment) return !!actionOf(draft, e.comment);
  return !!e.question && !!draft.answers[e.question.id]?.trim();
}

/** The tag on the right of a card header. */
export function statusOf(draft: Draft, e: Entry): { text: string; cls: string; agent?: boolean } | null {
  const c = e.comment;
  if (!c) {
    const a = draft.answers[e.question!.id]?.trim();
    return a ? { text: 'Answered (pending)', cls: 'ok' } : { text: 'Open', cls: 'warn' };
  }
  if (c.state === 'proposal') {
    const a = actionOf(draft, c);
    if (!a) return { text: 'Open', cls: 'warn' };
    if (agentChoice(draft, c)) return { text: LABEL[a], cls: TAG_CLASS[a], agent: true };
    return { text: `${LABEL[a]} (pending)`, cls: TAG_CLASS[a] };
  }
  if (e.stage === 'settled') {
    const settled = settledDecision(c)!;
    return { text: `${LABEL[settled]} (pending)`, cls: TAG_CLASS[settled], agent: !!c.by_agent };
  }
  if (e.stage === 'working') return { text: 'Agent working', cls: 'info' };
  return null;
}

import type { Signal, TemplateRef } from '@angular/core';
import type { Pr } from './api';

export type Action = 'accept' | 'reject' | 'reply' | 'skip';

export interface Decision {
  action: Action | '';
  proposal: string;
  replyDraft: string;
  /** Whether the reply field is shown: an empty reply lets the agent write it. */
  writeReply: boolean;
}

export interface ReviewEdit {
  body: string;
  skip: boolean;
}

/** What I typed on a PR and have not sent yet: the frame keeps it, each role fills its part. */
export interface Draft {
  decisions: Record<number, Decision>;
  answers: Record<number, string>;
  findings: Record<number, ReviewEdit>;
  verdict: string;
  reviewBody: string;
  skipReviewBody: boolean;
  instruction: string;
}

export const emptyDraft = (): Draft => ({
  decisions: {},
  answers: {},
  findings: {},
  verdict: '',
  reviewBody: '',
  skipReviewBody: false,
  instruction: '',
});

/** Unsent answers survive a reload; storage can be unavailable, so every access is guarded. */
export function loadDraft(id: number): Draft {
  try {
    const raw = localStorage.getItem(`pr-manager:draft:${id}`);
    return raw ? { ...emptyDraft(), ...(JSON.parse(raw) as Draft) } : emptyDraft();
  } catch {
    return emptyDraft();
  }
}

export function saveDraft(id: number, draft: Draft) {
  try {
    localStorage.setItem(`pr-manager:draft:${id}`, JSON.stringify(draft));
  } catch {
    // storage unavailable
  }
}

/** What a role component asks the page frame to do: call the daemon, reload, and run `done` after the call succeeded. */
export interface ActionRequest {
  name: string;
  body?: unknown;
  /** Asks this question first; nothing happens when I decline. */
  confirm?: string;
  done?: () => void;
}

/**
 * The places of the page frame a role fills with its own markup. The role component declares them as
 * templates, so one instance (with its state) serves all of them.
 */
export interface RoleRegions {
  /** Tags in the tag row of the header. */
  tags?: Signal<TemplateRef<unknown> | undefined>;
  /** Entries of the meta line under the title. */
  meta?: Signal<TemplateRef<unknown> | undefined>;
  /** Banners right after the one for a blocked PR. */
  bannersEarly?: Signal<TemplateRef<unknown> | undefined>;
  /** Banners after the common ones. */
  bannersLate?: Signal<TemplateRef<unknown> | undefined>;
  /** Content of the first tab's button. */
  tabLabel?: Signal<TemplateRef<unknown> | undefined>;
  /** Content of the first tab. */
  main?: Signal<TemplateRef<unknown> | undefined>;
  /** Panels at the top of the side column. */
  side?: Signal<TemplateRef<unknown> | undefined>;
}

export const ROLE_LABEL = { own: 'Mine', review: 'Review' } as const;

export type CiStatus = 'success' | 'pending' | 'failure';

/** The daemon's build state (`buildState` in server/github.ts) as check, dot or cross. */
export function ciStatus(checkState: string | null): CiStatus | null {
  switch (checkState) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
      return 'failure';
    case 'PENDING':
      return 'pending';
    default:
      return null;
  }
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A reviewed batch the agent decided alone, waiting out the veto window before its push. */
export const vetoPending = (pr: Pr) =>
  pr.role === 'own' && pr.group === 'push' && !!pr.push_after && Date.parse(pr.push_after) > Date.now();

/** "at 14:30" today, "on Mon at 09:10" on another day. */
export function pushTime(iso: string): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return at.toDateString() === new Date().toDateString()
    ? `at ${time}`
    : `on ${at.toLocaleDateString([], { weekday: 'short' })} at ${time}`;
}

/** One line on what happens next with a PR, shown under its title in the list. */
export function nextStep(pr: Pr): string {
  if (pr.state !== 'open') return pr.kept ? `Worktree kept: ${pr.kept}` : pr.state === 'merged' ? 'Merged' : 'Closed';
  if (pr.ignored) return 'Ignored';
  if (pr.blocked) return `Blocked: ${pr.blocked}`;
  if (
    pr.state === 'open' &&
    pr.role === 'own' &&
    pr.self_review_state === 'failed' &&
    pr.group === 'needs_me' &&
    !pr.counts.proposals &&
    !pr.counts.questions
  )
    return 'Self-review did not pass';
  if (pr.running) return 'Agent run in progress';
  if (pr.paused) return 'Agent paused';
  const todo = [
    pr.counts.proposals ? `Decide ${plural(pr.counts.proposals, 'proposal')}` : '',
    pr.counts.questions ? `Answer ${plural(pr.counts.questions, 'question')}` : '',
    pr.role === 'review' && pr.review_state === 'draft' ? `Submit review · ${plural(pr.counts.findings, 'finding')}` : '',
  ].filter(Boolean);
  if (todo.length) return todo.join(' · ');
  if (pr.waitingForBuild) return 'Review waits for a green build';
  if (pr.group === 'queued') return 'Queued for the agent';
  if (pr.role === 'own' && vetoPending(pr))
    return `Push of ${plural(pr.counts.pending, 'change')} ${pushTime(pr.push_after!)} unless I step in`;
  if (pr.group === 'push') return `Push of ${plural(pr.counts.pending, 'change')} up next`;
  if (pr.group === 'ready') return 'Ready to merge';
  if (pr.group === 'out_of_date') return 'Review out of date';
  if (pr.role === 'review') return pr.review_state === 'submitted' ? 'Review submitted · waiting on the author' : 'Waiting for the review';
  return pr.is_draft ? 'Draft' : 'Waiting for review';
}

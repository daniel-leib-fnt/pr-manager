import { formatDate } from '@angular/common';
import type { Signal, TemplateRef } from '@angular/core';
import type { Pr, WorkItem } from './api';

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
 * The state of a tile, shown as icon and, for `action` and `bad`, as tinted background, so that it reads at a glance:
 * `action` waits for me, `wait` for others or a running job, `idle` for nothing.
 */
export type TileTone = 'ok' | 'action' | 'wait' | 'bad' | 'idle';

/** One tile of the status strip on the Overview tab. It opens a tab of the page or a page on GitHub. */
export interface Tile {
  label: string;
  value: string;
  sub?: string;
  /** Every tile shows a state that changes; a fixed fact, such as the author, goes into the Details panel. */
  tone: TileTone;
  /** A pulsing dot instead of the icon of `wait`: something runs right now. */
  pulse?: boolean;
  /** `check_state` of the PR: the build icon the way GitHub shows it replaces the icon of the tone. */
  ci?: string | null;
  tab?: string;
  href?: string;
}

export interface NeedsAction {
  label: string;
  primary?: boolean;
  /** Exactly one of these three. */
  request?: ActionRequest;
  tab?: string;
  href?: string;
}

/** One entry of the "Needs me" card. */
export interface NeedsItem {
  key: string;
  title: string;
  /** ISO time shown after the title. */
  at?: string | null;
  /** Full text, kept with its line breaks. */
  text?: string;
  /** Monospace part before `sub`, such as a path. */
  mono?: string;
  sub?: string;
  tone?: 'warn' | 'info' | 'bad';
  actions: NeedsAction[];
}

/** The push section of the Details panel; only my own PRs have one. */
export interface PushInfo {
  push: string;
  /** Left out when no self-review ran. */
  selfReview: string | null;
  /** The review's summary, as tooltip. */
  selfReviewHint: string | null;
}

/** A tab a role adds between Overview and Activity. */
export interface RoleTab {
  id: string;
  label: string;
  badge?: string;
  badgeClass?: string;
  main: TemplateRef<unknown> | undefined;
  side?: TemplateRef<unknown> | undefined;
}

/**
 * What a role component gives the page frame: templates for the header and its own tabs, and data (tiles,
 * to-dos, push info) that the frame lays out once for both roles.
 */
export interface RoleRegions {
  /** Tags in the tag row of the header. */
  tags?: Signal<TemplateRef<unknown> | undefined>;
  /** Entries of the meta line under the title. */
  meta?: Signal<TemplateRef<unknown> | undefined>;
  /** The role's tabs, in order. */
  tabs: Signal<RoleTab[]>;
  /** The role's tiles, between Build and Agent. */
  tiles: Signal<Tile[]>;
  /** What waits for me in this role, most urgent first. */
  needs: Signal<NeedsItem[]>;
  push?: Signal<PushInfo | null>;
  /** Heading of the summary card. */
  summaryTitle: string;
  /** Whether the Overview lists the last work items. */
  recentActivity: boolean;
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

export const WORK_LABEL: Record<WorkItem['kind'], string> = {
  summarize: 'Summary',
  comments: 'Comments',
  answers: 'Decisions',
  review: 'Review',
  followup_review: 'Follow-up review',
  self_review: 'Self-review',
  close_batch: 'Push',
};

/** A time the way every date of the page is shown. */
export const stamp = (iso: string) => formatDate(iso, 'dd.MM. HH:mm', 'en-US');

export const sha7 = (sha: string) => sha.slice(0, 7);

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The Build tile: the check state and the head it ran for. */
export function buildTile(pr: Pr): Tile {
  const status = ciStatus(pr.check_state);
  return {
    label: 'Build',
    value: status === 'success' ? 'Passing' : status === 'pending' ? 'Running' : status === 'failure' ? 'Failing' : 'No build',
    sub: `${pr.waitingForBuild ? 'The review waits for a green build · ' : ''}head ${sha7(pr.head_sha)}`,
    tone: status === 'success' ? 'ok' : status === 'pending' ? 'wait' : status === 'failure' ? 'bad' : 'idle',
    ci: status ? pr.check_state : undefined,
    href: `${pr.url}/checks`,
  };
}

/** The Agent tile: what the agent does on this PR right now, and its last run. */
export function agentTile(pr: Pr, lastRun: WorkItem | null): Tile {
  const state: Pick<Tile, 'value' | 'tone' | 'pulse'> = pr.agent_running
    ? { value: 'Working', tone: 'wait', pulse: true }
    : pr.blocked
      ? { value: 'Blocked', tone: 'bad' }
      : pr.ignored
        ? { value: 'Ignored', tone: 'idle' }
        : pr.paused
          ? { value: 'Paused', tone: 'idle' }
          : pr.group === 'queued'
            ? { value: 'Queued', tone: 'wait' }
            : { value: 'Idle', tone: 'idle' };
  const when = lastRun ? (lastRun.finished_at ?? lastRun.started_at) : null;
  return {
    label: 'Agent',
    ...state,
    sub: lastRun
      ? `Last run: ${WORK_LABEL[lastRun.kind]}${when ? ` · ${stamp(when)}` : ''}${lastRun.state === 'failed' ? ' · failed' : ''}`
      : 'No run yet',
    tab: 'transcript',
  };
}

/** "today", "1 day", "5 days": how long ago a time was, in calendar days. */
export function age(iso: string): string {
  const start = new Date(iso);
  const days = Math.round(
    (new Date().setHours(0, 0, 0, 0) - new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime()) / 86_400_000,
  );
  return days <= 0 ? 'today' : plural(days, 'day');
}

/** How long a PR in "Waiting on others" has waited, appended to its next step. */
const waited = (pr: Pr, text: string) => (pr.group === 'waiting' && pr.waitingSince ? `${text} · since ${age(pr.waitingSince)}` : text);

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
    pr.openThreads.length ? `Answer or resolve ${plural(pr.openThreads.length, 'thread')} on GitHub` : '',
    pr.counts.followUps ? `Check ${plural(pr.counts.followUps, 'follow-up')}` : '',
    pr.role === 'own' && pr.final_review_id ? 'Tick the final review on GitHub' : '',
  ].filter(Boolean);
  if (todo.length) return todo.join(' · ');
  if (pr.noBuild) return 'No build ran: review without build or ignore';
  if (pr.waitingForBuild) return 'Review waits for a green build';
  if (pr.group === 'queued') return 'Queued for the agent';
  if (pr.group === 'push') return `Push of ${plural(pr.counts.pending, 'change')} up next`;
  if (pr.group === 'ready') return 'Ready to merge';
  if (pr.group === 'out_of_date') return 'Review out of date';
  if (pr.nudge && pr.waitingSince) return `No activity for ${age(pr.waitingSince)}: follow up with the reviewers`;
  if (pr.role === 'review')
    return waited(pr, pr.review_state === 'submitted' ? 'Review submitted · waiting on the author' : 'Waiting for the review');
  return waited(pr, pr.is_draft ? 'Draft' : 'Waiting for review');
}

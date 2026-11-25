/**
 * The data model: database rows, their state machines, and the JSON the HTTP API answers with.
 * Types only and no imports, because the web app compiles this file too (`web/src/app/api.ts`).
 */

export type RoleName = 'own' | 'review';
export type PrState = 'open' | 'merged' | 'closed' | 'dropped';
export type ReviewState = 'none' | 'draft' | 'submitted';
export type Verdict = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

/** What every pull request has, whatever its role. Table `prs`. */
export interface PrBase {
  id: number;
  url: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  role: RoleName;
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
  ignored: number;
  /** Why the worktree of a merged PR was kept instead of removed; null otherwise. */
  kept: string | null;
  created_at: string;
}

/** What only one of my own PRs has: the open batch, its self-review and the merge state. Table `own_prs`. */
export interface OwnFields {
  /** The head the open batch started from; null while no batch is open. */
  batch_head_sha: string | null;
  last_event_at: string | null;
  ci_attempts: number;
  /** 1 while GitHub reports the PR as approved and mergeable. */
  ready: number;
  /** The worktree HEAD the self-review of the open batch ran on, or is about to run on. */
  self_review_sha: string | null;
  /** null: no review yet, or one is queued; passed: the batch may be pushed; failed: the push waits for me. */
  self_review_state: 'passed' | 'failed' | null;
  /** JSON `SelfReview` of the last review of the open batch. */
  self_review_result: string | null;
  /** Correction rounds the self-review sent back to the agent in the open batch. */
  self_review_round: number;
  /** End of the veto window: a reviewed batch the agent decided alone is pushed only after this time. */
  push_after: string | null;
  /** JSON `OpenThread[]`: review threads open on GitHub without my reply, as of the last ingest; null before the first. */
  open_threads: string | null;
}

/** What only a PR I review has: the review draft and what I submitted. Table `review_prs`. */
export interface ReviewFields {
  in_review_search: number;
  review_state: ReviewState;
  review_verdict: Verdict | null;
  review_body: string | null;
  /** The commit the review draft was written for. */
  review_draft_sha: string | null;
  reviewed_sha: string | null;
  reviewed_at: string | null;
  review_out_of_date: number;
  /** JSON `ReviewThread[]`: the threads my review draft is about, as they were when the agent last wrote to it. */
  review_threads: string | null;
}

export type OwnPr = PrBase & OwnFields & { role: 'own' };
export type ReviewPr = PrBase & ReviewFields & { role: 'review' };
/** A row of the view `pr_view`: the base joined with the fields of its role. */
export type Pr = OwnPr | ReviewPr;
/** Every column a PR can have, for updates. */
export type PrFields = PrBase & OwnFields & ReviewFields;

// self_review: findings of the self-review on the open batch, handed back to the agent as an accepted item.
export type CommentKind = 'thread' | 'issue_comment' | 'review_body' | 'ci' | 'instruction' | 'conflict' | 'self_review';
// new: not triaged yet; fixed: changed locally (or a reply that keeps the thread open), waiting for push;
// proposal: waiting for a decision, possibly pre-decided by the agent; accepted: decided, agent has to implement
// or write the reply (see `decision`);
// skipped: I skipped (no reason) or rejected (reason = reply), waiting for push; done: finished; gone: deleted on GitHub.
export type CommentState = 'new' | 'fixed' | 'proposal' | 'accepted' | 'skipped' | 'done' | 'gone';
export type Decision = 'accept' | 'reject' | 'reply' | 'skip';
export type RiskClass = 'local' | 'contained' | 'structural';
export type Confidence = 'high' | 'medium' | 'low';

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
  /** 1 when the commented line no longer exists at the PR head; `line` is then the line at the commented commit. */
  outdated: number;
  /** GitHub's diff hunk ending at the commented line, for the code excerpt when the worktree cannot provide it. */
  diff_hunk: string | null;
  url: string | null;
  state: CommentState;
  proposal: string | null;
  reply_draft: string | null;
  /** 1 when I wrote the reply myself; any other reply carries the reply header. */
  reply_edited: number;
  skip_reason: string | null;
  /**
   * Accept implements the proposal; reject and reply change no code, the agent only writes the reply; skip posts
   * nothing. On a proposal it is the agent's pre-decision (null: the agent leaves it to me); after the submit, mine.
   */
  decision: Decision | null;
  auto: number;
  /** With autonomy: risk class, confidence and reason the agent gave for a proposal that changes code. */
  risk: RiskClass | null;
  confidence: Confidence | null;
  reason: string | null;
  /** 1 when the standing decision is the agent's pre-decision, taken without me submitting the batch. */
  by_agent: number;
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
  /** My answer; on a withdrawn question, the agent's reason. */
  answer: string | null;
  // open: waits for my answer; answered: the next run takes the answer to the agent; sent: the agent has it;
  // withdrawn: the agent took it back because a push settled it.
  state: 'open' | 'answered' | 'sent' | 'withdrawn';
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
  /** 1 on a thread reply that says the new head settles my point: the thread is resolved when I submit the review. */
  resolve: number;
  body: string;
  state: 'draft' | 'skipped' | 'submitted';
  created_at: string;
}

export type WorkKind = 'summarize' | 'comments' | 'answers' | 'review' | 'followup_review' | 'self_review' | 'close_batch';

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

export type BatchStatus = 'none' | 'open' | 'closable';

/** What a self-review session reports about the open batch. */
export interface SelfReviewResult {
  riskClass: RiskClass;
  verdict: 'pass' | 'changes';
  route?: 'auto-fixable' | 'escalate';
  summary: string;
  findings: { path?: string; line?: number; body: string }[];
}

/** `self_review_result` as stored: the report, if the session gave one, and why the review did not pass. */
export type SelfReview = Partial<SelfReviewResult> & { reason: string | null };

/** A review thread my review draft is about, as stored in `review_threads`. */
export interface ReviewThread {
  threadId: string;
  path: string;
  line: number | null;
  /** 1 when the commented line no longer exists at the PR head. */
  outdated: number;
  diff_hunk: string | null;
  resolved: boolean;
  url: string | null;
  comments: { author: string; at: string; body: string }[];
}

/** A review thread on one of my PRs that is not resolved and whose last comment is not mine. */
export interface OpenThread {
  threadId: string;
  path: string;
  author: string | null;
  url: string | null;
}

// --- HTTP API ---------------------------------------------------------------------------------

/** A few lines of the file a comment or finding points to, read from the PR's worktree. */
export interface Excerpt {
  /** Number of the first line in `text`, 1-based. */
  start: number;
  line: number;
  text: string;
}

export type Group = 'ready' | 'needs_me' | 'working' | 'queued' | 'push' | 'out_of_date' | 'waiting' | 'ignored' | 'closed';

/** What the dashboard gets on top of the row, for both roles. */
export interface SummaryFields {
  group: Group;
  running: boolean;
  counts: { proposals: number; questions: number; pending: number; findings: number };
  /** A review that is held back until the build is green. */
  waitingForBuild: boolean;
  batch: BatchStatus;
  /**
   * Threads open on GitHub without my reply that nothing in pr-manager handles any more, for example ones I
   * skipped. They keep the PR with me until they are answered or resolved on GitHub.
   */
  openThreads: OpenThread[];
}

/** The part of the summary that each role computes. */
export type RoleSummary = Pick<SummaryFields, 'waitingForBuild' | 'batch' | 'openThreads'>;

export type OwnPrSummary = OwnPr & SummaryFields;
export type ReviewPrSummary = Omit<ReviewPr, 'review_threads'> & SummaryFields;
export type PrSummary = OwnPrSummary | ReviewPrSummary;

export type CommentView = Comment & { excerpt: Excerpt | null };
export type FindingView = Finding & { url: string | null; excerpt: Excerpt | null };
export type ReviewThreadView = Omit<ReviewThread, 'diff_hunk'> & { excerpt: Excerpt | null };

export interface PrDetail {
  pr: PrSummary;
  comments: CommentView[];
  questions: Question[];
  findings: FindingView[];
  threads: ReviewThreadView[];
  work: WorkItem[];
}

export interface Setting {
  key: string;
  group: string;
  label: string;
  help: string | null;
  type: 'number' | 'boolean' | 'string' | 'text' | 'list' | 'map' | 'enum' | 'multi' | 'days';
  options: { value: string; label: string }[] | null;
  value: unknown;
  source: 'override' | 'nix' | 'default';
  nixValue: unknown;
  defaultValue: unknown;
}

export interface NixOnly {
  label: string;
  value: string;
  option: string;
}

export interface DeniedCall {
  at: string;
  pr: string;
  tool: string;
  detail: string;
  rule: string;
}

/** An event of `/api/events`: a PR changed, an agent message arrived, or a tool call was denied. */
export interface LiveEvent {
  type: 'pr' | 'message' | 'denied';
  prId: number;
  message?: unknown;
  tool?: string;
  detail?: string;
  at?: string;
}

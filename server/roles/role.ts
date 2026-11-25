import type { AgentTool, ToolContext } from '../agent-tools.ts';
import type { Db } from '../db.ts';
import type { GhPr } from '../github.ts';
import type { FindingView, Group, Pr, PrFields, PrState, ReviewThreadView, RoleName, RoleSummary, WorkItem, WorkKind } from '../model.ts';

/** What decides whether queued work may run; `review_without_build` is null on my own PRs. */
export type RunGate = Pick<Pr, 'check_state'> & { review_without_build?: number | null };

/** One run of the working session on a PR. */
export interface Run<P extends Pr = Pr> {
  db: Db;
  /** The PR as it was when the hook is called. */
  pr: P;
  /** The worktree, synced to the PR head. */
  path: string;
  kinds: Set<WorkKind>;
  items: WorkItem[];
}

/** A fresh session that only reads and reports once through `tools`; it is deleted afterwards. */
export interface ReadOnlySession {
  path: string;
  label: string;
  prompt: string;
  systemPrompt: string;
  /** Empty for the model of the working session. */
  model: string;
  tools: AgentTool[];
}

/** What the runner lends a role that runs queued work itself. */
export interface Worker {
  /** The synced worktree, or undefined when the PR had to be blocked. */
  preflight(pr: Pr): Promise<string | undefined>;
  /** Runs the session; returns the error it ended with, if any. */
  readOnlySession(pr: Pr, session: ReadOnlySession): Promise<string | undefined>;
}

/** A dashboard action on one PR. `pollNow` looks at GitHub right away. */
export type Route<P extends Pr = Pr> = (ctx: { db: Db; pr: P; body: unknown; pollNow(): Promise<void> }) => unknown;

/**
 * What differs between my own PRs and the PRs I review. Everything else (polling, worktree, session, queue,
 * questions, instructions, pausing, blocking, cleanup) is the same for both and lives outside `roles/`.
 * A hook gets the PR already narrowed to the role's type; `S` is what one run carries from `beforeRun`
 * through the tools to `afterRun`.
 *
 * A new kind of PR is a new implementation of this interface, registered in `roles/index.ts`.
 */
export interface Role<P extends Pr = Pr, S = unknown> {
  name: RoleName;
  /**
   * Whether the worktree holds work of mine. If so, a moved head never overwrites local commits, a closed
   * PR keeps its worktree, and a worktree with unpushed commits is not removed.
   */
  holdsMyWork: boolean;

  // --- Poll ---
  /** Columns of the role taken from GitHub on every poll. `known` is the row before, if any. */
  pollFields(gh: GhPr, known: P | undefined, inReviewSearch: boolean): Partial<PrFields>;
  /** A PR seen for the first time. */
  created?(db: Db, pr: P): void;
  /** The state the PR gets, given GitHub's. */
  pollState?(state: PrState, known: P, inReviewSearch: boolean): PrState;
  /** An open PR after its row was updated: turns what happened on GitHub into work. */
  polled(ctx: { db: Db; pr: P; prev: P; gh: GhPr; me: string; changed: boolean; inReviewSearch: boolean }): Promise<void>;
  /** Called every 30 seconds and after each poll, for work that becomes due by time. */
  tick?(db: Db): void;

  // --- Run ---
  /** Brings the worktree to the PR head. Throws `Blocked` when that needs me. */
  syncWorktree(db: Db, pr: P, path: string): Promise<void>;
  /** Whether queued work of this kind may run now. Gets the columns the runner selects (`Candidate`). */
  runnable(pr: RunGate, kind: WorkKind): boolean;
  /**
   * Queued work the role runs without the working session, such as a push. Returns the items left for the
   * working session; none when the role used up the turn.
   */
  runQueued?(db: Db, pr: P, queued: WorkItem[], worker: Worker): Promise<WorkItem[]>;
  /** The system prompt of the working session. */
  systemPrompt(): string;
  /** What the queued kinds ask of the agent, one paragraph each. */
  prompt(pr: P, kinds: Set<WorkKind>, items: WorkItem[]): string[];
  beforeRun(run: Run<P>): Promise<S>;
  tools(ctx: ToolContext<P>, state: S): AgentTool[];
  /** The role's part of what `get_pr` returns. */
  describe(ctx: ToolContext<P>, state: S): Promise<Record<string, unknown>>;
  /** Bookkeeping after a successful run, and notifications when I am needed. */
  afterRun(run: Run<P>, state: S): Promise<void>;
  /** An instruction of mine was added. */
  instructed?(db: Db, pr: P): void;

  // --- Dashboard ---
  /** Whether something of this role waits for me; open questions do so for every role. */
  needsMe(db: Db, pr: P): boolean;
  /** The group of a PR that neither waits for me nor has runnable work. */
  idleGroup(db: Db, pr: P): Group;
  summary(db: Db, pr: P): RoleSummary;
  detail(db: Db, pr: P): { findings: FindingView[]; threads: ReviewThreadView[] };
  /** Actions of this role, keyed like `POST submit`; they win over the common ones of the same key. */
  routes: Record<string, Route<P>>;
}

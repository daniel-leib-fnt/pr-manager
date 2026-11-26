import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Limits } from './batch.ts';
import { config, extraMcpServers } from './config.ts';
import type { Db } from './db.ts';
import type { DeniedCall, NixOnly, Setting } from './model.ts';
import { bus } from './util.ts';

/**
 * Behavior settings. Each value comes from, in this order: an override saved in the dashboard,
 * the Home Manager `settings` option (a JSON file named by PR_MANAGER_SETTINGS), the default here.
 */

const DEFAULT_RUBRIC = `An item is small only if all of these hold:
- The request is unambiguous.
- The change stays at or near the lines the comment refers to.
- It does not change behavior, a public API, a database schema, the build or dependencies.

Changing tests is fine.`;

const DEFAULT_REVIEW_GUIDELINES = `- Read the PR description and the full diff. Run tests only when they help you judge a change.
- Add one finding per real problem, anchored to a changed line.
- Skip style nitpicks that a formatter or linter would catch.
- Write a review body only when something needs work that spans several findings, such as a design change touching several places. List that work as task lines (\`* [ ] ...\`), at least one. Otherwise leave the body empty.
- Use APPROVE when nothing blocks, REQUEST_CHANGES for real defects, and COMMENT otherwise.`;

const DEFAULT_SELF_REVIEW = `# pr-manager self-review

You run unattended inside pr-manager. Another agent session changed code on one of my pull requests to settle review comments, failed checks or merge conflicts. Before the daemon pushes these changes, you review them independently. You know nothing of that session's reasoning, and that is intended: judge only what the diff does.

You only read. You cannot change files, run tests, push or call GitHub. Use \`Read\`, \`Glob\`, \`Grep\` and the git commands named in the task. Follow the instruction files of the repository when you judge the code.

Review only the changes of the batch, not the rest of the pull request:

- Does the diff do what the listed decisions ask for, and nothing beyond them?
- Does it introduce a defect, break a caller, or leave tests, documentation or generated files out of date?
- Skip style nitpicks that a formatter or linter would catch.

Classify the risk of the batch diff as a whole. The class of the riskiest change counts:

{{RISK_CLASSES}}

Report exactly once with \`mcp__pr__report_review\`, then finish your turn:

- \`verdict\`: \`pass\` when the changes can be pushed as they are, \`changes\` when something has to be fixed first.
- \`route\`, only with \`changes\`: \`auto-fixable\` when the findings are unambiguous and the other session can fix them without a decision of mine, \`escalate\` when I have to decide.
- \`findings\`: one entry per real problem, with file and line. Empty for \`pass\`.
- \`summary\`: two or three sentences on what the batch changes and why you reached the verdict.`;

const THRESHOLDS = [
  { value: 'never', label: 'Never, I decide' },
  { value: 'high', label: 'With high confidence' },
  { value: 'medium', label: 'With medium confidence or higher' },
  { value: 'low', label: 'Always' },
];
const threshold = z.enum(['never', 'high', 'medium', 'low']);
type Threshold = z.infer<typeof threshold>;

const NOTIFY_EVENTS = ['input', 'review_draft', 'blocked', 'error'] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

type FieldType = 'number' | 'boolean' | 'string' | 'text' | 'list' | 'map' | 'enum' | 'multi' | 'days';

interface Def<T> {
  group: string;
  label: string;
  help?: string;
  type: FieldType;
  options?: { value: string; label: string }[];
  schema: z.ZodType<T>;
  default: T;
}

const def = <T>(d: Def<T>) => d;

const REPO = /^[\w.-]+\/[\w.-]+$/;

export const DEFS = {
  pollIntervalMinutes: def({
    group: 'Polling',
    label: 'Poll interval (minutes)',
    type: 'number',
    schema: z.number().int().min(1).max(120),
    default: 2,
  }),
  pollDays: def({
    group: 'Polling',
    label: 'Active days',
    type: 'days',
    schema: z.array(z.number().int().min(0).max(6)),
    default: [1, 2, 3, 4, 5],
  }),
  pollFromHour: def({ group: 'Polling', label: 'Active from (hour)', type: 'number', schema: z.number().int().min(0).max(23), default: 7 }),
  pollToHour: def({
    group: 'Polling',
    label: 'Active until (hour, exclusive)',
    type: 'number',
    schema: z.number().int().min(1).max(24),
    default: 18,
  }),
  ownQuery: def({
    group: 'Scope',
    label: 'Search query for my PRs',
    help: 'GitHub search syntax; is:pr is implied by the search type but kept for clarity.',
    type: 'string',
    schema: z.string().min(1),
    default: 'is:pr is:open archived:false author:@me',
  }),
  reviewQuery: def({
    group: 'Scope',
    label: 'Search query for reviews',
    help: 'review-requested includes team requests; user-review-requested only direct ones.',
    type: 'string',
    schema: z.string().min(1),
    default: 'is:pr is:open archived:false review-requested:@me',
  }),
  reviewedQuery: def({
    group: 'Scope',
    label: 'Search query for PRs I reviewed',
    help: 'Finds PRs I reviewed directly on GitHub, so that answers to my review still reach me after the request is gone.',
    type: 'string',
    schema: z.string().min(1),
    default: 'is:pr is:open archived:false reviewed-by:@me -author:@me',
  }),
  excludedRepos: def({
    group: 'Scope',
    label: 'Excluded repositories',
    help: 'One owner/repo per line. Their PRs are ignored completely.',
    type: 'list',
    schema: z.array(z.string().regex(REPO, 'expected owner/repo')),
    default: [] as string[],
  }),
  ignoredChecks: def({
    group: 'Build',
    label: 'Ignored checks',
    help: 'One check name per line, for checks that may never finish. While they run, the build can still be green or failed; when they fail, the build fails. Applies to my PRs and reviews.',
    type: 'list',
    schema: z.array(z.string().min(1)),
    default: ['task-list-completed'],
  }),
  minSuccessfulChecks: def({
    group: 'Build',
    label: 'Minimum successful checks',
    help: 'The build is green only once this many checks that are not ignored succeeded; skipped and neutral ones do not count. Bridges the time after a push before the real build reports.',
    type: 'number',
    schema: z.number().int().min(1).max(100),
    default: 1,
  }),
  minSuccessfulChecksPerRepo: def({
    group: 'Build',
    label: 'Minimum successful checks per repository',
    help: 'One "owner/repo number" per line, for example "fntsoftware/skalos 3". Overrides the minimum above for that repository.',
    type: 'map',
    schema: z
      .record(z.string(), z.number().int().min(1).max(100))
      .refine((m) => Object.keys(m).every((r) => REPO.test(r)), 'expected owner/repo'),
    default: {} as Record<string, number>,
  }),
  reviewWaitForGreenBuild: def({
    group: 'Reviews',
    label: 'Wait for a green build before reviewing',
    help: 'Running and failed checks hold the review back, and so does a PR without checks apart from ignored ones; if no build has run 30 minutes after a push, the review waits for me instead.',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
  }),
  autoFollowupOnReRequest: def({
    group: 'Reviews',
    label: 'Follow-up review when my review is re-requested',
    help: 'Also writes an unsent review draft again when the PR is pushed to while the request is open.',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
  }),
  reviewGuidelines: def({
    group: 'Reviews',
    label: 'Review guidelines',
    help: 'Inserted into the agent prompt for reviews.',
    type: 'text',
    schema: z.string().min(1),
    default: DEFAULT_REVIEW_GUIDELINES,
  }),
  smallChangeRubric: def({
    group: 'My PRs',
    label: 'What counts as a small change',
    help: 'Small items are fixed and pushed without asking me. Inserted into the agent prompt.',
    type: 'text',
    schema: z.string().min(1),
    default: DEFAULT_RUBRIC,
  }),
  maxCiAttempts: def({
    group: 'My PRs',
    label: 'Automatic CI fix attempts',
    help: 'After that, CI failures become proposals.',
    type: 'number',
    schema: z.number().int().min(0).max(10),
    default: 2,
  }),
  batchQuietMinutes: def({
    group: 'My PRs',
    label: 'Batch quiet time (minutes)',
    help: 'A complete batch is pushed only after no new activity for this long.',
    type: 'number',
    schema: z.number().int().min(0).max(120),
    default: 2,
  }),
  waitingNudgeDays: def({
    group: 'My PRs',
    label: 'Follow up after (active days)',
    help: 'A PR of mine that waits on others without any activity on GitHub for this many active days (see "Polling") moves to "Needs me", so that I nudge the reviewers. Drafts are left out. 0 switches it off.',
    type: 'number',
    schema: z.number().int().min(0).max(60),
    default: 3,
  }),
  resolveThreads: def({
    group: 'My PRs',
    label: 'Resolve threads after replying',
    type: 'enum',
    options: [
      { value: 'fixed_and_skipped_with_reason', label: 'Fixed and rejected' },
      { value: 'fixed', label: 'Fixed only' },
      { value: 'never', label: 'Never' },
    ],
    schema: z.enum(['fixed_and_skipped_with_reason', 'fixed', 'never']),
    default: 'fixed_and_skipped_with_reason' as 'fixed_and_skipped_with_reason' | 'fixed' | 'never',
  }),
  replyHeader: def({
    group: 'My PRs',
    label: 'Header of automatic replies',
    help: 'Put above replies I never saw. {viewer} becomes my login. Empty for none.',
    type: 'string',
    schema: z.string(),
    default: '🤖 **Claude on behalf of @{viewer}**',
  }),
  autoRemoveMergedWorktrees: def({
    group: 'My PRs',
    label: 'Remove worktrees of merged PRs automatically',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
  }),
  autonomy: def({
    group: 'Autonomy',
    label: 'Let the agent decide on its own, with a self-review before every push',
    help: 'Off: the agent pre-decides only small changes, as described under "My PRs". On: every proposal carries a risk class and a confidence, the limits below say what the agent may decide, and a second, read-only agent session reviews each batch before it is pushed.',
    type: 'boolean',
    schema: z.boolean(),
    default: false,
  }),
  autonomyContained: def({
    group: 'Autonomy',
    label: 'Contained changes: the agent decides',
    help: 'Changes of behavior inside the topic of the PR, without touching a public API, a schema, the build or dependencies.',
    type: 'enum',
    options: THRESHOLDS,
    schema: threshold,
    default: 'never' as Threshold,
  }),
  autonomyStructural: def({
    group: 'Autonomy',
    label: 'Structural changes: the agent decides',
    help: 'Changes to a public API, a database schema, the build, dependencies, security-relevant code or files outside the topic of the PR.',
    type: 'enum',
    options: THRESHOLDS,
    schema: threshold,
    default: 'never' as Threshold,
  }),
  decisionNotes: def({
    group: 'Autonomy',
    label: 'Additional guidance for decisions',
    help: 'Appended to the risk classes in the agent prompt, for example what I never want decided without me.',
    type: 'text',
    schema: z.string(),
    default: '',
  }),
  selfReviewPrompt: def({
    group: 'Autonomy',
    label: 'Self-review prompt',
    help: 'System prompt of the reviewing session. {{RISK_CLASSES}} becomes the risk classes the working agent uses.',
    type: 'text',
    schema: z.string().min(1),
    default: DEFAULT_SELF_REVIEW,
  }),
  selfReviewModel: def({
    group: 'Autonomy',
    label: 'Self-review model',
    help: 'Empty for the model of the working agent.',
    type: 'string',
    schema: z.string(),
    default: '',
  }),
  allowedTools: def({
    group: 'Agent',
    label: 'Allowed tools',
    help: 'One Claude Code permission rule per line. Pushing, gh, curl and wget stay denied regardless, and agents never get GitHub credentials.',
    type: 'list',
    schema: z.array(z.string().min(1)),
    default: ['Read', 'Glob', 'Grep', 'TodoWrite', 'Bash(git *)', 'Bash(./gradlew *)', 'Bash(pnpm *)', 'Bash(nix develop *)'],
  }),
  maxParallelSessions: def({
    group: 'Agent',
    label: 'Parallel sessions',
    help: 'More than one can make builds collide, for example on Gradle daemons or ports. Never two on the same PR.',
    type: 'number',
    schema: z.number().int().min(1).max(8),
    default: 1,
  }),
  model: def({
    group: 'Agent',
    label: 'Model',
    help: 'Empty for the Claude Code default, otherwise a model name or alias such as opus.',
    type: 'string',
    schema: z.string(),
    default: '',
  }),
  maxTurns: def({ group: 'Agent', label: 'Max turns per run', type: 'number', schema: z.number().int().min(1).max(2000), default: 200 }),
  maxBudgetUsd: def({
    group: 'Agent',
    label: 'Max budget per run (USD)',
    type: 'number',
    schema: z.number().min(0.1).max(1000),
    default: 25,
  }),
  notify: def({
    group: 'Notifications',
    label: 'Desktop notifications for',
    type: 'multi',
    options: [
      { value: 'input', label: 'Proposals and questions waiting' },
      { value: 'review_draft', label: 'Review draft ready' },
      { value: 'blocked', label: 'Blocked PRs' },
      { value: 'error', label: 'Errors' },
    ],
    schema: z.array(z.enum(NOTIFY_EVENTS)),
    default: [...NOTIFY_EVENTS] as NotifyEvent[],
  }),
};

export type SettingKey = keyof typeof DEFS;
type SettingValue<K extends SettingKey> = (typeof DEFS)[K]['default'];

const isKey = (k: string): k is SettingKey => Object.hasOwn(DEFS, k);

let db: Db | undefined;
let nix: Partial<Record<SettingKey, unknown>> = {};
const cache = new Map<SettingKey, unknown>();

/** Loads the Nix settings file and binds overrides to the database. */
export function initSettings(database: Db | undefined, nixFile = process.env.PR_MANAGER_SETTINGS) {
  db = database;
  nix = {};
  cache.clear();
  if (!nixFile) return;
  const raw = JSON.parse(readFileSync(nixFile, 'utf8')) as Record<string, unknown>;
  for (const [k, v] of Object.entries(raw)) {
    if (!isKey(k)) {
      console.warn(`settings: unknown Nix setting ${k} ignored`);
      continue;
    }
    const parsed = DEFS[k].schema.safeParse(v);
    if (parsed.success) nix[k] = parsed.data;
    else console.warn(`settings: invalid Nix value for ${k} ignored: ${parsed.error.issues[0]?.message}`);
  }
}

function override(key: SettingKey): { ok: true; value: unknown } | { ok: false } {
  const raw = db?.kvGet(`setting:${key}`);
  if (raw === undefined) return { ok: false };
  const parsed = DEFS[key].schema.safeParse(JSON.parse(raw));
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

export function setting<K extends SettingKey>(key: K): SettingValue<K> {
  if (!cache.has(key)) {
    const o = override(key);
    cache.set(key, o.ok ? o.value : key in nix ? nix[key] : DEFS[key].default);
  }
  return cache.get(key) as SettingValue<K>;
}

/** Saves dashboard overrides; throws with the first validation message on bad input. */
export function saveOverrides(values: Record<string, unknown>) {
  const valid: [SettingKey, unknown][] = [];
  for (const [k, v] of Object.entries(values)) {
    if (!isKey(k)) throw new Error(`Unknown setting ${k}.`);
    const parsed = DEFS[k].schema.safeParse(v);
    if (!parsed.success) throw new Error(`${DEFS[k].label}: ${parsed.error.issues[0]?.message}`);
    valid.push([k, parsed.data]);
  }
  if (!db) throw new Error('Settings are not initialized.');
  for (const [k, v] of valid) db.kvSet(`setting:${k}`, JSON.stringify(v));
  cache.clear();
  bus.emit('settings');
}

export function resetOverride(key: string) {
  if (!isKey(key)) throw new Error(`Unknown setting ${key}.`);
  db?.run('DELETE FROM kv WHERE key = ?', `setting:${key}`);
  cache.clear();
  bus.emit('settings');
}

export function describeSettings(): Setting[] {
  return (Object.keys(DEFS) as SettingKey[]).map((key) => {
    const d = DEFS[key];
    const o = override(key);
    return {
      key,
      group: d.group,
      label: d.label,
      help: d.help ?? null,
      type: d.type,
      options: d.options ?? null,
      value: setting(key),
      source: o.ok ? 'override' : key in nix ? 'nix' : 'default',
      nixValue: key in nix ? nix[key] : null,
      defaultValue: d.default,
    };
  });
}

/** Values only Home Manager can change, shown read-only on the settings page. */
export function describeNixOnly(): NixOnly[] {
  return [
    { label: 'Port', value: String(config.port), option: 'services.pr-manager.port' },
    { label: 'Checkout root', value: config.srcRoot, option: 'services.pr-manager.checkoutRoot' },
    { label: 'Worktree directory', value: config.worktreeDir, option: 'services.pr-manager.worktreeDir' },
    { label: 'State directory', value: config.stateDir, option: 'services.pr-manager.stateDir' },
    {
      label: 'MCP servers for agents',
      value: Object.keys(extraMcpServers()).join(', ') || 'none',
      option: 'services.pr-manager.mcpServers',
    },
  ];
}

export function inPollWindow(now = new Date()): boolean {
  const h = now.getHours();
  return setting('pollDays').includes(now.getDay()) && h >= setting('pollFromHour') && h < setting('pollToHour');
}

const promptFile = (name: string) => readFileSync(join(config.promptDir, name), 'utf8').trim();

/** The risk classes, one source for the working agent and the self-review. */
export const riskClasses = () => promptFile('risk-classes.md').replace('{{SMALL_CHANGE_RUBRIC}}', setting('smallChangeRubric'));

/** A prompt text with the configurable rubric, review guidelines and tool allowlist filled in. */
export const fillPrompt = (template: string) =>
  template
    .replace('{{SMALL_CHANGE_RUBRIC}}', setting('smallChangeRubric'))
    .replace('{{REVIEW_GUIDELINES}}', setting('reviewGuidelines'))
    .replace(
      '{{ALLOWED_TOOLS}}',
      setting('allowedTools')
        .map((t) => `- \`${t}\``)
        .join('\n'),
    );

/** The rules for classified decisions, which follow the workflow of my own PRs with the `autonomy` setting. */
function autonomyPrompt(): string {
  const notes = setting('decisionNotes').trim();
  return promptFile('autonomy.md')
    .replace('{{RISK_CLASSES}}', riskClasses())
    .replace('{{DECISION_NOTES}}', notes ? `Additional guidance from me:\n\n${notes}` : '')
    .trim();
}

/**
 * The system prompt of a session: what holds for every PR (`workflow.md`), then the part of the PR's role
 * (`roleFile`), then, when `autonomy` is given, the rules for deciding alone.
 */
export function workflowPrompt(roleFile: string, autonomy = false): string {
  const parts = [promptFile('workflow.md'), promptFile(roleFile)].map(fillPrompt);
  if (autonomy) parts.push(autonomyPrompt());
  return `${parts.join('\n\n')}\n`;
}

export const selfReviewPrompt = () => setting('selfReviewPrompt').replace('{{RISK_CLASSES}}', riskClasses());

/** What the agent may decide on its own above small changes. */
export const autonomyLimits = (): Limits => ({ contained: setting('autonomyContained'), structural: setting('autonomyStructural') });

export const isExcluded = (repo: string) => setting('excludedRepos').some((r) => r.toLowerCase() === repo.toLowerCase());

/** The build rules of one repository, for `buildState`. */
export function buildRules(repo: string) {
  const perRepo = Object.entries(setting('minSuccessfulChecksPerRepo')).find(([r]) => r.toLowerCase() === repo.toLowerCase());
  return { ignored: setting('ignoredChecks'), minSuccessful: perRepo?.[1] ?? setting('minSuccessfulChecks') };
}

// --- Denied tool calls, kept for the settings page ---------------------------------------

/** The narrowest useful allow rule for a denied call: Bash by its first command word. */
export function proposeRule(tool: string, detail: string): string {
  if (tool !== 'Bash') return tool;
  const words = detail
    .trim()
    .split(/\s+/)
    .filter((w) => !/^\w+=/.test(w));
  const first = words[0] ?? '';
  return first ? `Bash(${first} *)` : 'Bash';
}

export function recordDenied(call: Omit<DeniedCall, 'rule'>) {
  if (!db) return;
  const list = deniedCalls();
  list.unshift({ ...call, rule: proposeRule(call.tool, call.detail) });
  db.kvSet('deniedTools', JSON.stringify(list.slice(0, 100)));
}

export function deniedCalls(): DeniedCall[] {
  const raw = db?.kvGet('deniedTools');
  return raw ? (JSON.parse(raw) as DeniedCall[]) : [];
}

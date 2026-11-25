<!-- FOR AI AGENTS - Human readability is a side effect, not a goal -->
<!-- Last updated: 2026-11-11 | Last verified: 2026-11-11 -->

# AGENTS.md

pr-manager: a local daemon (Node, TypeScript without a build step) plus an Angular dashboard. It polls GitHub for the user's PRs, runs one persistent Claude Agent SDK session per PR in its own git worktree, and pushes/replies on GitHub itself. User-facing behavior: [README.md](README.md).

## Commands

All commands need the dev shell (Node 22, pnpm, claude-code). Prefix with `nix develop -c` outside of it.

| Task | Command | ~Time |
|------|---------|-------|
| Install | `pnpm install` (one pnpm workspace: root + `web`; npm is refused) | ~15s |
| Typecheck server + tests | `pnpm check` | ~5s |
| Test (all) | `pnpm test` | ~1s |
| Test (one file) | `node --disable-warning=ExperimentalWarning --test test/batch.test.ts` | ~1s |
| Typecheck web | `cd web && pnpm exec tsc --noEmit -p tsconfig.app.json` | ~10s |
| Build web | `pnpm --filter web exec ng build` | ~30s |
| Format (whole repo) | `pnpm format` (Prettier from the root `package.json`; config in `.prettierrc.json`) | ~5s |
| Check formatting | `pnpm format:check` | ~5s |
| Test coverage | `pnpm test:coverage` | ~2s |
| Run daemon | `pnpm start` (port 8020, serves `web/dist`) | — |
| Web dev server | `pnpm --filter web exec ng serve` (port 4200, proxies `/api`) | — |
| Nix package | `nix build` | minutes |

CI ([.github/workflows/check.yml](.github/workflows/check.yml)) runs `pnpm check`, `pnpm test`, `pnpm format:check` (Prettier over the whole repository) and `nix build`, all through Nix, on push to `main` and on PRs. Before claiming done: `pnpm check && pnpm test`, `pnpm format`, plus the web typecheck when `web/` changed.

## Architecture

The server is layered. A module imports only from its own layer or a lower one; `test/architecture.test.ts` enforces this, the absence of import cycles, and that only `roles/` compares `pr.role`. A new file has to be added to the layer list in that test.

| Layer | Modules | Responsibility |
|-------|---------|----------------|
| Entry points | `main.ts`, `cli.ts` | Wiring: db, settings, poller, runner, HTTP server; `pr-manager pause\|resume` CLI |
| Interface | `http.ts` | JSON API + SSE (`/api/events`) + static web files; routes only call the layers below |
| Drivers | `poller.ts`, `runner.ts` | Poller: GitHub search → `prs` rows, cleanup. Runner: picks queued `work_items`, preflights the worktree, runs sessions. Neither imports the other; the poller wakes the runner with `bus.emit('wake')` |
| Roles | `roles/` | What differs between my own PRs and the PRs I review (see below) |
| Base | `prs.ts`, `agent-tools.ts` | What every PR has: block, pause, instruction, answers, cleanup of worktree and session; the MCP server `pr` with the tools of every PR (`get_pr`, `set_summary`, `ask`, `withdraw_question`, `report_blocked`) |
| Infrastructure | `config.ts`, `db.ts`, `settings.ts`, `git.ts`, `github.ts`, `notify.ts`, `excerpt.ts`, `util.ts` | Env config; SQLite schema, migrations, query helpers; settings (`DEFS`, precedence dashboard override > Nix file > default, prompt templating, denied tool calls); git via `execFile` (worktrees, sync, rebase, push, per-repo serialization); GraphQL/REST client; desktop notifications; event bus |
| Rules | `batch.ts`, `checklist.ts` | Pure functions: batch open/closable, reply text, thread resolving, autonomy limits, self-review outcome, veto window; Markdown task lists. No database, no settings, no clock: callers pass the values |
| Model | `model.ts` | Row types, state machines and API payload types. Types only and no imports, because the web app compiles it too |

### Roles

Both kinds of PR share one foundation: the `prs` row, worktree, agent session, work queue, questions, instructions, pausing, blocking and cleanup. Only what differs is in `roles/`, behind the `Role` interface (`roles/role.ts`): hooks for the poll, the worktree sync, the run (prompt, tools, bookkeeping), and the dashboard (group, summary, routes). Outside `roles/`, code asks `roleOf(pr)` and never compares `pr.role`.

| Path | Responsibility |
|------|----------------|
| `roles/role.ts`, `roles/index.ts` | The `Role` interface; the registry `roles` and `roleOf` |
| `roles/own.ts` | Role of my own PRs: poll hooks, run hooks, self-review, dashboard hooks |
| `roles/own-ingest.ts` | GitHub activity → `comments` rows + `work_items` |
| `roles/own-batch.ts` | Batch items (`openBatch`, `addConflict`), dashboard decisions, and the daemon-side GitHub writes of `closeBatch` (rebase, push, replies, resolve, checkbox) |
| `roles/own-tools.ts` | MCP tools `mark_fixed`, `dismiss`, `propose`, `reply` |
| `roles/review.ts` | Role of PRs I review: poll hooks, run hooks, `submitReview`, dashboard hooks |
| `roles/review-tools.ts` | MCP tools `add_review_finding`, `set_review_verdict`, `draft_thread_reply` |

A new kind of PR is a new `Role` implementation registered in `roles/index.ts`, a `RoleName`, a table for its columns in `db.ts` (`ROLE_TABLES`), a prompt file and a component in `web/src/app/`. New behavior of one role goes into its module; behavior of every PR goes into the base.

### Other paths

| Path | Responsibility |
|------|----------------|
| `prompts/workflow.md` | System prompt of every agent session; `{{…}}` placeholders filled in `settings.ts` `fillPrompt` |
| `prompts/own.md`, `prompts/review.md` | The part of each role, appended to `workflow.md` (`workflowPrompt`); a session gets only its role's part |
| `prompts/autonomy.md`, `prompts/risk-classes.md` | Appended to the prompt of my own PRs only with the `autonomy` setting; the risk classes also go into the self-review prompt (setting `selfReviewPrompt`) |
| `web/src/app/` | Angular standalone components: `overview.ts`, `settings.ts`, `transcript.ts`; `pr-page.ts` is the frame of a PR page, `own-pr.ts` and `review-pr.ts` fill its regions per role; `api.ts` re-exports the API types from `server/model.ts` |
| `nix/module.nix`, `nix/package.nix` | Home Manager module (systemd user service) and package |
| `test/` | `node:test` tests, one file per server module, plus `architecture.test.ts` |

## Database

`prs` holds what every PR has; `own_prs` and `review_prs` hold the columns of one role, one row per PR of that role. Read PRs through `db.pr`, `db.prs` or `db.prsWhere` (the view `pr_view` joins the three), write them through `db.insertPr` and `db.updatePr`, which put each column into its table and throw on a column of the other role.

## Flow

1. Poller: search → upsert `prs` → `Role.reconcile` (what I did on GitHub directly, such as a review) → `Role.polled`. For my own PRs, `ingest` adds `comments` rows (kinds in `CommentKind`) and enqueues a `work_items` row; for reviews, a `review` item is enqueued.
2. Runner: one queued kind set per PR → `preflight` (worktree, interactive session check, `Role.syncWorktree`) → `Role.runQueued` for work without the working session (push, self-review) → `query()` with the `pr` MCP server.
3. Agent: changes code, amends, reports via MCP tools. Comment states: `new → fixed | proposal | done`, `proposal → accepted | skipped` (dashboard), `accepted → fixed`.
4. With `autonomy`: before the push, `closeBatch` enqueues `self_review`; `selfReview` in `roles/own.ts` reviews the batch diff in a fresh read-only session (`readOnlySession` of the runner), and `pushAllowed` in `roles/own-batch.ts` lets the push through only after a passed review of exactly that HEAD and, for a batch the agent decided alone, the veto window.
5. Batch closes (quiet time elapsed, nothing open): `closeBatch` rebases, pushes with `--force-with-lease`, posts replies, resolves threads, sets comments `done`. A failed rebase becomes a `conflict` item and reopens the batch.

State machines and their meaning are documented next to the types in `server/model.ts`. Read them before changing a state transition.

## Rules

- **Erasable TypeScript only** (`erasableSyntaxOnly`): no `enum`, `namespace`, parameter properties. Relative imports end in `.ts`.
- **Agents never get credentials.** Every GitHub write and every push lives in `roles/own-batch.ts`, `roles/review.ts` or `git.ts` and runs in the daemon. Do not add network paths for agents; keep `agentEnv` and `DENY` in `runner.ts` intact.
- **New setting:** add it to `DEFS` in `settings.ts`, add the key to the `settings` description in `nix/module.nix`, and mention it in the README configuration list.
- **New DB column:** add it to the `CREATE TABLE` of the table it belongs to (base or role), to `ADDED_COLUMNS` in `db.ts`, to the row interface in `model.ts`, and for a role table to its column list (`OWN_COLUMNS`, `REVIEW_COLUMNS`). The web app gets the type through `model.ts`.
- **Agent behavior:** change the prompt files (`workflow.md` for every session, `own.md` or `review.md` for one role), the MCP tool descriptions in `agent-tools.ts` and `roles/*-tools.ts`, or the per-run text in `Role.prompt`. The prompt speaks as the user ("I", "my PRs").
- **Dependencies:** ask first. The Agent SDK `0.3.N` must match `claude-code` `2.1.N` of the pinned nixpkgs. Use pnpm only. `pnpm-workspace.yaml` holds the supply-chain rules (`minimumReleaseAge` of 7 days, install scripts only for `allowBuilds`); do not loosen them without asking. After changing dependencies, update both `fetchPnpmDeps` `hash` values in `nix/package.nix`.
- **Tests:** pure functions and database transitions, `node:assert/strict`, `openDb(':memory:')` when a db is needed. No mocks of GitHub or the SDK; code that talks to them takes the fetched data as a parameter where it should be testable (`ingest`). `pnpm test:coverage` shows what the tests reach.
- **Style:** match surrounding code; short JSDoc that explains why, not what. US English everywhere.

## Commits

- Conventional Commits, scope optional: `feat:`, `fix:`, `fix(module):`, `feat(web):`, `chore:`. Subject in plain language describing user-visible behavior.
- Linear history on `main`, no merge commits.
- Update README.md in the same commit when user-visible behavior changes.

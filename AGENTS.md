<!-- FOR AI AGENTS - Human readability is a side effect, not a goal -->
<!-- Last updated: 2026-10-29 | Last verified: 2026-10-29 -->

# AGENTS.md

pr-manager: a local daemon (Node, TypeScript without a build step) plus an Angular dashboard. It polls GitHub for the user's PRs, runs one persistent Claude Agent SDK session per PR in its own git worktree, and pushes/replies on GitHub itself. User-facing behavior: [README.md](README.md).

## Commands

All commands need the dev shell (Node 22, claude-code). Prefix with `nix develop -c` outside of it.

| Task | Command | ~Time |
|------|---------|-------|
| Install | `npm ci && (cd web && npm ci)` | ~30s |
| Typecheck server + tests | `npm run check` | ~5s |
| Test (all) | `npm test` | ~1s |
| Test (one file) | `node --disable-warning=ExperimentalWarning --test test/batch.test.ts` | ~1s |
| Typecheck web | `cd web && npx tsc --noEmit -p tsconfig.app.json` | ~10s |
| Build web | `cd web && npx ng build` | ~30s |
| Format web | `cd web && npx prettier --write src` | ~5s |
| Run daemon | `npm start` (port 8020, serves `web/dist`) | — |
| Web dev server | `cd web && npx ng serve` (port 4200, proxies `/api`) | — |
| Nix package | `nix build` | minutes |

CI ([.github/workflows/check.yml](.github/workflows/check.yml)) runs `npm run check`, `npm test`, `prettier --check` on `web/src` and `nix build`, all through Nix, on push to `main` and on PRs. Before claiming done: `npm run check && npm test`, plus the web typecheck and format when `web/` changed.

## File map

| Path | Responsibility |
|------|----------------|
| `server/main.ts` | Wiring: db, settings, poller, runner, HTTP server |
| `server/config.ts` | Home Manager-only values from env vars (port, paths) |
| `server/settings.ts` | Behavior settings: `DEFS` (zod schema, default, UI metadata); precedence dashboard override > Nix file > default; prompt templating; denied tool calls |
| `server/db.ts` | SQLite schema, row interfaces, state comments, column migrations, query helpers |
| `server/poller.ts` | GitHub search → `prs` rows; `ingest` turns activity into `comments` rows + `work_items`; cleanup of merged/ignored PRs |
| `server/runner.ts` | Picks queued `work_items`, preflights the worktree, runs the agent session, post-run bookkeeping |
| `server/agent-tools.ts` | In-process MCP server `pr`: the only way an agent reports results (`mark_fixed`, `propose`, `ask`, `add_review_finding`, …) |
| `server/actions.ts` | Batch items (`openBatch`, `addConflict`) and daemon-side GitHub writes: `closeBatch` (rebase, push, replies, resolve, checkbox), `submitReview`, dashboard decisions |
| `server/batch.ts` | Pure batch rules: open/closable, reply text, thread resolving |
| `server/checklist.ts` | Pure Markdown task-list parsing and checking |
| `server/git.ts` | git via `execFile`; worktrees, sync, rebase, push; `Blocked` error; per-repo serialization |
| `server/github.ts` | GraphQL/REST client with `gh auth token`; PR queries; pure helpers |
| `server/http.ts` | JSON API + SSE (`/api/events`) + static web files; dashboard grouping |
| `server/cli.ts` | `pr-manager pause|resume` CLI, talks to the HTTP API |
| `server/util.ts` | Event bus, `run`, desktop notifications |
| `prompts/workflow.md` | System prompt appended for every agent session; `{{…}}` placeholders filled in `settings.ts` `workflowPrompt` |
| `web/src/app/` | Angular standalone components: `overview.ts`, `pr-page.ts`, `settings.ts`, `transcript.ts`; `api.ts` holds the API types (hand-copied from `server/db.ts`) |
| `nix/module.nix`, `nix/package.nix` | Home Manager module (systemd user service) and package |
| `test/` | `node:test` tests of pure logic, one file per server module |

## Flow

1. Poller: search → upsert `prs` → `ingest` adds `comments` rows (kinds in `CommentKind`) and enqueues a `work_items` row.
2. Runner: one queued kind set per PR → `preflight` (worktree, interactive session check, `sync`) → `query()` with the `pr` MCP server.
3. Agent: changes code, amends, reports via MCP tools. Comment states: `new → fixed | proposal | done`, `proposal → accepted | skipped` (dashboard), `accepted → fixed`.
4. Batch closes (quiet time elapsed, nothing open): `closeBatch` rebases, pushes with `--force-with-lease`, posts replies, resolves threads, sets comments `done`. A failed rebase becomes a `conflict` item and reopens the batch.

The runner depends on the poller, never the other way round: the poller wakes the runner with `bus.emit('wake')`.

State machines and their meaning are documented next to the types in `server/db.ts`. Read them before changing a state transition.

## Rules

- **Erasable TypeScript only** (`erasableSyntaxOnly`): no `enum`, `namespace`, parameter properties. Relative imports end in `.ts`.
- **Agents never get credentials.** Every GitHub write and every push lives in `actions.ts`/`git.ts` and runs in the daemon. Do not add network paths for agents; keep `agentEnv` and `DENY` in `runner.ts` intact.
- **New setting:** add it to `DEFS` in `settings.ts`, add the key to the `settings` description in `nix/module.nix`, and mention it in the README configuration list.
- **New DB column:** add it to the `CREATE TABLE`, to the `migrations` list in `openDb`, to the row interface in `db.ts`, and to `web/src/app/api.ts` if the UI reads it.
- **Agent behavior:** change `prompts/workflow.md`, MCP tool descriptions in `agent-tools.ts`, or the per-run text in `runner.ts` `prompt()`. The prompt speaks as the user ("I", "my PRs").
- **Dependencies:** ask first. The Agent SDK `0.3.N` must match `claude-code` `2.1.N` of the pinned nixpkgs. After `npm install`, run `npm run lock:strip`, then update both `npmDepsHash` values in `nix/package.nix`.
- **Tests:** pure functions only, `node:assert/strict`, `openDb(':memory:')` when a db is needed. No mocks of GitHub or the SDK.
- **Style:** match surrounding code; short JSDoc that explains why, not what. US English everywhere.

## Commits

- Conventional Commits, scope optional: `feat:`, `fix:`, `fix(module):`, `feat(web):`, `chore:`. Subject in plain language describing user-visible behavior.
- Linear history on `main`, no merge commits.
- Update README.md in the same commit when user-visible behavior changes.

# pr-manager

A local daemon with a dashboard for my GitHub pull requests: the ones I authored and the ones where my review is requested. Every PR gets its own git worktree and one persistent ("sticky") Claude agent session, run through the Claude Agent SDK.

- **My PRs:** review comments and failed CI runs become work items.
  - Small, unambiguous fixes are applied without me.
  - Anything bigger becomes an editable proposal on the dashboard, and open questions are asked there too.
  - I accept or skip proposals and answer questions, then submit them all at once, like a GitHub review.
  - When every item is fixed or skipped, the daemon rebases, pushes once with `--force-with-lease`, posts the replies and resolves the threads.
  - Every unchecked checklist line (`- [ ] ...`) in a comment is an item of its own, and a box checked on GitHub closes it. When the batch closes, the daemon checks off fixed lines. A comment of nothing but checklist lines gets no reply, because the checked box is the answer.
- **PRs I review:** the agent writes one review draft with findings and a suggested verdict. I edit and submit it.
  - New commits mark the review as out of date.
  - A follow-up review runs on demand, or automatically when my review is re-requested.
- **Notifications:** a desktop notification appears when I am needed: a proposal or question waits, a review draft is ready, a PR is blocked, or something failed.

## How it works

- **Poller:** every 2 minutes, Monday to Friday, 07:00 to 18:00, it runs two GitHub searches: `author:@me` and `review-requested:@me`, the latter including team requests. Known PRs are also looked up by URL. Only changed PRs get a detail fetch, and only new activity starts an agent.
- **Runner:** one session at a time by default, so builds and tests never collide; never two on the same PR.
  - Each PR's session is resumed by its stored id, with the worktree as working directory.
  - Before a run, the daemon fetches and checks the worktree. A PR is blocked when the worktree has changes it did not make, when an interactive Claude session works in it, or when someone pushed during an open batch.
- **No network for agents:** sessions get no GitHub token, no SSH agent, no credential helper and an empty gh config. Pushing, posting and resolving are daemon actions that run only when a batch closes. Tools outside the allowlist are denied and shown in the transcript.
- **Cleanup:** merged PRs have their worktree removed automatically, unless it holds uncommitted or unpushed work or an interactive session. Closed PRs keep their worktree until I remove it on the dashboard.

Worktrees live at `~/SC/github/<org>/<repo>.worktrees/<branch-with-dash>`. Clones are created at `~/SC/github/<org>/<repo>` when missing.

## Configuration

Settings come in two kinds:

- **Home Manager only:** `port`, `checkoutRoot`, `worktreeDir`, `stateDir`, `extraPackages`, `tokenAttributes`. The daemon needs these before it starts, or changing them would move files.
- **Behavior settings:** set defaults with `services.pr-manager.settings`, and change them at runtime on the dashboard's settings page (<http://127.0.0.1:8020/settings>). A change there overrides the Home Manager value until you press Reset.
  - Polling: interval, active days and hours.
  - Scope: both search queries, excluded repositories.
  - Reviews: wait for a green build, automatic follow-up, review guidelines.
  - My PRs: the small-change rubric, CI fix attempts, batch quiet time, thread resolving, reply header, auto-removal of merged worktrees.
  - Agent: allowed tools, parallel sessions, model, turn and budget limits.
  - Notifications: which events notify.

```nix
services.pr-manager = {
  enable = true;
  extraPackages = [ pkgs.pnpm ];
  settings = {
    pollIntervalMinutes = 5;
    reviewQuery = "is:pr is:open archived:false user-review-requested:@me";
    excludedRepos = [ "fntsoftware/some-repo" ];
  };
};
```

Some things stay fixed on purpose:
- Agents never get GitHub credentials.
- Pushing, `gh`, `curl` and `wget` are denied even if the allowlist permits them.
- The dashboard binds to 127.0.0.1 only.

## Taking over a PR manually

Pause the agent before working in a worktree yourself:

```sh
pr-manager pause            # inside the worktree
pr-manager resume
```

The dashboard has the same buttons. An interactive Claude session in a worktree blocks the agent anyway, as a safety net.

## Setup (Home Manager)

```nix
# flake input
inputs.pr-manager.url = "github:daniel-leib-fnt/pr-manager";

# Home Manager module
{ inputs, ... }: {
  imports = [ inputs.pr-manager.homeManagerModules.default ];
  services.pr-manager.enable = true;
}
```

The service reads the Claude OAuth token from the Secret Service. Create it once with `claude setup-token`, then store it with the attribute `service=pr-manager`, for example in KeePassXC. GitHub access uses `gh auth token`.

The dashboard runs at <http://127.0.0.1:8020>. Logs go to `journalctl --user -u pr-manager`.

## Development

```sh
nix develop
npm ci && (cd web && npm ci)
npm run check && npm test
(cd web && npx ng build)
npm start                   # daemon on :8020, serves web/dist
(cd web && npx ng serve)    # UI dev server on :4200, proxies /api
```

The Agent SDK version must match the `claude-code` version of the pinned nixpkgs: SDK `0.3.N` belongs to `claude-code` `2.1.N`. After `npm install`, run `npm run lock:strip`. It removes the SDK's bundled native binaries from the lockfile, because the daemon uses the Nix `claude-code` and fetchNpmDeps would otherwise download them for every platform. Then update the `npmDepsHash` values in `nix/package.nix`.

The server is TypeScript run directly by Node through type stripping, so there is no build step. Only erasable syntax is allowed.

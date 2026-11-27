# pr-manager

A local daemon with a dashboard for my GitHub pull requests: the ones I authored and the ones where my review is requested. Every PR gets its own git worktree and one persistent ("sticky") Claude agent session, run through the Claude Agent SDK.

- **My PRs:** review comments and failed CI runs become work items.
  - The agent triages every comment into a decision but changes no code yet. Small, unambiguous fixes, answers and clarifying replies it pre-decides itself; anything bigger becomes an editable proposal for me, and open questions are asked on the dashboard too.
  - When nothing waits for me, the pre-decisions take effect right away and the agent applies them in one run. Otherwise the Decisions tab of the PR page lists every decision that is open, waits for its push or is with the agent: open ones expanded, pre-decided ones folded with an "Agent" tag. I can change a pre-decision; the tag then disappears.
  - I decide and answer, then submit all decisions at once, pre-decided ones included, like a GitHub review. Choosing a decision folds its card and moves to the next open one. Accept: the agent implements the proposal and the thread is resolved. Reject: no code change, a reply declines it and the thread is resolved. Reply: no code change, a reply only, and the thread stays open. Skip: nothing is posted and nothing is resolved.
  - The reply field of a proposal is optional. Text I type there is posted as is; left empty, the agent writes the reply after my decision, following the notes I leave in the proposal, and it carries the reply header.
  - When every item is fixed, rejected or skipped, the daemon rebases, pushes once with `--force-with-lease`, posts the replies and resolves the threads.
  - Every unchecked checklist line (`- [ ] ...`) in a comment is an item of its own, and a box checked on GitHub closes it. When the batch closes, the daemon checks off fixed lines. A comment of nothing but checklist lines gets no reply, because the checked box is the answer.
  - A PR with a checklist line that is not checked off yet, and a PR with my open final review, carries an "Open Tasks" tag in the list and on its page. A line the agent answered without checking its box (a declined suggestion) no longer counts once the batch is closed.
  - When someone other than the daemon pushes to the branch, for example me by hand, open proposals go back to the agent. It judges them against the new head: what the push settles becomes "Already done" with a reply that says so, and a question the push settles is withdrawn.
  - When GitHub reports merge conflicts, the agent rebases onto the base branch and resolves mechanical conflicts; the batch then pushes the result. A conflict that needs a decision becomes a proposal.
  - As soon as GitHub allows merging a PR by the repository's own rules, and nothing is open in pr-manager, it moves to the top section "Ready to merge". If it loses that state, for example through a new review or a failed required check, the daemon reads it again right away.
  - GitHub, not pr-manager's own bookkeeping, decides whether a thread still waits for me: a thread that is not resolved and whose last comment is someone else's keeps the PR in "Needs me" once pr-manager handles none of its items any more, for example after a Skip or after the agent dismissed it. The "Needs me" list of the PR page links these threads; answering or resolving them on GitHub clears them on the next poll.
  - A PR in "Waiting on others" shows since when it waits: its last activity on GitHub, or my last follow-up. When a PR of mine that is ready for review has had no activity for `waitingNudgeDays` active days (default 3), it moves to "Needs me" with a "Follow up" tag; after I nudge the reviewers, "Followed up" restarts the wait.
  - A batch pushed while the agent held commits is no dead end: the agent rebases its commits onto the pushed head like a merge conflict, and the PR is blocked only when that fails twice at the same commits.
- **Deciding on its own (opt-in):** with `autonomy` switched on, the agent decides more than small changes, and every push is reviewed first. Switched off, which is the default, nothing of this applies.
  - Every proposal that changes code carries a risk class (`local`: the small-change rubric; `contained`: a change of behavior inside the topic of the PR; `structural`: public API, schema, build, dependencies, security, files outside the topic), a confidence (high, medium, low) and a reason, all shown on the proposal. The daemon, not the agent, turns them into a decision: `local` is always the agent's, `contained` and `structural` from the confidence I set for each, and by default never.
  - Failed CI runs that need more than a small fix and merge conflicts that need a decision take the same route. After the configured number of CI fix attempts a CI failure always waits for me.
  - Before the agent asks me a question, it looks the facts up itself. With a defensible assumption it proposes the change, names the assumption, and repeats it in the reply to the reviewer. Only without one it asks.
  - When a batch is complete, a second agent session reviews its diff before the push: a fresh session without the working session's context, read-only, with no tests to run, and with its own prompt and model. It reports a verdict and its own risk class of the diff.
  - Findings it marks as fixable go back to the working agent once. Findings that need a decision, findings left after that round, a review that fails or reports nothing, and a diff it rates above what the agent may decide all put the PR under "Needs me", where I repeat the review, give an instruction, or push anyway.
  - A push with changes the agent decided alone (also small ones) is followed by a comment of mine on the PR: `* [ ] Final review by @<me>`, then one line per change with a link to the comment it answers, what changed, the agent's rating and reason, and the commit. As long as the box is open, later pushes add their lines to the same comment; once I have ticked it, the next such push opens a new one. The box is a task for me that the agent never gets as an item: while it is open, the PR stays under "Needs me" (a push that is up next still goes first), and the "Needs me" list and the "Final review" tile of the PR page link the comment. Ticking it on GitHub is enough; the next poll reads it. A comment deleted on GitHub counts as done. A batch is reviewed before its push either way, and nothing waits out a time window.
  - Items that wait for me wait without a deadline; nothing is decided because I did not answer.
- **PRs I review:** the agent writes one review draft with findings and a suggested verdict. I edit and submit it, and can skip single findings or the review body.
  - A review body is written only when the review guidelines ask for one. The default guidelines ask for it only when work spans several findings, listed as task lines.
  - New commits after a submitted review mark it as out of date; they start no new review.
  - An ignored review moves to the "Ignored" section and loses its worktree and agent session; when I stop ignoring it, both start afresh.
  - A new review runs on demand ("Review again"), or automatically when my review is re-requested. While a request is unanswered and my draft is not submitted, every push writes the draft again for the new head.
  - A follow-up review does not look at the new commits alone. It first judges every point of mine that is still open against the new head: my unresolved threads, the points in my earlier review bodies, and an unsent draft. A point the code settles gets a reply naming the commit, and its thread is resolved when I submit the review; a point settled in part is closed and replaced by a finding for what remains. Only code settles a point, not a reply.
  - A thread holds one reply draft: a later one replaces it. The draft shows each reply below the thread it answers, with the code the thread is about, and lists my open threads that got no reply, so I see what the agent left as it is. A thread that stays open on GitHub without my reply after pr-manager stopped handling it (for example one I skipped) keeps the PR in "Needs me"; I can answer or resolve it on GitHub, or hand it back to the agent with "Hand back" on the PR page, which opens its items again like new comments.
- **Follow-ups:** when the agent leaves me something to do or check that it could not, such as an assumption it did not verify, a change it could not test, or a step in another repository, it reports a follow-up besides saying so in its GitHub reply. A follow-up has a severity: `action` (I have to do or check something) keeps the PR in "Needs me" and shows in the "Needs me" list of its page until I tick it off; `info` (something I should know, nothing left to do) is a muted note on the PR page only and does not change the PR's group. Neither holds a push back.
- **Instructions:** on any PR page I can type a free-text instruction. It becomes an accepted item for the agent, and on my PRs it joins the open batch. On a PR I review, findings, a verdict or thread replies the agent writes for an instruction become a review draft I can submit. On my own PRs I can also write the instruction on GitHub as a comment of mine that starts with `pr-manager:` (any case; a leading `@` is allowed, but the plain form mentions nobody). As a conversation comment or review body it is an instruction like one from the dashboard, without a reply on GitHub; as a post in a review thread it is my accepted decision on that thread, with the text after the prefix as the version to implement, so the agent replies in the thread and the thread is resolved as usual. A comment of that kind written before pr-manager first saw the PR is kept as done and does not run, except in a thread.
- **Dashboard:** one page with the PR list on the left and the selected PR on the right. A PR page opens on an Overview tab: status tiles (build, decisions or review, push, GitHub, final review with `autonomy`, agent), each with an icon for its state: green check when done, orange exclamation mark with a tinted tile when it waits for me, blue clock when it waits for others (a pulsing dot while something runs), red cross with a tinted tile when it failed, gray dash when inactive; a "Needs me" list with every to-do and its button, the agent's summary, and for my PRs the latest activity. Beside it a Details panel shows branch, worktree and agent session, and for my PRs what waits for the push and the self-review. My PRs have the tabs Decisions and Done; Done lists finished items by day, folded, each with how it ended (Accepted, Rejected, Replied, Skipped, Fixed, Answered) and its conversation. Reviews have the tab Review draft. Activity and Agent transcript exist for both, and the instruction box is on every tab. Each list entry shows the build status (green check, pulsing yellow dot, red cross; see "Build status" below) and one line on what happens next; every section folds. A blocked PR sits in "Needs me" with a red "Blocked" tag. The browser tab icon carries a red badge with the number of PRs in "Needs me"; from ten on, the badge shows no number. Comments and findings on a file line show the surrounding code from the worktree, highlighted with Shiki for Kotlin, TypeScript, JavaScript, JSON, XML, YAML, Java, AsciiDoc, Markdown, Nix and shell scripts. `J` and `K` move through the list, `/` focuses the search, and Ctrl+Enter sends an instruction.
- **Quick filters:** the PR list filters by role (all, mine, reviews), by failing CI, hides drafts, and searches title, repo, number and author. The filters are remembered per browser; the search is not.
- **Notifications:** a desktop notification appears when I am needed: a decision or question waits, a review draft is ready, a PR is blocked, or something failed.

## How it works

- **Poller:** every 2 minutes, Monday to Friday, 07:00 to 18:00, it runs three GitHub searches: `author:@me`, `review-requested:@me` (including team requests) and `reviewed-by:@me`. Known PRs are also looked up by URL. The third search keeps PRs I reviewed directly on GitHub: such a review counts as my submitted review, so the PR stays after its request is gone, and new commits or answers in my threads mark the review out of date. Only changed PRs get a detail fetch, and only new activity starts an agent.
- **Build status:** one rule for my PRs and reviews, computed from the single checks of the head commit; required and optional checks count the same. Ignored checks (default `task-list-completed`) are checks that may never finish: they do not hold the build back while they run, but count when they fail.
  - Green: every check that is not ignored passed (success, skipped or neutral), no check failed, and at least the minimum number of them succeeded (default 1, adjustable per repository), so that a skipped bot check alone, or a few quick checks right after a push, are no build. Reviews start only on a green build.
  - No build: no check apart from ignored ones ran, or only skipped and neutral ones, for example on a branch with conflicts or a bot PR whose workflows do not run. A review that still has no build 30 minutes after the push no longer waits silently: it moves to "Needs me" with a "No build" tag, and I start it with "Review without build" or ignore the PR. A new head clears that choice.
  - Failed: a check failed and every check that is not ignored is complete; cancelled checks count as complete. On my PRs this becomes CI work. The agent gets the log of the step that failed, up to its last 200 lines, not the end of the job log, which is mostly cleanup of later steps.
  - Running: anything else, including too few successful checks, and cancelled or stale checks without a failure.
- **Runner:** one session at a time by default, so builds and tests never collide; never two on the same PR.
  - Each PR's session is resumed by its stored id, with the worktree as working directory.
  - Before a run, the daemon fetches and checks the worktree. A PR is blocked when the worktree has changes it did not make, when an interactive Claude session works in it, or when someone pushed during an open batch that would lose agent work.
  - A run interrupted by a restart is queued again, and the session is told to check its unfinished changes.
- **No network for agents:** sessions get no GitHub token, no SSH agent, no credential helper and an empty gh config. Pushing, posting and resolving are daemon actions that run only when a batch closes.
- **Tool allowlist:** the allowlist is part of the agent prompt, together with the rule that every command of a Bash call must match it, so no pipes, chains or `cd`. Denied calls appear in the transcript and on the settings page, each with a suggested allow rule.
- **Skills:** sessions load my user skills and the repository's skills and may invoke them. How to run a project's tools in its Nix dev shell is left to the `nix-develop-tools` skill from `fntsoftware/ai-hub` (`npx skills add fntsoftware/ai-hub --skill nix-develop-tools -g`); the default allowlist permits `nix develop *` for it.
- **Cleanup:** merged PRs, review requests withdrawn before I reviewed, and closed reviews have their worktree and agent session removed automatically, unless the worktree holds uncommitted or unpushed work or an interactive session. Uncommitted changes and an interactive session block the cleanup; commits that were never pushed do not: the worktree is kept, and the PR stays in "Closed" with a note until the commits are gone. My own closed PRs keep their worktree until I remove it on the dashboard.

Worktrees live at `~/SC/github/<org>/<repo>.worktrees/<branch-with-dash>`. Clones are created at `~/SC/github/<org>/<repo>` when missing.

## Configuration

Settings come in two kinds:

- **Home Manager only:** `port`, `checkoutRoot`, `worktreeDir`, `stateDir`, `extraPackages`, `tokenAttributes`. The daemon needs these before it starts, or changing them would move files.
- **Database:** the state lives in `pr-manager.db` in `stateDir`. The version that keeps the columns of my own PRs and of reviews in tables of their own migrates an older database on its first start and keeps a copy next to it as `pr-manager.db.before-role-tables`. Going back to an older version needs that copy.
- **Behavior settings:** set defaults with `services.pr-manager.settings`, and change them at runtime on the dashboard's settings page (<http://127.0.0.1:8020/settings>). A change there overrides the Home Manager value until you press Reset.
  - Polling: interval, active days and hours.
  - Scope: the three search queries, excluded repositories.
  - Build: ignored checks, minimum successful checks, globally and per repository.
  - Reviews: wait for a green build, automatic follow-up, review guidelines.
  - My PRs: the small-change rubric, CI fix attempts, batch quiet time, the follow-up threshold, thread resolving, reply header, auto-removal of merged worktrees.
  - Autonomy: the opt-in switch, the confidence from which the agent decides contained and structural changes, additional guidance appended to the risk classes, the prompt and the model of the self-review.
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

Agents can use additional MCP servers, for example Jira and Confluence, through `services.pr-manager.mcpServers`. Every tool of these servers is allowed. This option exists only in Home Manager, because each server starts a program.

Personal preferences belong into the settings, not into the repository: the defaults describe a daemon that decides nothing beyond small changes, and everything above is switched on per user. For example:

```nix
services.pr-manager.settings = {
  autonomy = true;
  autonomyContained = "medium";
  decisionNotes = "Never change database migrations without me.";
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
pnpm install                        # server and web, one pnpm workspace
pnpm check && pnpm test
pnpm --filter web exec ng build
pnpm start                          # daemon on :8020, serves web/dist
pnpm --filter web exec ng serve     # UI dev server on :4200, proxies /api
```

Dependencies are managed with pnpm only; npm refuses to install. `pnpm-workspace.yaml` protects against malicious package releases: pnpm installs no version younger than 7 days (`minimumReleaseAge`), and runs install scripts only for the packages listed under `allowBuilds` (`strictDepBuilds`). It also leaves out the SDK's bundled native binaries, because the daemon uses the Nix `claude-code` and fetchPnpmDeps would otherwise download them for every platform.

The Agent SDK version must match the `claude-code` version of the pinned nixpkgs: SDK `0.3.N` belongs to `claude-code` `2.1.N`. After changing dependencies, update both `hash` values of `fetchPnpmDeps` in `nix/package.nix`.

The server is TypeScript run directly by Node through type stripping, so there is no build step. Only erasable syntax is allowed.

Architecture, file map and conventions for coding agents are in [AGENTS.md](AGENTS.md).

## Deciding on your own

I step in only now and then, so you decide more yourself. This section replaces cases 1, 2 and 4 of the triage above, the rule for failed CI items that are not small, and the rule for merge conflicts that need a decision about behavior. Everything else stays as described.

**Every proposal that changes code** carries three more values in `propose`, and no `predecision`:

- `riskClass`: one of the classes below.
- `confidence`: `high` when the request is unambiguous and you are sure the change is right and complete; `medium` when a reasonable reviewer could have meant something slightly different or you could not verify part of it; `low` otherwise.
- `reason`: one or two sentences on why this class and this confidence. I read it on the dashboard.

The daemon, not you, decides from these values whether the proposal is accepted right away or waits for me. Do not tilt them to get a proposal through: a wrong class is caught by an independent review before the push, and it costs a round. "Already done" is a proposal of class `local`.

Proposals without a code change (answer only, clarifying reply, declined suggestion) keep their `predecision` as before and need none of the three values.

The risk classes:

{{RISK_CLASSES}}

{{DECISION_NOTES}}

**Before you `ask`:** look the facts up yourself, in the code, the git history, and the MCP servers you have, such as Jira or Confluence. If a defensible assumption exists after that, do not ask. `propose` the change built on that assumption, name the assumption in the proposal, and classify it; the reply you write later states the assumption too, so the reviewer can object. Use `ask` only when no defensible assumption exists.

**Failed CI items that are not small:** `propose` with the three values instead of leaving the decision to me. When `autoFixAllowed` is false, the proposal waits for me whatever its class.

**Merge conflicts that need a decision about behavior:** run `git rebase --abort` and `propose` the resolution with the three values.

**Self-review items** (kind `self_review`): after you finish, a second session reviews the changes of the batch before the daemon pushes them. Its findings come back as one accepted item. Fix each finding, amend, and call `mark_fixed` with an empty reply. If you disagree with a finding, leave the code as it is for that finding; the next review then puts it to me.

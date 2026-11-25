import { z } from 'zod';
import { type AgentTool, type ToolContext, def, fail, ok } from '../agent-tools.ts';
import { mayDecide } from '../batch.ts';
import { botBody, botThread } from '../bot-comment.ts';
import { hasProse } from '../checklist.ts';
import { rest } from '../github.ts';
import type { Confidence, Decision, OwnPr, RiskClass } from '../model.ts';
import { autonomyLimits, setting } from '../settings.ts';
import { errorMessage } from '../util.ts';

/** What the agent has to do with an item I decided on. */
const DECIDED = {
  accept: 'accepted proposal: implement it',
  reject: 'rejected: change no code, write the reply that declines it',
  reply: 'reply: change no code, write the reply; the thread stays open',
};

const tail = (text: string, lines: number) => text.split('\n').slice(-lines).join('\n');

/** The open items of my PR, as `get_pr` hands them to the agent. */
export async function describeOwn(ctx: ToolContext<OwnPr>) {
  const { db, prId, pr } = ctx;
  const p = pr();
  const open = db.comments(prId).filter((c) => c.state === 'new' || c.state === 'accepted');
  const items = await Promise.all(
    open.map(async (c) => ({
      commentId: c.id,
      kind: c.kind,
      state: c.state === 'new' ? 'new: triage it' : DECIDED[c.decision === 'reject' || c.decision === 'reply' ? c.decision : 'accept'],
      author: c.author,
      path: c.path,
      line: c.line,
      url: c.url,
      conversation: c.kind === 'thread' ? botThread(c.body) : botBody(c.author, c.body),
      ...(c.task ? { checklistItem: c.task, checklistOnly: !hasProse(c.body) } : {}),
      ...(c.state === 'accepted' && c.proposal ? { acceptedProposal: c.proposal } : {}),
      ...(c.state === 'accepted' && c.reply_edited ? { myReply: c.reply_draft } : {}),
      ...(c.kind === 'ci' ? { failedChecks: await ciLogs(p.repo, c.note), autoFixAllowed: p.ci_attempts < setting('maxCiAttempts') } : {}),
    })),
  );
  return { role: 'my pull request', openItems: items };
}

async function ciLogs(repo: string, note: string | null): Promise<{ name: string; url: string | null; log: string }[]> {
  const checks = note ? (JSON.parse(note) as { id: number | null; name: string; url: string | null }[]) : [];
  return Promise.all(
    checks.map(async (c) => {
      if (!c.id) return { name: c.name, url: c.url, log: '(no log available, see the URL)' };
      try {
        // GitHub answers with a redirect to the plain-text log, which fetch follows.
        const log = await rest<string>('GET', `/repos/${repo}/actions/jobs/${c.id}/logs`);
        return { name: c.name, url: c.url, log: tail(log, 200) };
      } catch (e) {
        return { name: c.name, url: c.url, log: `(log unavailable: ${errorMessage(e)})` };
      }
    }),
  );
}

/** The tools that settle the open items of my PR. */
export function ownTools(ctx: ToolContext<OwnPr>): AgentTool[] {
  const { db, prId, pr, touched } = ctx;

  const ownComment = (id: number) => {
    const c = db.comment(id);
    return c && c.pr_id === prId ? c : undefined;
  };

  /**
   * Saves a proposal. `rating` is given only with autonomy: a code change then needs all three values, and
   * my limits, not the agent, decide whether it is accepted. CI fixes beyond the attempt limit always wait for me.
   */
  function propose(
    commentId: number,
    proposal: string,
    predecision: Decision | undefined,
    clarifying: boolean | undefined,
    rating?: { riskClass?: RiskClass; confidence?: Confidence; reason?: string },
  ) {
    const c = ownComment(commentId);
    if (!c || (c.state !== 'new' && c.state !== 'accepted')) return fail(`Comment ${commentId} is not open.`);
    let decision: Decision | null = predecision ?? null;
    const rated = !!rating && (predecision === undefined || predecision === 'accept');
    if (rated) {
      const { riskClass, confidence, reason } = rating;
      if (!riskClass || !confidence || !reason?.trim())
        return fail(`A proposal that changes code needs riskClass, confidence and reason. Call propose for comment ${commentId} again.`);
      const ciExhausted = c.kind === 'ci' && pr().ci_attempts >= setting('maxCiAttempts');
      decision = !ciExhausted && mayDecide(riskClass, confidence, autonomyLimits()) ? 'accept' : null;
    }
    db.update('comments', commentId, {
      state: 'proposal',
      proposal,
      reply_draft: null,
      reply_edited: 0,
      decision,
      clarify: clarifying ? 1 : 0,
      risk: rated ? rating.riskClass! : null,
      confidence: rated ? rating.confidence! : null,
      reason: rated ? rating.reason!.trim() : null,
    });
    return touched(
      ok(
        decision
          ? `Comment ${commentId} pre-decided: ${decision}.`
          : `Proposal for comment ${commentId} saved. I will decide on the dashboard.`,
      ),
    );
  }

  return [
    def(
      'mark_fixed',
      'Marks a comment as fixed after you changed the code and amended the commit. replyDraft is the reply posted on GitHub when the batch is pushed; use an empty string for CI failures, instructions and merge conflicts.',
      { commentId: z.number(), replyDraft: z.string() },
      async ({ commentId, replyDraft }) => {
        const c = ownComment(commentId);
        if (!c) return fail(`Unknown comment ${commentId}.`);
        if (c.state !== 'new' && c.state !== 'accepted') return fail(`Comment ${commentId} is ${c.state}, not new or accepted.`);
        if (c.state === 'accepted' && (c.decision === 'reject' || c.decision === 'reply'))
          return fail(`I decided to ${c.decision} comment ${commentId}: change no code and use reply instead.`);
        if (c.state === 'new' && (c.kind === 'thread' || c.kind === 'issue_comment' || c.kind === 'review_body'))
          return fail(
            `Do not fix comment ${commentId} during triage: propose it with a predecision. The fix follows once every decision is made.`,
          );
        if (c.kind === 'ci' && c.state === 'new' && pr().ci_attempts >= setting('maxCiAttempts')) {
          return fail('Automatic CI fixes are exhausted for this PR. Undo your change and use propose instead.');
        }
        db.update('comments', commentId, {
          state: 'fixed',
          auto: c.state === 'new' ? 1 : 0,
          reply_draft: c.reply_edited ? c.reply_draft : replyDraft,
        });
        return touched(ok(`Comment ${commentId} marked as fixed.`));
      },
    ),

    def(
      'dismiss',
      'Closes a comment that needs no action and no reply, such as a bot status message or an approval without remarks.',
      { commentId: z.number(), reason: z.string() },
      async ({ commentId, reason }) => {
        const c = ownComment(commentId);
        if (!c || c.state !== 'new') return fail(`Comment ${commentId} is not a new comment of this PR.`);
        db.update('comments', commentId, { state: 'done', note: `Dismissed: ${reason}` });
        return touched(ok(`Comment ${commentId} dismissed.`));
      },
    ),

    setting('autonomy')
      ? def(
          'propose',
          'Records how to handle a comment: describe the change you propose, or for no code change what the reply would say. A proposal that changes code carries riskClass, confidence and reason and no predecision: the daemon decides from them whether it is accepted or waits for me. A proposal without a code change carries its predecision instead. Do not change code for it yet and do not draft the reply; both follow once every decision of the PR is made. Set clarifying to true when you suggest a reply that asks the reviewer to clarify.',
          {
            commentId: z.number(),
            proposal: z.string(),
            predecision: z.enum(['accept', 'reject', 'reply', 'skip']).optional(),
            clarifying: z.boolean().optional(),
            riskClass: z.enum(['local', 'contained', 'structural']).optional(),
            confidence: z.enum(['high', 'medium', 'low']).optional(),
            reason: z.string().optional(),
          },
          async (a) => propose(a.commentId, a.proposal, a.predecision, a.clarifying, a),
        )
      : def(
          'propose',
          'Records how to handle a comment: describe the change you propose, or for no code change what the reply would say. Set predecision when the workflow lets you decide; leave it out to put the decision to me. Do not change code for it yet and do not draft the reply; both follow once every decision of the PR is made. Set clarifying to true when you suggest a reply that asks the reviewer to clarify.',
          {
            commentId: z.number(),
            proposal: z.string(),
            predecision: z.enum(['accept', 'reject', 'reply', 'skip']).optional(),
            clarifying: z.boolean().optional(),
          },
          async (a) => propose(a.commentId, a.proposal, a.predecision, a.clarifying),
        ),

    def(
      'reply',
      'Settles a comment I decided to reject or to reply to: no code change, only the reply posted when the batch is pushed. A rejected thread is resolved, a replied one stays open.',
      { commentId: z.number(), reply: z.string() },
      async ({ commentId, reply }) => {
        const c = ownComment(commentId);
        if (!c || c.state !== 'accepted' || (c.decision !== 'reject' && c.decision !== 'reply'))
          return fail(`Comment ${commentId} is not one I decided to reject or reply to.`);
        const text = c.reply_edited ? c.reply_draft : reply;
        db.update(
          'comments',
          commentId,
          c.decision === 'reject' ? { state: 'skipped', skip_reason: text } : { state: 'fixed', reply_draft: text, clarify: 1 },
        );
        return touched(ok(`Reply for comment ${commentId} saved.`));
      },
    ),
  ];
}

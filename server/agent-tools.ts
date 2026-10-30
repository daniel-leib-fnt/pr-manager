import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { hasProse } from './checklist.ts';
import type { Db } from './db.ts';
import { setting } from './settings.ts';
import { type GhPrDetail, commentableLines, prDetail, prFiles, rest } from './github.ts';
import { changed, errorMessage } from './util.ts';

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

const tail = (text: string, lines: number) => text.split('\n').slice(-lines).join('\n');

export const AGENT_TOOL_SERVER = 'pr';

type Shape = Parameters<typeof tool>[2];

/** Result tools must always be visible, so they are exempt from deferred tool search. */
const def = <S extends Shape>(name: string, description: string, schema: S, handler: Parameters<typeof tool<S>>[3]) =>
  tool(name, description, schema, handler, { alwaysLoad: true });

/** The in-process MCP server through which a session reports results for one PR. */
export function createAgentTools(db: Db, prId: number, onBlocked: (reason: string) => void) {
  let detail: GhPrDetail | undefined;
  let lines: Map<string, Set<number>> | undefined;
  const pr = () => db.pr(prId)!;
  const loadDetail = async () => (detail ??= await prDetail(pr().repo, pr().number));

  const ownComment = (id: number) => {
    const c = db.comment(id);
    return c && c.pr_id === prId ? c : undefined;
  };

  const touched = <T>(v: T) => {
    changed(prId);
    return v;
  };

  async function ciLogs(note: string | null): Promise<{ name: string; url: string | null; log: string }[]> {
    const checks = note ? (JSON.parse(note) as { id: number | null; name: string; url: string | null }[]) : [];
    return Promise.all(
      checks.map(async (c) => {
        if (!c.id) return { name: c.name, url: c.url, log: '(no log available, see the URL)' };
        try {
          // GitHub answers with a redirect to the plain-text log, which fetch follows.
          const log = await rest<string>('GET', `/repos/${pr().repo}/actions/jobs/${c.id}/logs`);
          return { name: c.name, url: c.url, log: tail(log, 200) };
        } catch (e) {
          return { name: c.name, url: c.url, log: `(log unavailable: ${errorMessage(e)})` };
        }
      }),
    );
  }

  const tools = [
    def('get_pr', 'Returns the pull request, the open items you have to handle, and, for reviews, the review threads.', {}, async () => {
      const p = pr();
      const d = await loadDetail();
      const base = {
        url: p.url,
        title: p.title,
        author: p.author,
        role: p.role === 'own' ? 'my pull request' : 'pull request I review',
        baseBranch: p.base_ref,
        headBranch: p.head_ref,
        diffCommand: `git diff refs/remotes/origin/${p.base_ref}...HEAD`,
        description: d.body,
        summary: p.summary,
      };
      if (p.role === 'own') {
        const open = db.comments(prId).filter((c) => c.state === 'new' || c.state === 'accepted');
        const items = await Promise.all(
          open.map(async (c) => ({
            commentId: c.id,
            kind: c.kind,
            state: c.state === 'accepted' ? 'accepted proposal: implement it' : 'new: triage it',
            author: c.author,
            path: c.path,
            line: c.line,
            url: c.url,
            conversation: c.body,
            ...(c.task ? { checklistItem: c.task, checklistOnly: !hasProse(c.body) } : {}),
            ...(c.state === 'accepted' && c.proposal ? { acceptedProposal: c.proposal } : {}),
            ...(c.kind === 'ci' ? { failedChecks: await ciLogs(c.note), autoFixAllowed: p.ci_attempts < setting('maxCiAttempts') } : {}),
          })),
        );
        const answered = db.questions(prId).filter((q) => q.state === 'answered').map((q) => ({ question: q.question, answer: q.answer, commentId: q.comment_id }));
        return ok(JSON.stringify({ ...base, openItems: items, answeredQuestions: answered }, null, 2));
      }
      const threads = d.reviewThreads.nodes.map((t) => ({
        threadId: t.id,
        resolved: t.isResolved,
        path: t.path,
        line: t.line ?? t.originalLine,
        comments: t.comments.nodes.map((c) => ({ author: c.author?.login, at: c.createdAt, body: c.body })),
      }));
      const instructions = db.comments(prId).filter((c) => c.kind === 'instruction' && c.state === 'accepted').map((c) => c.body);
      return ok(
        JSON.stringify(
          { ...base, previousReview: p.reviewed_sha ? { commit: p.reviewed_sha, at: p.reviewed_at, changesSince: `git diff ${p.reviewed_sha}..HEAD` } : null, threads, instructions },
          null,
          2,
        ),
      );
    }),

    def('set_summary', 'Sets the PR summary shown on the dashboard: what changes and why, 3 to 6 sentences.', { summary: z.string() }, async ({ summary }) => {
      db.update('prs', prId, { summary });
      return touched(ok('Summary saved.'));
    }),

    def(
      'mark_fixed',
      'Marks a comment as fixed after you changed the code and amended the commit. replyDraft is the reply posted on GitHub when the batch is pushed; use an empty string for CI failures, instructions and merge conflicts.',
      { commentId: z.number(), replyDraft: z.string() },
      async ({ commentId, replyDraft }) => {
        const c = ownComment(commentId);
        if (!c) return fail(`Unknown comment ${commentId}.`);
        if (c.state !== 'new' && c.state !== 'accepted') return fail(`Comment ${commentId} is ${c.state}, not new or accepted.`);
        if (c.kind === 'ci' && c.state === 'new' && pr().ci_attempts >= setting('maxCiAttempts')) {
          return fail('Automatic CI fixes are exhausted for this PR. Undo your change and use propose instead.');
        }
        db.update('comments', commentId, { state: 'fixed', auto: c.state === 'new' ? 1 : 0, reply_draft: c.reply_edited ? c.reply_draft : replyDraft });
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

    def(
      'propose',
      'Puts a comment up for my decision instead of fixing it: describe the change you propose and draft the reply. Do not change code for it yet. Set clarifying to true when the reply asks the reviewer to clarify; its thread then stays unresolved and its checklist box unchecked.',
      { commentId: z.number(), proposal: z.string(), replyDraft: z.string(), clarifying: z.boolean().optional() },
      async ({ commentId, proposal, replyDraft, clarifying }) => {
        const c = ownComment(commentId);
        if (!c || (c.state !== 'new' && c.state !== 'accepted')) return fail(`Comment ${commentId} is not open.`);
        db.update('comments', commentId, { state: 'proposal', proposal, reply_draft: replyDraft, reply_edited: 0, clarify: clarifying ? 1 : 0 });
        return touched(ok(`Proposal for comment ${commentId} saved. I will decide on the dashboard.`));
      },
    ),

    def(
      'ask',
      'Asks me a question on the dashboard. After asking, finish your turn; the answers arrive as the next message. Link the question to a comment when it is about one.',
      { question: z.string(), options: z.array(z.string()).optional(), commentId: z.number().optional() },
      async ({ question, options, commentId }) => {
        if (commentId !== undefined && !ownComment(commentId)) return fail(`Unknown comment ${commentId}.`);
        db.insert('questions', { pr_id: prId, comment_id: commentId ?? null, question, options: options ? JSON.stringify(options) : null });
        return touched(ok('Question saved. Finish your turn now; the answer arrives later.'));
      },
    ),

    def(
      'add_review_finding',
      'Adds a finding to the review draft, anchored to a line on the right side of the diff.',
      { path: z.string(), line: z.number(), body: z.string() },
      async ({ path, line, body }) => {
        lines ??= commentableLines(await prFiles(pr().repo, pr().number));
        const inDiff = lines.get(path)?.has(line) ?? false;
        db.insert('findings', { pr_id: prId, kind: 'finding', path, line, body, in_diff: inDiff ? 1 : 0 });
        return touched(ok(inDiff ? 'Finding added.' : 'Finding added; the line is outside the diff, so it goes into the review body.'));
      },
    ),

    def(
      'set_review_verdict',
      'Sets the suggested verdict and the review body text.',
      { verdict: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']), body: z.string() },
      async ({ verdict, body }) => {
        db.update('prs', prId, { review_verdict: verdict, review_body: body });
        return touched(ok('Verdict saved.'));
      },
    ),

    def(
      'draft_thread_reply',
      'Drafts my reply to the author in an existing review thread.',
      { threadId: z.string(), body: z.string() },
      async ({ threadId, body }) => {
        const t = (await loadDetail()).reviewThreads.nodes.find((x) => x.id === threadId);
        if (!t || !t.comments.nodes[0]) return fail(`Unknown thread ${threadId}.`);
        db.insert('findings', { pr_id: prId, kind: 'thread_reply', thread_id: threadId, reply_to_db_id: t.comments.nodes[0].databaseId, path: t.path, line: t.line ?? t.originalLine, body });
        return touched(ok('Reply drafted.'));
      },
    ),

    def(
      'report_blocked',
      'Stops work on this PR until I intervene, for example on a non-trivial rebase conflict. Leave the worktree clean.',
      { reason: z.string() },
      async ({ reason }) => {
        onBlocked(reason);
        return touched(ok('Reported. Finish your turn now.'));
      },
    ),
  ];

  return createSdkMcpServer({ name: AGENT_TOOL_SERVER, version: '1.0.0', tools });
}

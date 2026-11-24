import { z } from 'zod';
import { type AgentTool, type ToolContext, def, fail, ok } from '../agent-tools.ts';
import type { Db } from '../db.ts';
import { commentableLines, prFiles } from '../github.ts';
import type { ReviewPr } from '../model.ts';

/** The unsent review draft that a review run replaces. */
export interface PreviousDraft {
  commit: string | null;
  verdict: string | null;
  body: string | null;
  findings: { path: string | null; line: number | null; body: string }[];
  threadReplies: { threadId: string | null; body: string; resolve: boolean }[];
}

/** A thread holds at most one reply draft: a later one replaces it, so no outdated reply is left to submit. */
export function draftThreadReply(
  db: Db,
  prId: number,
  reply: { thread_id: string; reply_to_db_id: number; path: string | null; line: number | null; body: string; resolve: boolean },
) {
  db.transaction(() => {
    db.run(`DELETE FROM findings WHERE pr_id = ? AND kind = 'thread_reply' AND thread_id = ? AND state = 'draft'`, prId, reply.thread_id);
    db.insert('findings', { pr_id: prId, kind: 'thread_reply', ...reply, resolve: reply.resolve ? 1 : 0 });
  });
}

/** The tools that build a review draft. `onDraft` tells the run that the agent wrote to it. */
export function reviewTools(ctx: ToolContext<ReviewPr>, onDraft: () => void): AgentTool[] {
  const { db, prId, pr, touched } = ctx;
  let lines: Map<string, Set<number>> | undefined;

  return [
    def(
      'add_review_finding',
      'Adds a finding to the review draft, anchored to a line on the right side of the diff.',
      { path: z.string(), line: z.number(), body: z.string() },
      async ({ path, line, body }) => {
        lines ??= commentableLines(await prFiles(pr().repo, pr().number));
        const inDiff = lines.get(path)?.has(line) ?? false;
        db.insert('findings', { pr_id: prId, kind: 'finding', path, line, body, in_diff: inDiff ? 1 : 0 });
        onDraft();
        return touched(ok(inDiff ? 'Finding added.' : 'Finding added; the line is outside the diff, so it goes into the review body.'));
      },
    ),

    def(
      'set_review_verdict',
      'Sets the suggested verdict and the review body text. Pass an empty body unless my review guidelines ask for one.',
      { verdict: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']), body: z.string() },
      async ({ verdict, body }) => {
        db.updatePr(prId, { review_verdict: verdict, review_body: body });
        onDraft();
        return touched(ok('Verdict saved.'));
      },
    ),

    def(
      'draft_thread_reply',
      'Drafts my reply to the author in an existing review thread; a thread holds one draft, so a new one replaces it. Set resolve to true when the code at HEAD settles my point: the thread is then resolved when I submit the review.',
      { threadId: z.string(), body: z.string(), resolve: z.boolean().optional() },
      async ({ threadId, body, resolve }) => {
        const t = (await ctx.detail()).reviewThreads.nodes.find((x) => x.id === threadId);
        if (!t || !t.comments.nodes[0]) return fail(`Unknown thread ${threadId}.`);
        draftThreadReply(db, prId, {
          thread_id: threadId,
          reply_to_db_id: t.comments.nodes[0].databaseId,
          path: t.path,
          line: t.line ?? t.originalLine,
          body,
          resolve: !!resolve,
        });
        onDraft();
        return touched(ok('Reply drafted.'));
      },
    ),
  ];
}

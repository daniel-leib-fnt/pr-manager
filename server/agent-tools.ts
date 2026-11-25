import { type SdkMcpToolDefinition, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Db } from './db.ts';
import { type GhPrDetail, prDetail } from './github.ts';
import type { Pr } from './model.ts';
import { changed } from './util.ts';

export const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
export const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

export const AGENT_TOOL_SERVER = 'pr';

type Shape = Parameters<typeof tool>[2];
/** A tool of any input schema, as a tool list holds them. */
export type AgentTool = SdkMcpToolDefinition;

/**
 * Defines a result tool. Result tools must always be visible, so they are exempt from deferred tool search.
 * The handler is checked against its own schema here; the list type forgets the schema.
 */
export const def = <S extends Shape>(name: string, description: string, schema: S, handler: Parameters<typeof tool<S>>[3]) =>
  tool(name, description, schema, handler, { alwaysLoad: true }) as unknown as AgentTool;

/** What the tools of one session share: the PR as it is now, and its GitHub detail, loaded once. */
export interface ToolContext<P extends Pr = Pr> {
  db: Db;
  prId: number;
  pr(): P;
  detail(): Promise<GhPrDetail>;
  /** Tells the dashboard that the PR changed, and passes the tool result through. */
  touched<T>(result: T): T;
}

export function toolContext<P extends Pr>(db: Db, prId: number): ToolContext<P> {
  let detail: GhPrDetail | undefined;
  const pr = () => db.pr(prId) as P;
  return {
    db,
    prId,
    pr,
    detail: async () => (detail ??= await prDetail(pr().repo, pr().number)),
    touched: (result) => {
      changed(prId);
      return result;
    },
  };
}

/**
 * The in-process MCP server through which a session reports results for one PR: the tools every PR has,
 * and on top the tools and the `get_pr` part of the PR's role.
 */
export function createAgentTools(
  ctx: ToolContext,
  role: { tools: AgentTool[]; describe: () => Promise<Record<string, unknown>> },
  onBlocked: (reason: string) => void,
) {
  const { db, prId, touched } = ctx;

  const tools: AgentTool[] = [
    def('get_pr', 'Returns the pull request, what there is to do on it, and my answers to your questions.', {}, async () => {
      const p = ctx.pr();
      const d = await ctx.detail();
      const questions = db.questions(prId);
      return ok(
        JSON.stringify(
          {
            url: p.url,
            title: p.title,
            author: p.author,
            baseBranch: p.base_ref,
            headBranch: p.head_ref,
            diffCommand: `git diff refs/remotes/origin/${p.base_ref}...HEAD`,
            description: d.body,
            summary: p.summary,
            ...(await role.describe()),
            answeredQuestions: questions
              .filter((q) => q.state === 'answered')
              .map((q) => ({ question: q.question, answer: q.answer, commentId: q.comment_id })),
            openQuestions: questions
              .filter((q) => q.state === 'open')
              .map((q) => ({ questionId: q.id, question: q.question, commentId: q.comment_id })),
            openFollowUps: db
              .followUps(prId)
              .filter((f) => f.state === 'open')
              .map((f) => f.text),
          },
          null,
          2,
        ),
      );
    }),

    def(
      'set_summary',
      'Sets the PR summary shown on the dashboard: what changes and why, 3 to 6 sentences.',
      { summary: z.string() },
      async ({ summary }) => {
        db.updatePr(prId, { summary });
        return touched(ok('Summary saved.'));
      },
    ),

    def(
      'ask',
      'Asks me a question on the dashboard. After asking, finish your turn; the answers arrive as the next message. Link the question to a comment when it is about one.',
      { question: z.string(), options: z.array(z.string()).optional(), commentId: z.number().optional() },
      async ({ question, options, commentId }) => {
        if (commentId !== undefined && db.comment(commentId)?.pr_id !== prId) return fail(`Unknown comment ${commentId}.`);
        db.insert('questions', { pr_id: prId, comment_id: commentId ?? null, question, options: options ? JSON.stringify(options) : null });
        return touched(ok('Question saved. Finish your turn now; the answer arrives later.'));
      },
    ),

    def(
      'withdraw_question',
      'Takes back a question I have not answered yet, because the code at HEAD settles it. The reason is shown to me in its place.',
      { questionId: z.number(), reason: z.string() },
      async ({ questionId, reason }) => {
        const q = db.questions(prId).find((x) => x.id === questionId);
        if (!q || q.state !== 'open') return fail(`Question ${questionId} is not an open question of this PR.`);
        db.update('questions', questionId, { state: 'withdrawn', answer: reason });
        return touched(ok(`Question ${questionId} withdrawn.`));
      },
    ),

    def(
      'follow_up',
      'Hands me something to do or check myself that you could not: an assumption you did not verify, a change you could not run or test, or a step outside this repository such as a setting in another repository or a ticket. It holds nothing back and needs no answer; I tick it off on the dashboard. Write it so that I can act on it without the transcript. Link it to a comment when it belongs to one.',
      { text: z.string(), commentId: z.number().optional() },
      async ({ text, commentId }) => {
        if (commentId !== undefined && db.comment(commentId)?.pr_id !== prId) return fail(`Unknown comment ${commentId}.`);
        if (!text.trim()) return fail('A follow-up needs a text.');
        db.insert('follow_ups', { pr_id: prId, comment_id: commentId ?? null, text: text.trim() });
        return touched(ok('Follow-up saved.'));
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

    ...role.tools,
  ];

  return createSdkMcpServer({ name: AGENT_TOOL_SERVER, version: '1.0.0', tools });
}

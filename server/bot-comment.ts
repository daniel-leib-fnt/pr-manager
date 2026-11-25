/** Longest bot comment `get_pr` passes on in full; coverage tables and size reports can exceed the token limit. */
export const BOT_COMMENT_LIMIT = 1500;

/**
 * GraphQL reports app accounts without the `[bot]` suffix REST uses (`github-actions`, `codecov`), so the
 * suffix check is joined by a trailing `-bot` or `_bot` and the usual coverage and CI accounts.
 */
const BOT_LOGIN = /(\[bot\]|[-_]bot|^github-actions|^codecov|^sonarcloud|^sonarqubecloud)$/i;

export const isBot = (login: string | null | undefined) => !!login && BOT_LOGIN.test(login);

/** A bot comment marked as a status message up front and cut to `limit` characters; other bodies stay as they are. */
export function botBody(author: string | null | undefined, body: string, limit = BOT_COMMENT_LIMIT): string {
  if (!isBot(author)) return body;
  const cut = body.length > limit ? `${body.slice(0, limit)}\n[... truncated, ${body.length - limit} more characters]` : body;
  return `[Bot status message, for example a coverage report or size watcher.]\n${cut}`;
}

/** A stored thread (`formatThread` in `roles/own-ingest.ts`): `@login (time):` blocks joined by `---`. Marks and cuts each bot comment on its own. */
export function botThread(thread: string, limit = BOT_COMMENT_LIMIT): string {
  return thread
    .split(/\n\n---\n\n(?=@\S+ \()/)
    .map((part) => {
      const m = /^(@(\S+) \([^)\n]*\):\n)([\s\S]*)$/.exec(part);
      return m ? m[1] + botBody(m[2], m[3], limit) : part;
    })
    .join('\n\n---\n\n');
}

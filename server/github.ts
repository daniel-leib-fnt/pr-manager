import { run } from './util.ts';

export class GithubError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

let cachedToken: { value: string; at: number } | undefined;

/** Token from `gh auth token`. A missing token is an error, never a silent fallback. */
export async function token(): Promise<string> {
  if (cachedToken && Date.now() - cachedToken.at < 5 * 60_000) return cachedToken.value;
  let value: string;
  try {
    value = (await run('gh', ['auth', 'token'])).trim();
  } catch (e) {
    throw new GithubError(`gh auth token failed, is the keyring unlocked? ${(e as Error).message}`, 401, false);
  }
  if (!value) throw new GithubError('gh auth token returned no token', 401, false);
  cachedToken = { value, at: Date.now() };
  return value;
}

async function request(url: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${await token()}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'pr-manager',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    const rateLimited = res.status === 429 || (res.status === 403 && /rate limit/i.test(text));
    if (res.status === 401) cachedToken = undefined;
    throw new GithubError(`GitHub ${init.method ?? 'GET'} ${url} returned ${res.status}: ${text.slice(0, 300)}`, res.status, res.status >= 500 || rateLimited);
  }
  return res;
}

export async function graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await request('https://api.github.com/graphql', { method: 'POST', body: JSON.stringify({ query, variables }) });
  const json = (await res.json()) as { data?: T; errors?: { message: string; type?: string }[] };
  if (json.errors?.length) {
    const msg = json.errors.map((e) => e.message).join('; ');
    throw new GithubError(`GraphQL: ${msg}`, 200, json.errors.some((e) => e.type === 'RATE_LIMITED'));
  }
  return json.data as T;
}

export async function rest<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await request(`https://api.github.com${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  return (type.includes('json') ? await res.json() : await res.text()) as T;
}

/** Plain-text log of an Actions job; GitHub answers with a redirect that fetch follows. */
export async function jobLog(repo: string, jobId: number): Promise<string> {
  return rest<string>('GET', `/repos/${repo}/actions/jobs/${jobId}/logs`);
}

export const PR_FIELDS = `
  url number title isDraft state merged updatedAt
  headRefName headRefOid baseRefName isCrossRepository
  author { login }
  repository { nameWithOwner }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
`;

export interface GhPr {
  url: string;
  number: number;
  title: string;
  isDraft: boolean;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  merged: boolean;
  updatedAt: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  isCrossRepository: boolean;
  author: { login: string } | null;
  repository: { nameWithOwner: string };
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
}

export function rollupState(pr: GhPr): string | null {
  return pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null;
}

export async function viewerLogin(): Promise<string> {
  const data = await graphql<{ viewer: { login: string } }>('query { viewer { login } }');
  return data.viewer.login;
}

export async function searchPrs(q: string): Promise<GhPr[]> {
  const out: GhPr[] = [];
  let cursor: string | null = null;
  for (;;) {
    const data: { search: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: GhPr[] } } = await graphql(
      `query($q: String!, $cursor: String) {
        search(type: ISSUE, query: $q, first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { ... on PullRequest { ${PR_FIELDS} } }
        }
      }`,
      { q, cursor },
    );
    out.push(...data.search.nodes.filter((n) => n && n.url));
    if (!data.search.pageInfo.hasNextPage) return out;
    cursor = data.search.pageInfo.endCursor;
  }
}

/** Looks up PRs by URL, for PRs that left the search results (merged, closed or already reviewed). */
export async function prsByUrl(urls: string[]): Promise<Map<string, GhPr>> {
  const out = new Map<string, GhPr>();
  for (let i = 0; i < urls.length; i += 30) {
    const chunk = urls.slice(i, i + 30);
    const fields = chunk.map((u, j) => `p${j}: resource(url: ${JSON.stringify(u)}) { ... on PullRequest { ${PR_FIELDS} } }`).join('\n');
    const data = await graphql<Record<string, GhPr | null>>(`query { ${fields} }`);
    chunk.forEach((u, j) => {
      const pr = data[`p${j}`];
      if (pr?.url) out.set(u, pr);
    });
  }
  return out;
}

export interface GhComment {
  id: string;
  databaseId: number;
  author: { login: string } | null;
  body: string;
  createdAt: string;
  url: string;
}

export interface GhThread {
  id: string;
  isResolved: boolean;
  path: string;
  line: number | null;
  originalLine: number | null;
  comments: { nodes: GhComment[] };
}

export interface GhCheck {
  __typename: 'CheckRun' | 'StatusContext';
  databaseId?: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  detailsUrl?: string;
  context?: string;
  state?: string;
  targetUrl?: string;
}

export interface GhPrDetail extends GhPr {
  body: string;
  reviewThreads: { nodes: GhThread[] };
  comments: { nodes: GhComment[] };
  reviews: { nodes: (GhComment & { state: string; submittedAt: string | null; commit: { oid: string } | null })[] };
  headCommit: { nodes: { commit: { oid: string; statusCheckRollup: { state: string; contexts: { nodes: GhCheck[] } } | null } }[] };
}

export async function prDetail(repo: string, number: number): Promise<GhPrDetail> {
  const [owner, name] = repo.split('/');
  const data = await graphql<{ repository: { pullRequest: GhPrDetail } }>(
    `query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          ${PR_FIELDS}
          body
          reviewThreads(first: 100) {
            nodes {
              id isResolved path line originalLine
              comments(first: 100) { nodes { id databaseId author { login } body createdAt url } }
            }
          }
          comments(last: 100) { nodes { id databaseId author { login } body createdAt url } }
          reviews(last: 100) { nodes { id databaseId author { login } body createdAt url state submittedAt commit { oid } } }
          headCommit: commits(last: 1) {
            nodes { commit { oid statusCheckRollup { state contexts(first: 100) { nodes {
              __typename
              ... on CheckRun { databaseId name status conclusion detailsUrl }
              ... on StatusContext { context state targetUrl }
            } } } } }
          }
        }
      }
    }`,
    { owner, name, number },
  );
  return data.repository.pullRequest;
}

export function failedChecks(detail: GhPrDetail): { pending: boolean; failed: GhCheck[] } {
  const contexts = detail.headCommit.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
  const pending = contexts.some((c) => (c.__typename === 'CheckRun' ? c.status !== 'COMPLETED' : c.state === 'PENDING' || c.state === 'EXPECTED'));
  const failed = contexts.filter((c) =>
    c.__typename === 'CheckRun'
      ? ['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED'].includes(c.conclusion ?? '')
      : c.state === 'FAILURE' || c.state === 'ERROR',
  );
  return { pending, failed };
}

export interface PrFile {
  filename: string;
  status: string;
  patch?: string;
}

export async function prFiles(repo: string, number: number): Promise<PrFile[]> {
  const out: PrFile[] = [];
  for (let page = 1; page <= 30; page++) {
    const files = await rest<PrFile[]>('GET', `/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`);
    out.push(...files);
    if (files.length < 100) break;
  }
  return out;
}

/** Lines on the right side of the diff that a review comment can be attached to. */
export function commentableLines(files: PrFile[]): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const f of files) {
    const lines = new Set<number>();
    let right = 0;
    for (const l of (f.patch ?? '').split('\n')) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (hunk) {
        right = Number(hunk[1]);
        continue;
      }
      if (l.startsWith('-')) continue;
      if (l.startsWith('+') || l.startsWith(' ')) lines.add(right++);
    }
    out.set(f.filename, lines);
  }
  return out;
}

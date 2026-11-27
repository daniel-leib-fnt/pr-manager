import type { Finding, ReviewPrSummary, ReviewThread } from './api';
import { type NeedsItem, type Tile, plural, sha7, stamp } from './pr-view';

/** Labels of the verdict in my draft and of the one I submitted. */
export interface VerdictLabels {
  draft: string;
  submitted: string;
}

/** The status tiles of a PR I review: my review, my threads, the author. */
export function reviewTiles(pr: ReviewPrSummary, threads: ReviewThread[], draftFindings: Finding[], verdict: VerdictLabels): Tile[] {
  const open = threads.filter((t) => !t.resolved);
  const answered = open.filter((t) => t.comments.at(-1)?.author === pr.author).length;
  const replies = draftFindings.filter((f) => f.thread_id).length;
  const review: Pick<Tile, 'value' | 'sub' | 'tone'> =
    pr.review_state === 'draft'
      ? {
          value: 'Draft ready',
          sub: `${plural(draftFindings.length, 'finding')} · verdict ${verdict.draft}`,
          tone: 'action',
        }
      : pr.review_state === 'submitted'
        ? {
            value: pr.review_out_of_date ? 'Out of date' : 'Submitted',
            sub: verdict.submitted + (pr.reviewed_at ? ` · ${stamp(pr.reviewed_at)}` : ''),
            tone: pr.review_out_of_date ? 'action' : 'ok',
          }
        : pr.noBuild
          ? { value: 'No build', tone: 'idle' }
          : { value: pr.waitingForBuild ? 'Waiting for build' : 'Not drafted yet', tone: 'wait' };
  return [
    { label: 'My review', ...review, tab: 'review' },
    {
      label: 'My threads',
      value: `${open.length} open`,
      sub: `${answered} answered by the author${replies ? ` · ${replies} with a reply in the draft` : ''}`,
      tone: answered ? 'action' : open.length ? 'wait' : 'ok',
      tab: 'review',
    },
    {
      label: 'Author',
      value: pr.author,
      sub:
        `head ${sha7(pr.head_sha)}${pr.head_seen_at ? ` since ${stamp(pr.head_seen_at)}` : ''}` +
        (pr.reviewed_sha && pr.reviewed_sha !== pr.head_sha ? ' · new commits since my review' : ''),
      href: pr.url,
    },
  ];
}

/** What a PR I review leaves me to do: submit the draft, a stale draft, a missing build, an outdated review. */
export function reviewNeeds(pr: ReviewPrSummary, draftFindings: Finding[], verdict: VerdictLabels): NeedsItem[] {
  const items: NeedsItem[] = [];
  if (pr.review_state === 'draft') {
    const f = draftFindings.filter((x) => x.kind === 'finding').length;
    const r = draftFindings.filter((x) => x.kind === 'thread_reply').length;
    items.push({
      key: 'submit',
      title: 'Submit the review',
      sub: `${plural(f, 'finding')}${r ? `, ${r} ${r === 1 ? 'reply' : 'replies'} in my threads` : ''} · verdict ${verdict.draft}`,
      actions: [{ label: 'Open draft', primary: true, tab: 'review' }],
    });
    if (pr.review_draft_sha && pr.review_draft_sha !== pr.head_sha) {
      items.push({
        key: 'stale-draft',
        title: 'The draft was written for an older commit',
        sub: `Written for ${sha7(pr.review_draft_sha)} · head is now ${sha7(pr.head_sha)}`,
        actions: [{ label: 'Review again', request: { name: 'followup-review' } }],
      });
    }
  }
  if (pr.noBuild) {
    items.push({
      key: 'no-build',
      title: 'No build',
      sub: 'No check apart from skipped or ignored ones ran for this head, long after the push',
      actions: [{ label: 'Review without build', request: { name: 'review-without-build' } }],
    });
  }
  if (pr.review_out_of_date) {
    items.push({
      key: 'out-of-date',
      title: 'The review is out of date',
      sub: 'New commits or replies since my review',
      actions: [{ label: 'Review again', request: { name: 'followup-review' } }],
    });
  }
  return items;
}

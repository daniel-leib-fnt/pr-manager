import { DatePipe } from '@angular/common';
import { Component, computed, input, signal } from '@angular/core';
import type { Comment } from './api';
import { CodeExcerpt } from './code-excerpt';
import { Conversation, type Message } from './conversation';
import { ItemHead } from './item-head';
import { type Entry, headline, kindLabel, messages, outcome, replyOf } from './own-entries';
import { plural } from './pr-view';

/** Local calendar day of a time, as the key of a group. */
const dayOf = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * The Done tab of my PR: finished items grouped by the day they were finished, folded, each with how it ended
 * and, unfolded, the code, the conversation and the reply I posted.
 */
@Component({
  selector: 'app-done-list',
  imports: [DatePipe, CodeExcerpt, Conversation, ItemHead],
  template: `
    @if (entries().length) {
      <div class="list-head">
        <span>{{ plural(entries().length, 'item') }} done · newest first</span>
        <button class="link" (click)="toggleAll()">{{ allOpen() ? 'Collapse all' : 'Expand all' }}</button>
      </div>
    } @else {
      <p class="muted">Nothing done yet.</p>
    }
    @for (g of groups(); track g.day) {
      <section class="card pad-0">
        <button
          class="group-toggle"
          [class.collapsed]="closedGroups()[g.day]"
          [attr.aria-expanded]="!closedGroups()[g.day]"
          (click)="toggleGroup(g.day)"
        >
          <svg
            class="chevron"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
          Done {{ g.at | date: 'dd.MM.' }}
          <span class="count">{{ plural(g.rows.length, 'item') }}</span>
        </button>
        @if (!closedGroups()[g.day]) {
          @for (e of g.rows; track e.key) {
            <div class="drow" [class.open]="isOpen(e)">
              <app-item-head
                [open]="isOpen(e)"
                [path]="e.comment?.path ?? null"
                [line]="e.comment?.line ?? null"
                [kind]="e.comment ? (e.comment.task ? 'checklist' : kindLabel(e.comment)) : 'question'"
                [headline]="e.comment ? headline(e.comment) : e.question!.question"
                [url]="e.comment?.url ?? null"
                (toggle)="fold(e)"
              >
                <span class="tag" [class]="outcome(e).cls">{{ outcome(e).text }}</span>
                @if (outcome(e).agent) {
                  <span class="tag small info">Agent</span>
                }
              </app-item-head>
              @if (isOpen(e)) {
                <div class="dcard-body">
                  @if (e.comment; as c) {
                    @if (c.excerpt && c.path) {
                      <app-code-excerpt [excerpt]="c.excerpt" [path]="c.path" />
                    }
                    @if (c.task) {
                      <p class="task">☐ {{ c.task }}</p>
                    }
                    <app-conversation [messages]="thread(c)" />
                    @if (c.note && c.kind !== 'ci') {
                      <p class="muted small">{{ c.note }}</p>
                    }
                  } @else if (e.question; as q) {
                    <p class="bubble-text">{{ q.question }}</p>
                    <p class="muted small">{{ q.state === 'withdrawn' ? 'Withdrawn' : 'Answer' }}: {{ q.answer }}</p>
                  }
                </div>
              }
            </div>
          }
        }
      </section>
    }
  `,
})
export class DoneList {
  /** Only entries of stage `done`; each carries the time it was finished in `at`. */
  readonly entries = input.required<Entry[]>();

  protected readonly plural = plural;
  protected readonly headline = headline;
  protected readonly kindLabel = kindLabel;
  protected readonly outcome = outcome;
  /** Rows I folded or unfolded; every row starts folded. */
  private readonly folds = signal<Record<string, boolean>>({});
  /** Groups I folded; every group starts open. */
  protected readonly closedGroups = signal<Record<string, boolean>>({});

  /** Days newest first, and inside a day the newest row first. */
  protected readonly groups = computed(() => {
    const byDay = new Map<string, Entry[]>();
    for (const e of this.entries()
      .slice()
      .sort((a, b) => b.at!.localeCompare(a.at!))) {
      const day = dayOf(e.at!);
      byDay.set(day, [...(byDay.get(day) ?? []), e]);
    }
    return [...byDay].map(([day, rows]) => ({ day, at: rows[0].at!, rows }));
  });
  protected readonly allOpen = computed(() => this.entries().every((e) => this.isOpen(e)));

  protected isOpen(e: Entry) {
    return this.folds()[e.key] ?? false;
  }

  protected fold(e: Entry) {
    this.folds.set({ ...this.folds(), [e.key]: !this.isOpen(e) });
  }

  protected toggleAll() {
    const open = !this.allOpen();
    this.folds.set(Object.fromEntries(this.entries().map((e) => [e.key, open])));
    if (open) this.closedGroups.set({});
  }

  protected toggleGroup(day: string) {
    this.closedGroups.set({ ...this.closedGroups(), [day]: !this.closedGroups()[day] });
  }

  /** The conversation of an item and, below it, the reply that was posted for it. */
  protected thread(c: Comment): Message[] {
    const reply = replyOf(c);
    return [...messages(c), ...(reply ? [{ author: c.reply_edited ? 'me' : 'me (by the agent)', at: c.updated_at, text: reply }] : [])];
  }
}

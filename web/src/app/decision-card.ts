import { Component, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Comment, Question } from './api';
import { ChoiceGroup } from './components/choice-group';
import { ItemHead } from './components/item-head';
import { ThreadView } from './components/thread-view';
import { ACTIONS, type Entry, actionOf, decisionOf, headline, kindLabel, messages, replyOf, statusOf } from './own-entries';
import type { Action, Draft } from './pr-view';

/**
 * One decision or question of my PR: the head, and unfolded the thread, the proposal and the choice. Folding,
 * focus and moving on belong to the list (`own-pr.ts`); the card only reports.
 */
@Component({
  selector: 'app-decision-card',
  imports: [FormsModule, ChoiceGroup, ItemHead, ThreadView],
  template: `
    @if (entry(); as e) {
      <article class="dcard" [id]="'card-' + e.key" [class.open]="open()" [class.focused]="focused()">
        <app-item-head
          [open]="open()"
          [num]="num()"
          [path]="e.comment?.path ?? null"
          [line]="e.comment?.line ?? null"
          [kind]="e.comment ? (e.comment.task ? 'checklist' : kindLabel(e.comment)) : 'question'"
          [headline]="e.comment ? headline(e.comment) : e.question!.question"
          [url]="e.comment?.url ?? null"
          (toggle)="toggle.emit()"
        >
          @if (status(); as s) {
            <span class="tag" [class]="s.cls">{{ s.text }}</span>
            @if (s.agent) {
              <span class="tag small info" title="Pre-decided by the agent; choose another decision to change it">Agent</span>
            }
          }
        </app-item-head>

        @if (open()) {
          <div class="dcard-body">
            @if (e.comment; as c) {
              <app-thread-view [excerpt]="c.excerpt" [path]="c.path" [messages]="messages(c)">
                @if (c.task) {
                  <p class="task">☐ {{ c.task }}</p>
                }
              </app-thread-view>
              @if (c.note && c.kind !== 'ci') {
                <p class="muted small">{{ c.note }}</p>
              }
              @if (c.risk) {
                <p class="muted small">Agent rating: {{ c.risk }}, {{ c.confidence }} confidence. {{ c.reason }}</p>
              }
              @if (c.state === 'proposal') {
                @if (c.clarify) {
                  <p class="muted small">The agent suggests a clarifying reply: choose Reply to keep the thread open.</p>
                }
                <label class="field-label muted">
                  Agent proposal
                  <textarea rows="3" [(ngModel)]="decision(c).proposal" (ngModelChange)="changed.emit()"></textarea>
                </label>
              } @else if (agentReply(c); as reply) {
                <div class="field-label muted">
                  Reply on push
                  <p class="bubble-text">{{ reply }}</p>
                </div>
              }
              @if (c.state === 'proposal') {
                @if (decision(c).writeReply) {
                  <label class="field-label muted">
                    My reply
                    <textarea
                      rows="3"
                      placeholder="Empty: the agent writes the reply, following the proposal"
                      [(ngModel)]="decision(c).replyDraft"
                      (ngModelChange)="changed.emit()"
                    ></textarea>
                  </label>
                }
                <div class="decide">
                  <app-choice-group
                    [options]="actions"
                    [value]="actionOf(c)"
                    [label]="'Decision on ' + headline(c)"
                    (choose)="decide(c, $event)"
                  />
                  @if (!decision(c).writeReply) {
                    <button class="link" (click)="decision(c).writeReply = true; changed.emit()">Write the reply myself</button>
                  }
                </div>
              }
            } @else if (e.question; as q) {
              <p class="bubble-text">{{ q.question }}</p>
              @if (q.state === 'open') {
                @if (options(q).length) {
                  <div class="decide">
                    @for (o of options(q); track o) {
                      <button [class.primary]="draft().answers[q.id] === o" (click)="answer(q, o)">{{ o }}</button>
                    }
                  </div>
                }
                <textarea rows="2" placeholder="Answer" [(ngModel)]="draft().answers[q.id]" (ngModelChange)="changed.emit()"></textarea>
              } @else {
                <p class="muted small">{{ q.state === 'withdrawn' ? 'Withdrawn' : 'Answer' }}: {{ q.answer }}</p>
              }
            }
          </div>
        }
      </article>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .decide app-choice-group {
      flex: 0 1 420px;
    }
    .decide {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
    }
    .decide .link {
      margin-left: auto;
    }
  `,
})
export class DecisionCard {
  readonly entry = input.required<Entry>();
  /** The unsent input of the page; this card changes `decisions` and `answers` in place. */
  readonly draft = input.required<Draft>();
  readonly open = input.required<boolean>();
  readonly focused = input.required<boolean>();
  /** The number in the head, for an open entry. */
  readonly num = input<number | null>(null);
  /** The fold button of the head. */
  readonly toggle = output<void>();
  /** The draft changed in place and has to be kept. */
  readonly changed = output<void>();
  /** A decision or an answer option was chosen; emitted after `changed`. */
  readonly decided = output<void>();

  protected readonly actions = ACTIONS;
  protected readonly headline = headline;
  protected readonly kindLabel = kindLabel;
  protected readonly messages = messages;

  protected decision(c: Comment) {
    return decisionOf(this.draft(), c);
  }

  protected actionOf(c: Comment) {
    return actionOf(this.draft(), c);
  }

  protected status() {
    return statusOf(this.draft(), this.entry());
  }

  /** The reply the agent prepared for a settled item, posted with the push. */
  protected agentReply(c: Comment): string | null {
    return c.state === 'fixed' || c.state === 'skipped' ? replyOf(c) : null;
  }

  protected options(q: Question): string[] {
    return q.options ? (JSON.parse(q.options) as string[]) : [];
  }

  protected decide(c: Comment, action: Action) {
    this.decision(c).action = action;
    this.changed.emit();
    this.decided.emit();
  }

  protected answer(q: Question, option: string) {
    this.draft().answers[q.id] = option;
    this.changed.emit();
    this.decided.emit();
  }
}

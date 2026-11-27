import { Component, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Finding, ReviewThread } from './api';
import type { Message } from './components/conversation';
import { ItemHead } from './components/item-head';
import { ThreadView } from './components/thread-view';
import type { ReviewEdit } from './pr-view';

/** The comments of one of my threads as conversation bubbles. */
export const threadMessages = (t: ReviewThread): Message[] => t.comments.map((c) => ({ author: c.author, at: c.at, text: c.body }));

/**
 * One finding of my review draft: the head with the include switch and, while it is included, the code or
 * thread it points to and the text I will post.
 */
@Component({
  selector: 'app-finding-card',
  imports: [FormsModule, ItemHead, ThreadView],
  template: `
    @if (finding(); as f) {
      <article class="dcard" [class.open]="!edit().skip" [class.skipped]="edit().skip">
        <app-item-head
          [num]="num()"
          [path]="f.path"
          [line]="f.line"
          [kind]="f.kind === 'finding' ? 'finding' : 'reply'"
          [url]="f.url"
          [urlLabel]="f.in_diff ? 'View in diff' : 'View on GitHub'"
        >
          @if (f.kind === 'finding' && !f.in_diff) {
            <span class="tag small warn">outside the diff, goes into the body</span>
          }
          @if (f.resolve) {
            <span class="tag small">resolves the thread</span>
          }
          <label class="switch">
            <input type="checkbox" [ngModel]="!edit().skip" (ngModelChange)="edit().skip = !$event; changed.emit()" />
            Include
          </label>
        </app-item-head>
        @if (edit().skip) {
          <div class="dcard-head muted">
            <span class="headline">{{ edit().body }}</span>
          </div>
        } @else {
          <div class="dcard-body">
            @if (thread(); as t) {
              <app-thread-view [excerpt]="t.excerpt" [path]="t.path" [messages]="threadMessages(t)" />
            } @else {
              <app-thread-view [excerpt]="f.excerpt" [path]="f.path" />
            }
            <textarea rows="4" [attr.aria-label]="'Finding ' + num()" [(ngModel)]="edit().body" (ngModelChange)="changed.emit()"></textarea>
          </div>
        }
      </article>
    }
  `,
  styles: `
    :host {
      display: block;
    }
  `,
})
export class FindingCard {
  readonly finding = input.required<Finding>();
  readonly num = input.required<number>();
  /** The draft's entry of this finding; changed in place. */
  readonly edit = input.required<ReviewEdit>();
  /** The thread a reply draft answers. */
  readonly thread = input<ReviewThread | null>(null);
  /** The draft changed in place and has to be kept. */
  readonly changed = output<void>();

  protected readonly threadMessages = threadMessages;
}

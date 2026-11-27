import { Component, input } from '@angular/core';
import type { Excerpt } from '../api';
import { CodeExcerpt } from './code-excerpt';
import { Conversation, type Message } from './conversation';

/**
 * What a thread shows: the code it points to, when there is some, and the conversation below it. The host
 * has no box of its own, so both parts take the spacing of the card body around them.
 */
@Component({
  selector: 'app-thread-view',
  imports: [CodeExcerpt, Conversation],
  template: `
    @if (excerpt(); as x) {
      @if (path(); as p) {
        <app-code-excerpt [excerpt]="x" [path]="p" />
      }
    }
    <ng-content />
    @if (messages(); as m) {
      <app-conversation [messages]="m" />
    }
  `,
  styles: `
    :host {
      display: contents;
    }
  `,
})
export class ThreadView {
  readonly excerpt = input<Excerpt | null>(null);
  readonly path = input<string | null>(null);
  /** `null` leaves the conversation out: a finding that starts a new thread has only code. */
  readonly messages = input<Message[] | null>(null);
}

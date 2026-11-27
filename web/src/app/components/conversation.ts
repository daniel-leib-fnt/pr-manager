import { DatePipe } from '@angular/common';
import { Component, input } from '@angular/core';

/** One bubble of a conversation: a review thread, a reply of mine, a comment of someone else. */
export interface Message {
  author: string;
  at: string | null;
  text: string;
}

/** The bubbles of a conversation, oldest first. */
@Component({
  selector: 'app-conversation',
  imports: [DatePipe],
  host: { class: 'conversation' },
  template: `
    @for (m of messages(); track $index) {
      <div class="bubble">
        <span class="avatar">{{ m.author.slice(0, 2) }}</span>
        <div class="bubble-body">
          <div class="bubble-meta">
            <strong>{{ m.author }}</strong>
            @if (m.at) {
              · {{ m.at | date: 'dd.MM. HH:mm' }}
            }
          </div>
          <p class="bubble-text">{{ m.text }}</p>
        </div>
      </div>
    }
  `,
})
export class Conversation {
  readonly messages = input.required<Message[]>();
}

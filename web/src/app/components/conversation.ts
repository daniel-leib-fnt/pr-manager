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
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .bubble {
      display: flex;
      gap: 10px;
      align-items: flex-start;
    }
    .avatar {
      width: 28px;
      height: 28px;
      flex: none;
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: var(--chip-bg);
      color: var(--muted);
      font: 700 11px/1 var(--sans);
      text-transform: uppercase;
    }
    .bubble-body {
      min-width: 0;
      flex: 1;
    }
    .bubble-meta {
      font-size: 12px;
      color: var(--muted);
    }
    .bubble-meta strong {
      color: var(--text);
    }
  `,
})
export class Conversation {
  readonly messages = input.required<Message[]>();
}

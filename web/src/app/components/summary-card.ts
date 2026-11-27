import { Component, input } from '@angular/core';

/** What the agent wrote about the PR, in full. */
@Component({
  selector: 'app-summary-card',
  host: { class: 'card' },
  template: `
    <div class="send-row">
      <h2>{{ title() }}</h2>
      <span class="row-time">by the agent</span>
    </div>
    <p class="pre">{{ text() || 'No summary yet.' }}</p>
  `,
  styles: `
    :host {
      display: block;
    }
  `,
})
export class SummaryCard {
  readonly title = input.required<string>();
  readonly text = input.required<string | null>();
}

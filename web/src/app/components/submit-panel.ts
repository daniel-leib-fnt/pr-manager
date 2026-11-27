import { Component, input, output } from '@angular/core';

/** One row of the counts box. */
export interface Count {
  label: string;
  value: number;
}

/** The side card that sends what I decided: a heading, the role's own controls, the counts and the submit button. */
@Component({
  selector: 'app-submit-panel',
  host: { class: 'card primary-border panel' },
  template: `
    <h2>{{ title() }}</h2>
    <ng-content />
    <div class="counts">
      @for (c of counts(); track c.label) {
        <div>
          <span>{{ c.label }}</span>
          <strong>{{ c.value }}</strong>
        </div>
      }
    </div>
    <button class="primary big" [disabled]="disabled()" (click)="send.emit()">{{ submitLabel() }}</button>
  `,
  styles: `
    .counts {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 12px;
      background: var(--surface-alt);
      border-radius: 8px;
      font-size: 13px;
    }
    .counts > div {
      display: flex;
      justify-content: space-between;
    }
    .counts strong {
      font-variant-numeric: tabular-nums;
    }
    button.big {
      height: 44px;
      font-size: 15px;
    }
  `,
})
export class SubmitPanel {
  readonly title = input.required<string>();
  readonly counts = input.required<Count[]>();
  readonly submitLabel = input.required<string>();
  readonly disabled = input.required<boolean>();
  /** Not `submit`: a native event of that name would reach the same listener. */
  readonly send = output<void>();
}

import { Component, input, output } from '@angular/core';

/** One choice of a group; the tone colors it while it is chosen. */
export interface Choice<T extends string = string> {
  value: T;
  label: string;
  tone: 'ok' | 'warn' | 'info' | 'plain';
  /** Tooltip. */
  help?: string;
}

/** A row of choices of which one is chosen, as a radio group: the decision on a proposal, the verdict of a review. */
@Component({
  selector: 'app-choice-group',
  host: { role: 'radiogroup', '[attr.aria-label]': 'label()' },
  template: `
    @for (o of options(); track o.value) {
      <button
        role="radio"
        [class]="o.tone"
        [class.on]="value() === o.value"
        [attr.aria-checked]="value() === o.value"
        [attr.title]="o.help ?? null"
        (click)="choose.emit(o.value)"
      >
        {{ o.label }}
      </button>
    }
  `,
  styles: `
    :host {
      display: grid;
      grid-auto-flow: column;
      grid-auto-columns: minmax(0, 1fr);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      overflow: hidden;
    }
    button {
      border: 0;
      border-radius: 0;
      padding: 0 6px;
      font-size: 13px;
    }
    button + button {
      border-left: 1px solid var(--border-strong);
    }
    button.on {
      font-weight: 600;
    }
    button.on.ok {
      background: var(--ok-bg);
      color: var(--ok);
    }
    button.on.warn {
      background: var(--warn-bg);
      color: var(--warn);
    }
    button.on.info {
      background: var(--info-bg);
      color: var(--info);
    }
    button.on.plain {
      background: var(--chip-bg);
      color: var(--text);
    }
  `,
})
export class ChoiceGroup<T extends string> {
  readonly options = input.required<Choice<T>[]>();
  /** The chosen value; `''` while nothing is chosen. */
  readonly value = input.required<T | ''>();
  /** Accessible name of the group. */
  readonly label = input.required<string>();
  /** Emits on every click, also on the choice that is already chosen: choosing again moves on to the next card. */
  readonly choose = output<T>();
}

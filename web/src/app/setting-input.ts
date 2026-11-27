import { Component, input, model } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Setting } from './api';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The control of one setting, by its type; the value is the editable draft form (`toDraft` in `settings.ts`). */
@Component({
  selector: 'app-setting-input',
  imports: [FormsModule],
  template: `
    @if (setting(); as s) {
      @switch (s.type) {
        @case ('boolean') {
          <label class="inline">
            <input type="checkbox" [(ngModel)]="value" />
            enabled
          </label>
        }
        @case ('number') {
          <input type="number" class="narrow" [(ngModel)]="value" />
        }
        @case ('string') {
          <input [(ngModel)]="value" />
        }
        @case ('enum') {
          <select [(ngModel)]="value">
            @for (o of s.options; track o.value) {
              <option [value]="o.value">{{ o.label }}</option>
            }
          </select>
        }
        @case ('days') {
          <div class="choice">
            @for (d of days; track $index) {
              <label class="inline">
                <input type="checkbox" [checked]="has($index)" (change)="flip($index)" />
                {{ d }}
              </label>
            }
          </div>
        }
        @case ('multi') {
          <div class="choice">
            @for (o of s.options; track o.value) {
              <label class="inline">
                <input type="checkbox" [checked]="has(o.value)" (change)="flip(o.value)" />
                {{ o.label }}
              </label>
            }
          </div>
        }
        @default {
          <textarea [rows]="s.type === 'text' ? 8 : 5" [(ngModel)]="value"></textarea>
        }
      }
    }
  `,
  styles: `
    :host {
      display: contents;
    }
    label.inline {
      display: inline-flex;
      gap: 5px;
      align-items: center;
      margin: 0 12px 0 0;
      color: var(--text);
      font-size: 14px;
    }
    .choice label {
      display: flex;
      gap: 5px;
      align-items: center;
      margin: 0;
      color: var(--text);
      font-size: 14px;
    }
  `,
})
export class SettingInput {
  readonly setting = input.required<Setting>();
  readonly value = model.required<unknown>();

  protected readonly days = DAYS;

  protected has(v: unknown): boolean {
    return (this.value() as unknown[]).includes(v);
  }

  protected flip(v: unknown) {
    const list = this.value() as unknown[];
    this.value.set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v].sort());
  }
}

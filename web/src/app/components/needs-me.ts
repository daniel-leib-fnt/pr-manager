import { DatePipe } from '@angular/common';
import { Component, input, output } from '@angular/core';
import { type ActionRequest, type NeedsItem, plural } from '../pr-view';

/** Everything that waits for me on this PR, one row per to-do with its buttons. */
@Component({
  selector: 'app-needs-me',
  imports: [DatePipe],
  host: { class: 'card pad-0', id: 'needs-me' },
  template: `
    <div class="card-head">
      <h2>Needs me</h2>
      <span class="row-time">{{ plural(items().length, 'item') }}</span>
    </div>
    @for (i of items(); track i.key) {
      <div class="row-item">
        <span class="dot" [class]="i.tone ?? 'warn'"></span>
        <div class="row-body">
          <strong>{{ i.title }}</strong>
          @if (i.at) {
            <span class="row-time">· {{ i.at | date: 'dd.MM. HH:mm' }}</span>
          }
          @if (i.text) {
            <div class="pre">{{ i.text }}</div>
          }
          @if (i.mono || i.sub) {
            <div class="row-sub">
              @if (i.mono) {
                <span class="mono">{{ i.mono }}</span>
              }
              {{ i.sub }}
            </div>
          }
        </div>
        @for (a of i.actions; track a.label) {
          @if (a.href) {
            @if (a.primary) {
              <a class="button-link small" [href]="a.href" target="_blank" rel="noopener">{{ a.label }}</a>
            } @else {
              <a class="button small" [href]="a.href" target="_blank" rel="noopener">{{ a.label }}</a>
            }
          } @else if (a.tab) {
            <button class="small" [class.primary]="a.primary" (click)="openTab.emit(a.tab)">{{ a.label }}</button>
          } @else if (a.request) {
            <button class="small" [class.primary]="a.primary" [disabled]="busy()" (click)="action.emit(a.request)">{{ a.label }}</button>
          }
        }
      </div>
    } @empty {
      <div class="row-item"><span class="muted">Nothing waits for me.</span></div>
    }
  `,
  styles: `
    :host {
      display: block;
    }
  `,
})
export class NeedsMe {
  readonly items = input.required<NeedsItem[]>();
  readonly busy = input.required<boolean>();
  readonly action = output<ActionRequest>();
  /** The id of the tab a button asks to open. */
  readonly openTab = output<string>();
  protected readonly plural = plural;
}

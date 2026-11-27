import { DatePipe } from '@angular/common';
import { Component, computed, input, output } from '@angular/core';
import type { WorkItem } from '../api';
import { WORK_LABEL } from '../pr-view';

/** The agent's work items, newest first: the whole Activity tab, or the last few on the Overview. */
@Component({
  selector: 'app-work-list',
  imports: [DatePipe],
  host: { class: 'card pad-0' },
  template: `
    <div class="card-head">
      <h2>{{ title() }}</h2>
      @if (limit()) {
        <button class="link" (click)="showAll.emit()">All activity</button>
      }
    </div>
    @for (w of rows(); track w.id) {
      <div class="row-item center">
        <span class="chip" [class.error]="w.state === 'failed'" [class.live]="w.state === 'in_progress'">{{ w.state }}</span>
        <div class="row-body">
          {{ label[w.kind] }}
          @if (w.error) {
            <div class="error-text">{{ w.error }}</div>
          }
        </div>
        <span class="row-time">{{ w.finished_at ?? w.started_at ?? w.created_at | date: 'dd.MM. HH:mm' }}</span>
      </div>
    } @empty {
      <div class="row-item"><span class="muted">Nothing yet.</span></div>
    }
  `,
})
export class WorkList {
  readonly title = input.required<string>();
  readonly work = input.required<WorkItem[]>();
  /** How many rows to show; 0 shows all. */
  readonly limit = input(0);
  readonly showAll = output<void>();

  protected readonly label = WORK_LABEL;
  protected readonly rows = computed(() => {
    const rows = this.work().slice().reverse();
    return this.limit() ? rows.slice(0, this.limit()) : rows;
  });
}

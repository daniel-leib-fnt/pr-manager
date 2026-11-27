import { Component, input } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import type { Pr } from './api';
import { Ci } from './components/ci';
import { nextStep } from './pr-view';

/** One PR of the sidebar list: role and state tags, repository, build status, title and the next step. */
@Component({
  selector: 'app-pr-list-item',
  imports: [RouterLink, RouterLinkActive, Ci],
  template: `
    <a [routerLink]="['/pr', pr().id]" routerLinkActive="active" class="pr-item">
      <span class="pr-line1">
        <span class="tag small" [class]="pr().role">{{ pr().role === 'own' ? 'Mine' : 'Review' }}</span>
        @if (pr().blocked) {
          <span class="tag small bad">Blocked</span>
        }
        @if (pr().openTasks) {
          <span class="tag small warn" [title]="pr().openTasks + ' unchecked task lines'">Open Tasks</span>
        }
        @if (pr().nudge) {
          <span class="tag small warn" title="Waited on others too long; follow up with the reviewers">Follow up</span>
        }
        @if (pr().noBuild) {
          <span class="tag small bad" title="No build ran for this head; the review waits for me">No build</span>
        }
        <span class="ref">{{ shortRepo(pr().repo) }}#{{ pr().number }}</span>
        <app-ci [state]="pr().check_state" />
      </span>
      <span class="pr-title">{{ pr().title }}</span>
      <span class="pr-next">{{ next(pr()) }}</span>
    </a>
  `,
  styles: `
    :host {
      display: block;
    }
    .pr-item {
      display: flex;
      flex-direction: column;
      gap: 2px;
      margin: 0 8px;
      padding: 8px 10px;
      border-radius: 8px;
      color: inherit;
    }
    .pr-item:hover {
      background: var(--surface-alt);
      text-decoration: none;
    }
    .pr-item.active {
      background: var(--mine-bg);
      box-shadow: inset 0 0 0 1px var(--primary-200);
    }
    @media (prefers-color-scheme: dark) {
      .pr-item.active {
        box-shadow: inset 0 0 0 1px var(--primary-500);
      }
    }
    .pr-line1 {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .pr-line1 app-ci {
      display: flex;
      margin-left: auto;
    }
    .ref {
      font-family: var(--mono);
      font-size: 12px;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .pr-title {
      font-weight: 600;
      color: var(--text-strong);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .pr-next {
      font-size: 12px;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  `,
})
export class PrListItem {
  readonly pr = input.required<Pr>();
  protected readonly next = nextStep;

  /** The owner is the same for all repositories, so the list shows the repository name only. */
  protected shortRepo(repo: string) {
    return repo.split('/').pop();
  }
}

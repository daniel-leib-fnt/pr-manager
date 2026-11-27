import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { Component, TemplateRef, computed, input, model, output } from '@angular/core';
import type { Pr } from './api';
import { type ActionRequest, ROLE_LABEL, type RoleTab } from './pr-view';

/**
 * The header of a PR page: tags, title, meta line, the actions and the tab bar. The role's tags, meta entries and
 * tabs come in as inputs: the page binds them where the role component is ready (see `pr-page.ts`), so this
 * component never reads the role itself.
 */
@Component({
  selector: 'app-pr-header',
  imports: [DatePipe, NgTemplateOutlet],
  template: `
    @if (pr(); as p) {
      <header class="pr-header">
        <div class="page">
          <div class="pr-head-row">
            <div class="pr-head-main">
              <div class="tag-row">
                <span class="tag" [class]="p.role">{{ roleLabel[p.role] }}</span>
                <ng-container *ngTemplateOutlet="tags()" />
                @if (p.is_draft) {
                  <span class="tag">Draft</span>
                }
                @if (p.state !== 'open') {
                  <span class="tag">{{ p.state }}</span>
                }
                @if (p.paused) {
                  <span class="tag">Paused</span>
                }
                @if (p.ignored) {
                  <span class="tag">Ignored</span>
                }
              </div>
              <h1>{{ p.title }}</h1>
              <div class="meta">
                <ng-container *ngTemplateOutlet="meta()" />
                <a [href]="p.url" target="_blank" rel="noopener">{{ p.repo }}#{{ p.number }} ↗</a>
                @if (p.gh_updated_at) {
                  <span>updated {{ p.gh_updated_at | date: 'dd.MM. HH:mm' }}</span>
                }
              </div>
            </div>
            <div class="actions">
              @if (p.paused) {
                <button (click)="act('resume')">Resume agent</button>
              } @else {
                <button (click)="act('pause')">Pause agent</button>
              }
              @if (p.role === 'review' && p.ignored) {
                <button (click)="act('unignore')">Stop ignoring</button>
              } @else if (p.role === 'review' && p.state === 'open') {
                <button (click)="act('ignore')">Ignore review</button>
              }
              @if (moreActions()) {
                <button aria-label="More actions" [attr.aria-expanded]="menuOpen()" (click)="menuOpen.set(!menuOpen())">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <circle cx="5" cy="12" r="1.8" />
                    <circle cx="12" cy="12" r="1.8" />
                    <circle cx="19" cy="12" r="1.8" />
                  </svg>
                </button>
                @if (menuOpen()) {
                  <div class="menu" role="menu">
                    @if (p.role === 'review') {
                      <button role="menuitem" (click)="act('followup-review')">Review again</button>
                    } @else if (p.counts.proposals || p.counts.questions) {
                      <button role="menuitem" (click)="act('followup-review')">Check open items again</button>
                    }
                    @if (p.session_id && !p.agent_running) {
                      <button role="menuitem" (click)="confirmAct('reset-session', 'Start a fresh agent session for this PR?')">
                        Reset session
                      </button>
                    }
                    @if (p.state === 'closed') {
                      <button role="menuitem" (click)="confirmAct('remove-worktree', 'Remove the worktree of this closed PR?')">
                        Remove worktree
                      </button>
                    }
                  </div>
                }
              }
            </div>
          </div>
          @if (p.blocked) {
            <div class="banner error">
              <strong>Blocked.</strong>
              {{ p.blocked }}
              <button class="small" (click)="act('unblock')">Retry</button>
            </div>
          }
          @if (error()) {
            <div class="banner error">{{ error() }}</div>
          }
          <nav class="tabs" aria-label="Sections">
            <button class="tab" [class.on]="tab() === 'overview'" (click)="tab.set('overview')">Overview</button>
            @for (t of tabs(); track t.id) {
              <button class="tab" [class.on]="tab() === t.id" (click)="tab.set(t.id)">
                {{ t.label }}
                @if (t.badge) {
                  <span class="tag small" [class]="t.badgeClass ?? ''">{{ t.badge }}</span>
                }
              </button>
            }
            <button class="tab" [class.on]="tab() === 'activity'" (click)="tab.set('activity')">Activity</button>
            <button class="tab" [class.on]="tab() === 'transcript'" (click)="tab.set('transcript')">
              Agent transcript
              @if (p.agent_running) {
                <span class="tag small info">working</span>
              }
            </button>
          </nav>
        </div>
      </header>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .pr-header {
      background: var(--surface);
      border-bottom: 1px solid var(--border);
    }
    .pr-header .page {
      padding-bottom: 0;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .pr-head-row {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      align-items: flex-start;
      justify-content: space-between;
    }
    .pr-head-main {
      flex: 1 1 520px;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .tag-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 16px;
      font-size: 13px;
      color: var(--muted);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      position: relative;
    }
    .menu {
      position: absolute;
      top: 40px;
      right: 0;
      z-index: 5;
      display: flex;
      flex-direction: column;
      min-width: 200px;
      padding: 4px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(16, 24, 40, 0.12);
    }
    .menu button {
      justify-content: flex-start;
      border: 0;
      background: none;
    }
    .menu button:hover:not(:disabled) {
      background: var(--hover);
    }
    .tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 24px;
    }
    .tab {
      height: auto;
      padding: 10px 2px;
      border: 0;
      border-bottom: 2px solid transparent;
      border-radius: 0;
      background: none;
      color: var(--muted);
    }
    .tab:hover:not(:disabled) {
      background: none;
      color: var(--text);
    }
    .tab.on {
      border-bottom-color: var(--navy);
      color: var(--text-strong);
      font-weight: 600;
    }
    @media (prefers-color-scheme: dark) {
      .tab.on {
        border-bottom-color: var(--primary-200);
      }
    }
  `,
})
export class PrHeader {
  readonly pr = input.required<Pr>();
  /** The role's tags, shown after the role tag. */
  readonly tags = input<TemplateRef<unknown> | null>(null);
  /** The role's entries of the meta line. */
  readonly meta = input<TemplateRef<unknown> | null>(null);
  /** The tabs of the role, between Overview and Activity. */
  readonly tabs = input.required<RoleTab[]>();
  readonly error = input<string | null>(null);
  /** The showing tab; the page keeps it, because it also switches tabs from the Overview. */
  readonly tab = model.required<string>();
  /** The page keeps it too: every action closes the menu, whatever sent it. */
  readonly menuOpen = model(false);
  readonly action = output<ActionRequest>();

  protected readonly roleLabel = ROLE_LABEL;

  protected readonly moreActions = computed(() => {
    const pr = this.pr();
    return (pr.role === 'review' && pr.review_state === 'submitted') || (!!pr.session_id && !pr.agent_running) || pr.state === 'closed';
  });

  protected act(name: string) {
    this.action.emit({ name });
  }

  protected confirmAct(name: string, question: string) {
    this.action.emit({ name, confirm: question });
  }
}

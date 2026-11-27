import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { Api, type PrDetail } from './api';
import { DetailsPanel } from './components/details-panel';
import { InstructionBox } from './components/instruction-box';
import { NeedsMe } from './components/needs-me';
import { OwnPr } from './own-pr';
import { PrHeader } from './pr-header';
import {
  type ActionRequest,
  type NeedsItem,
  type RoleRegions,
  agentTile,
  buildTile,
  emptyDraft,
  loadDraft,
  plural,
  saveDraft,
} from './pr-view';
import { ReviewPr } from './review-pr';
import { StatusTiles } from './components/status-tiles';
import { SummaryCard } from './components/summary-card';
import { Transcript } from './transcript';
import { WorkList } from './components/work-list';

/**
 * The frame every PR page shares: header, tabs, Overview, activity, transcript and the instruction box. What
 * belongs to one role lives in its component (`own-pr.ts`, `review-pr.ts`), which fills its tabs and gives the
 * Overview its tiles and to-dos.
 */
@Component({
  selector: 'app-pr-page',
  imports: [
    NgTemplateOutlet,
    Transcript,
    PrHeader,
    OwnPr,
    ReviewPr,
    StatusTiles,
    NeedsMe,
    SummaryCard,
    WorkList,
    DetailsPanel,
    InstructionBox,
  ],
  template: `
    @if (data(); as d) {
      <!-- The role component comes first: the regions below render its templates, which read its inputs, so the
           inputs have to be bound before those regions are checked (NG0950 otherwise). Its host is display: none. -->
      @if (d.pr.role === 'own') {
        <app-own-pr
          [pr]="d.pr"
          [comments]="d.comments"
          [questions]="d.questions"
          [draft]="draft()"
          [busy]="busy()"
          (changed)="persist()"
          (action)="request($event)"
          (openTab)="tab.set($event)"
        />
      } @else {
        <app-review-pr
          [pr]="d.pr"
          [findings]="d.findings"
          [threads]="d.threads"
          [draft]="draft()"
          [busy]="busy()"
          (changed)="persist()"
          (action)="request($event)"
        />
      }

      <!-- Everything below reads the role's signals (tabs, tiles, to-dos), which read its inputs. Those are bound when
           the role's own embedded view is checked, after this view's bindings; an embedded view declared after it is
           checked later, so the reads find the inputs set. The header is a component of its own, but its role inputs
           (tags, meta, tabs) are bound here, so it has to stay inside this block. -->
      @if (role()) {
        <app-pr-header
          [pr]="d.pr"
          [tags]="region('tags')"
          [meta]="region('meta')"
          [tabs]="roleTabs()"
          [error]="error()"
          [(tab)]="tab"
          [(menuOpen)]="menuOpen"
          (action)="request($event)"
        />

        <div class="page pr-body">
          @if (tab() === 'overview') {
            <app-status-tiles [tiles]="tiles()" (openTab)="tab.set($event)" />
          }
          <div class="main-col">
            @switch (tab()) {
              @case ('overview') {
                <app-needs-me [items]="needs()" [busy]="busy()" (action)="request($event)" (openTab)="tab.set($event)" />
                <app-summary-card [title]="role()?.summaryTitle ?? 'Summary'" [text]="d.pr.summary" />
                @if (role()?.recentActivity) {
                  <app-work-list title="Recent activity" [work]="d.work" [limit]="4" (showAll)="tab.set('activity')" />
                }
              }
              @case ('activity') {
                <app-work-list title="Activity" [work]="d.work" />
              }
              @case ('transcript') {
                <section class="card">
                  <h2>Agent transcript</h2>
                  <app-transcript [prId]="d.pr.id" [sessionId]="d.pr.session_id" />
                </section>
              }
              @default {
                <ng-container *ngTemplateOutlet="roleTab()?.main ?? null" />
              }
            }
          </div>

          <aside class="side-col">
            <ng-container *ngTemplateOutlet="roleTab()?.side ?? null" />
            <app-instruction-box [draft]="draft()" [busy]="busy()" (changed)="persist()" (send)="instruct()" />
            @if (tab() === 'overview') {
              <app-details-panel [pr]="d.pr" [lastRun]="lastRun()" [push]="role()?.push?.() ?? null" />
            }
          </aside>
        </div>
      }
    } @else {
      <p class="muted page">Loading…</p>
    }
  `,
  styles: `
    .pr-body {
      display: flex;
      flex-wrap: wrap;
      gap: 24px;
      align-items: flex-start;
    }
    .main-col {
      flex: 999 1 600px;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .side-col {
      flex: 1 1 320px;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 16px;
      position: sticky;
      top: 24px;
    }
  `,
})
export class PrPage {
  private readonly api = inject(Api);
  readonly id = input.required<string>();
  protected readonly plural = plural;
  protected readonly data = signal<PrDetail | null>(null);
  protected readonly draft = signal(emptyDraft());
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly tab = signal<string>('overview');
  protected readonly menuOpen = signal(false);

  private readonly prId = computed(() => Number(this.id()));

  /** The component of the PR's role; it fills the regions of this page. */
  private readonly own = viewChild(OwnPr);
  private readonly review = viewChild(ReviewPr);
  protected readonly role = computed<RoleRegions | undefined>(() => this.own() ?? this.review());

  protected readonly roleTabs = computed(() => this.role()?.tabs() ?? []);
  /** The tab of the role that is showing, if the current one is not a tab of the frame. */
  protected readonly roleTab = computed(() => this.roleTabs().find((t) => t.id === this.tab()) ?? null);
  /** The latest work item that started; `findLast` is not in the compile target. */
  protected readonly lastRun = computed(() => [...(this.data()?.work ?? [])].reverse().find((w) => w.started_at) ?? null);
  /** Build, the role's tiles, Agent. */
  protected readonly tiles = computed(() => {
    const d = this.data();
    return d ? [buildTile(d.pr), ...(this.role()?.tiles() ?? []), agentTile(d.pr, this.lastRun())] : [];
  });
  /** What the agent left me to do or check, until I tick it off; to-dos before notes. */
  private readonly followUps = computed<NeedsItem[]>(() =>
    (this.data()?.followUps ?? [])
      .filter((f) => f.state === 'open')
      .sort((a, b) => Number(b.severity === 'action') - Number(a.severity === 'action'))
      .map((f) => ({
        key: `follow-up-${f.id}`,
        title: f.severity === 'info' ? 'Note from the agent' : 'Follow-up from the agent',
        at: f.created_at,
        text: f.text,
        tone: f.severity === 'info' ? 'info' : 'warn',
        actions: [{ label: f.severity === 'info' ? 'Dismiss' : 'Done', request: { name: 'follow-up-done', body: { id: f.id } } }],
      })),
  );
  protected readonly needs = computed(() => [...(this.role()?.needs() ?? []), ...this.followUps()]);

  constructor() {
    // Switching PRs in the sidebar reuses this page: drop the previous PR right away.
    effect(() => {
      const id = this.prId();
      this.data.set(null);
      this.draft.set(loadDraft(id));
      this.tab.set('overview');
      this.menuOpen.set(false);
    });
    effect(() => {
      this.api.version();
      void this.load(this.prId());
    });
  }

  private async load(id: number) {
    const d = await this.api.pr(id);
    if (id !== this.prId()) return; // a slower answer for a PR that is no longer open
    this.data.set(d);
  }

  /** A region of the role component, or nothing while it is not there yet. */
  protected region(name: 'tags' | 'meta') {
    return this.role()?.[name]?.() ?? null;
  }

  protected persist() {
    this.draft.set({ ...this.draft() });
    saveDraft(this.prId(), this.draft());
  }

  private async run(fn: () => Promise<unknown>) {
    this.busy.set(true);
    this.error.set(null);
    this.menuOpen.set(false);
    try {
      await fn();
      await this.load(this.prId());
    } catch (e) {
      const err = e as { error?: { error?: string }; message?: string };
      this.error.set(err.error?.error ?? err.message ?? String(e));
    } finally {
      this.busy.set(false);
    }
  }

  /** Runs what a role component asked for; `done` runs after the call succeeded, before the PR is reloaded. */
  protected request(r: ActionRequest) {
    if (r.confirm && !confirm(r.confirm)) return;
    void this.run(async () => {
      await this.api.action(this.prId(), r.name, r.body);
      r.done?.();
    });
  }

  protected instruct() {
    const d = this.draft();
    if (!d.instruction.trim() || this.busy()) return;
    void this.run(async () => {
      await this.api.action(this.prId(), 'instruction', { text: d.instruction });
      d.instruction = '';
      this.persist();
    });
  }
}

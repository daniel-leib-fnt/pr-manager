import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, type DeniedCall, type NixOnly, type Setting } from './api';
import { SettingInput } from './setting-input';

/** Editable text form of a value; lists are one entry per line, maps one "key value" per line. */
function toDraft(s: Setting): unknown {
  if (s.type === 'list') return (s.value as string[]).join('\n');
  if (s.type === 'map')
    return Object.entries(s.value as Record<string, unknown>)
      .map(([k, v]) => `${k} ${v}`)
      .join('\n');
  if (s.type === 'days' || s.type === 'multi') return [...(s.value as unknown[])];
  return s.value;
}

const lines = (draft: unknown) =>
  String(draft)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

function fromDraft(s: Setting, draft: unknown): unknown {
  if (s.type === 'list') return lines(draft);
  // A line without a number becomes NaN, which the server rejects with a message.
  if (s.type === 'map')
    return Object.fromEntries(
      lines(draft)
        .map((l) => l.split(/\s+/))
        .map(([k, v]) => [k, Number(v)]),
    );
  if (s.type === 'number') return Number(draft);
  return draft;
}

@Component({
  selector: 'app-settings',
  imports: [FormsModule, SettingInput],
  host: { class: 'page' },
  template: `
    <h1>Settings</h1>
    <p class="muted">Changes apply on the next poll or agent run. Reset returns to the Home Manager value or the built-in default.</p>
    @if (error()) {
      <div class="banner error">{{ error() }}</div>
    }

    @for (g of groups(); track g.name) {
      <section class="card">
        <h2>{{ g.name }}</h2>
        @for (s of g.settings; track s.key) {
          <div class="setting">
            <div class="setting-head">
              <strong>{{ s.label }}</strong>
              <span class="chip" [class.need]="s.source === 'override'">{{ sourceLabel(s) }}</span>
            </div>
            @if (s.help) {
              <p class="muted small">{{ s.help }}</p>
            }
            <app-setting-input [setting]="s" [(value)]="drafts[s.key]" />
            <div class="setting-actions">
              <button (click)="save(s)" [disabled]="!dirty(s) || busy()">Save</button>
              @if (s.source === 'override') {
                <button class="subtle" (click)="reset(s)" [disabled]="busy()">Reset</button>
              }
            </div>
          </div>
        }
        @if (g.name === 'Agent' && denied().length) {
          <div class="setting">
            <strong>Recently denied tool calls</strong>
            <p class="muted small">Allow adds the proposed rule to the allowed tools; edit it first if it is too broad.</p>
            <ul class="items">
              @for (d of denied(); track $index) {
                <li>
                  <code>{{ d.tool }}</code>
                  {{ d.pr }}
                  <span class="muted">{{ d.detail.slice(0, 160) }}</span>
                  <div class="choice">
                    <input class="grow" [(ngModel)]="d.rule" />
                    <button (click)="allow(d)" [disabled]="busy()">Allow</button>
                  </div>
                </li>
              }
            </ul>
          </div>
        }
      </section>
    }

    <section class="card">
      <h2>Home Manager only</h2>
      <p class="muted small">These need a rebuild because the daemon needs them before it starts or because changing them moves files.</p>
      <ul class="items">
        @for (n of nixOnly(); track n.option) {
          <li>
            <strong>{{ n.label }}:</strong>
            <code>{{ n.value }}</code>
            <span class="muted">({{ n.option }})</span>
          </li>
        }
      </ul>
    </section>
  `,
  styles: `
    .items {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .items li {
      padding: 8px 0;
      border-top: 1px solid var(--border);
    }
    .items li:first-child {
      border-top: 0;
    }
    .setting {
      border-top: 1px solid var(--border);
      padding: 12px 0;
    }
    .setting:first-of-type {
      border-top: 0;
      padding-top: 0;
    }
    .setting-head {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .setting-actions {
      display: flex;
      gap: 8px;
      margin-top: 6px;
    }
    .card + .card {
      margin-top: 16px;
    }
  `,
})
export class SettingsPage {
  private readonly api = inject(Api);
  protected readonly settings = signal<Setting[]>([]);
  protected readonly nixOnly = signal<NixOnly[]>([]);
  protected readonly denied = signal<DeniedCall[]>([]);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected drafts: Record<string, unknown> = {};
  protected readonly groups = computed(() => {
    const out: { name: string; settings: Setting[] }[] = [];
    for (const s of this.settings()) {
      let g = out.find((x) => x.name === s.group);
      if (!g) out.push((g = { name: s.group, settings: [] }));
      g.settings.push(s);
    }
    return out;
  });

  constructor() {
    void this.load();
  }

  private apply(settings: Setting[]) {
    this.settings.set(settings);
    this.drafts = Object.fromEntries(settings.map((s) => [s.key, toDraft(s)]));
  }

  private async load() {
    const res = await this.api.settings();
    this.apply(res.settings);
    this.nixOnly.set(res.nixOnly);
    this.denied.set(res.denied);
  }

  protected sourceLabel(s: Setting): string {
    return { override: 'changed here', nix: 'from Home Manager', default: 'default' }[s.source];
  }

  protected dirty(s: Setting): boolean {
    return JSON.stringify(fromDraft(s, this.drafts[s.key])) !== JSON.stringify(s.value);
  }

  private async run(fn: () => Promise<{ settings: Setting[] }>) {
    this.busy.set(true);
    this.error.set(null);
    try {
      this.apply((await fn()).settings);
    } catch (e) {
      const err = e as { error?: { error?: string }; message?: string };
      this.error.set(err.error?.error ?? err.message ?? String(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected save(s: Setting) {
    void this.run(() => this.api.saveSettings({ [s.key]: fromDraft(s, this.drafts[s.key]) }));
  }

  protected reset(s: Setting) {
    void this.run(() => this.api.resetSetting(s.key));
  }

  protected allow(d: DeniedCall) {
    const current = (this.settings().find((s) => s.key === 'allowedTools')?.value as string[]) ?? [];
    if (current.includes(d.rule)) return;
    void this.run(async () => {
      const res = await this.api.saveSettings({ allowedTools: [...current, d.rule.trim()] });
      this.denied.update((list) => list.filter((x) => x.rule !== d.rule));
      return res;
    });
  }
}

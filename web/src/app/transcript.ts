import { Component, DestroyRef, effect, inject, input, signal } from '@angular/core';
import { Api } from './api';

interface Block {
  kind: 'text' | 'tool' | 'result' | 'note';
  text: string;
  title?: string;
  error?: boolean;
}

interface Entry {
  role: 'assistant' | 'user' | 'system';
  blocks: Block[];
}

const shorten = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

function toolTitle(name: string, input: Record<string, unknown>): string {
  const hint = input['command'] ?? input['file_path'] ?? input['pattern'] ?? input['path'] ?? input['commentId'] ?? '';
  return `${name.replace(/^mcp__pr__/, 'pr.')} ${shorten(String(hint), 120)}`.trim();
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === 'object' && 'text' in c ? String(c.text) : '')).join('\n');
  return JSON.stringify(content);
}

/** Normalizes stored session messages and live SDK messages to one shape. */
function toEntry(raw: unknown): Entry | null {
  const m = raw as { type?: string; subtype?: string; message?: { content?: unknown }; result?: string; is_error?: boolean; total_cost_usd?: number; num_turns?: number };
  if (m.type === 'result') {
    const cost = m.total_cost_usd !== undefined ? ` · $${m.total_cost_usd.toFixed(2)}` : '';
    return { role: 'system', blocks: [{ kind: 'note', text: `Run finished: ${m.subtype}${cost}${m.num_turns ? ` · ${m.num_turns} turns` : ''}`, error: m.is_error }] };
  }
  if (m.type !== 'assistant' && m.type !== 'user') return null;
  const content = m.message?.content;
  const blocks: Block[] = [];
  if (typeof content === 'string') blocks.push({ kind: 'text', text: content });
  else if (Array.isArray(content)) {
    for (const b of content as Record<string, unknown>[]) {
      if (b['type'] === 'text' && String(b['text']).trim()) blocks.push({ kind: 'text', text: String(b['text']) });
      if (b['type'] === 'tool_use') {
        const input = (b['input'] ?? {}) as Record<string, unknown>;
        blocks.push({ kind: 'tool', title: toolTitle(String(b['name']), input), text: JSON.stringify(input, null, 2) });
      }
      if (b['type'] === 'tool_result') {
        const text = resultText(b['content']);
        blocks.push({ kind: 'result', title: shorten(text.split('\n')[0] ?? '', 120), text: shorten(text, 20_000), error: !!b['is_error'] });
      }
    }
  }
  return blocks.length ? { role: m.type, blocks } : null;
}

@Component({
  selector: 'app-transcript',
  template: `
    <div class="transcript">
      @for (e of entries(); track $index) {
        <div class="entry" [class]="e.role">
          @for (b of e.blocks; track $index) {
            @switch (b.kind) {
              @case ('text') { <div class="text">{{ b.text }}</div> }
              @case ('note') { <div class="note" [class.error]="b.error">{{ b.text }}</div> }
              @default {
                <details [class]="b.kind" [class.error]="b.error">
                  <summary>{{ b.kind === 'tool' ? '▸ ' : '↳ ' }}{{ b.title }}</summary>
                  <pre>{{ b.text }}</pre>
                </details>
              }
            }
          }
        </div>
      } @empty {
        <p class="muted">No agent activity yet.</p>
      }
    </div>
  `,
})
export class Transcript {
  private readonly api = inject(Api);
  readonly prId = input.required<number>();
  readonly sessionId = input<string | null>(null);
  protected readonly entries = signal<Entry[]>([]);

  constructor() {
    effect(() => {
      const id = this.prId();
      this.sessionId();
      void this.api.transcript(id).then((msgs) => this.entries.set(msgs.map(toEntry).filter((e): e is Entry => !!e)));
    });
    const sub = this.api.events.subscribe((e) => {
      if (e.prId !== this.prId()) return;
      if (e.type === 'message') {
        const entry = toEntry(e.message);
        if (entry) this.entries.update((list) => [...list, entry]);
      }
      if (e.type === 'denied') {
        this.entries.update((list) => [...list, { role: 'system', blocks: [{ kind: 'note', text: `Denied: ${e.tool} ${e.detail ?? ''}`, error: true }] }]);
      }
    });
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());
  }
}

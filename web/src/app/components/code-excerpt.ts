import { Component, computed, effect, input, signal } from '@angular/core';
import type { HighlighterCore, LanguageInput } from 'shiki/core';
import type { Excerpt } from '../api';

interface Lang {
  id: string;
  name: string;
  load: () => LanguageInput;
}

const kotlin: Lang = { id: 'kotlin', name: 'Kotlin', load: () => import('shiki/langs/kotlin.mjs') };
const typescript: Lang = { id: 'typescript', name: 'TypeScript', load: () => import('shiki/langs/typescript.mjs') };
const javascript: Lang = { id: 'javascript', name: 'JavaScript', load: () => import('shiki/langs/javascript.mjs') };
const yaml: Lang = { id: 'yaml', name: 'YAML', load: () => import('shiki/langs/yaml.mjs') };
const shell: Lang = { id: 'shellscript', name: 'Shell', load: () => import('shiki/langs/shellscript.mjs') };

/** Languages by file extension; each grammar is a chunk of its own, loaded the first time it is needed. */
const LANGS: Record<string, Lang> = {
  kt: kotlin,
  kts: kotlin,
  ts: typescript,
  tsx: typescript,
  mts: typescript,
  js: javascript,
  mjs: javascript,
  json: { id: 'json', name: 'JSON', load: () => import('shiki/langs/json.mjs') },
  xml: { id: 'xml', name: 'XML', load: () => import('shiki/langs/xml.mjs') },
  yml: yaml,
  yaml,
  java: { id: 'java', name: 'Java', load: () => import('shiki/langs/java.mjs') },
  adoc: { id: 'asciidoc', name: 'AsciiDoc', load: () => import('shiki/langs/asciidoc.mjs') },
  md: { id: 'markdown', name: 'Markdown', load: () => import('shiki/langs/markdown.mjs') },
  nix: { id: 'nix', name: 'Nix', load: () => import('shiki/langs/nix.mjs') },
  sh: shell,
  bash: shell,
};

let core: Promise<HighlighterCore> | undefined;
const loaded = new Map<string, Promise<void>>();

/** One highlighter for the page, with the JavaScript regex engine instead of WebAssembly. */
async function highlighter(lang: Lang): Promise<HighlighterCore> {
  core ??= Promise.all([import('shiki/core'), import('shiki/engine/javascript')]).then(
    ([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) =>
      createHighlighterCore({
        themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')],
        langs: [],
        engine: createJavaScriptRegexEngine(),
      }),
  );
  const h = await core;
  if (!loaded.has(lang.id)) loaded.set(lang.id, h.loadLanguage(lang.load()));
  await loaded.get(lang.id);
  return h;
}

interface Token {
  content: string;
  /** Light color plus `--shiki-dark`, which the stylesheet switches to in dark mode. */
  style: Record<string, string> | null;
}

/** The lines around a commented line, highlighted for its language; plain text until the grammar has loaded. */
@Component({
  selector: 'app-code-excerpt',
  template: `
    <div class="code">
      <div class="code-head">
        <span class="lang">{{ lang()?.name ?? 'Text' }}</span>
        <span class="range">lines {{ excerpt().start }}–{{ excerpt().start + lines().length - 1 }}</span>
      </div>
      <div class="code-lines">
        @for (l of lines(); track $index) {
          <div class="ln" [class.hit]="excerpt().start + $index === excerpt().line">
            <span class="ln-no">{{ excerpt().start + $index }}</span>
            <span class="ln-src">
              @for (t of l; track $index) {
                <span [style]="t.style">{{ t.content }}</span>
              }
            </span>
          </div>
        }
      </div>
    </div>
  `,
  styles: `
    .code {
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--surface-alt);
      overflow: hidden;
    }
    .code-head {
      display: flex;
      gap: 8px;
      align-items: center;
      padding: 6px 12px;
      border-bottom: 1px solid var(--border);
      background: var(--surface);
      font-size: 12px;
      color: var(--muted);
    }
    .code-head .lang {
      display: inline-flex;
      align-items: center;
      height: 20px;
      padding: 0 6px;
      border-radius: var(--radius-sm);
      background: var(--chip-bg);
      font-size: 11px;
      font-weight: 600;
      color: var(--text);
    }
    .code-head .range {
      margin-left: auto;
    }
    .code-lines {
      padding: 6px 0;
      overflow-x: auto;
      font: 12.5px/20px var(--mono);
    }
    .ln {
      display: grid;
      grid-template-columns: 48px max-content;
      white-space: pre;
      min-width: 100%;
    }
    .ln-no {
      padding-right: 12px;
      text-align: right;
      color: var(--muted);
      user-select: none;
    }
    .ln.hit {
      background: var(--hit-bg);
    }
    .ln.hit .ln-no {
      color: var(--hit);
      font-weight: 600;
    }
    .ln-src {
      padding-right: 16px;
    }
    @media (prefers-color-scheme: dark) {
      .ln-src span {
        color: var(--shiki-dark) !important;
      }
    }
  `,
})
export class CodeExcerpt {
  readonly excerpt = input.required<Excerpt>();
  readonly path = input.required<string>();
  protected readonly lang = computed(() => LANGS[this.path().split('.').pop()?.toLowerCase() ?? '']);
  private readonly tokens = signal<Token[][] | null>(null);
  protected readonly lines = computed(
    () =>
      this.tokens() ??
      this.excerpt()
        .text.split('\n')
        .map((content): Token[] => [{ content, style: null }]),
  );

  constructor() {
    effect(() => {
      const excerpt = this.excerpt();
      const lang = this.lang();
      this.tokens.set(null);
      if (!lang) return;
      void highlighter(lang).then((h) => {
        if (excerpt !== this.excerpt()) return;
        const { tokens } = h.codeToTokens(excerpt.text, { lang: lang.id, themes: { light: 'github-light', dark: 'github-dark' } });
        this.tokens.set(
          tokens.map((line) => line.map((t) => ({ content: t.content, style: t.htmlStyle ?? (t.color ? { color: t.color } : null) }))),
        );
      });
    });
  }
}

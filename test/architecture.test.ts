import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const SERVER = resolve(import.meta.dirname, '../server');

/**
 * The layers of the server, lowest first. A module imports only from its own layer or a lower one.
 * A new file has to be listed here, which makes its place a decision instead of an accident.
 */
const LAYERS: { name: string; files: string[]; isolated?: boolean }[] = [
  { name: 'model: types only, shared with the web app', files: ['model.ts'] },
  { name: 'rules: pure functions', files: ['batch.ts', 'checklist.ts'] },
  {
    name: 'infrastructure: database, settings, git, GitHub, notifications',
    files: ['config.ts', 'util.ts', 'db.ts', 'settings.ts', 'notify.ts', 'github.ts', 'git.ts', 'excerpt.ts'],
  },
  { name: 'base: what every PR has', files: ['prs.ts', 'agent-tools.ts'] },
  { name: 'roles: what differs between my own PRs and the PRs I review', files: ['roles/'] },
  // The poller wakes the runner over the event bus; neither imports the other.
  { name: 'drivers', files: ['poller.ts', 'runner.ts'], isolated: true },
  { name: 'interface', files: ['http.ts'] },
  { name: 'entry points', files: ['main.ts', 'cli.ts'] },
];

/** Layers that stay free of I/O and global state: they import nothing above themselves and no packages. */
const PURE = 2;

const files = (readdirSync(SERVER, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts')).sort();
const layerOf = (file: string) => LAYERS.findIndex((l) => l.files.some((f) => (f.endsWith('/') ? file.startsWith(f) : file === f)));
const source = (file: string) => readFileSync(join(SERVER, file), 'utf8');
const specifiers = (file: string) => [...source(file).matchAll(/^(?:import|export)\b[^;]*?\bfrom '([^']+)';/gms)].map((m) => m[1]);
const imports = (file: string) =>
  specifiers(file)
    .filter((s) => s.startsWith('.'))
    .map((s) => relative(SERVER, resolve(SERVER, dirname(file), s)));

test('every server module belongs to a layer', () => {
  assert.deepEqual(
    files.filter((f) => layerOf(f) < 0),
    [],
  );
});

test('modules import only from their own layer or a lower one', () => {
  const violations: string[] = [];
  for (const file of files) {
    const layer = layerOf(file);
    for (const target of imports(file)) {
      const to = layerOf(target);
      if (to > layer) violations.push(`${file} (${LAYERS[layer].name}) imports ${target} (${LAYERS[to].name})`);
      if (to === layer && LAYERS[layer].isolated) violations.push(`${file} imports ${target} of the same isolated layer`);
    }
  }
  assert.deepEqual(violations, []);
});

test('the model and the rules stay pure: no packages, no Node modules with side effects', () => {
  const allowed = new Set(['node:crypto']);
  const violations = files
    .filter((f) => layerOf(f) < PURE)
    .flatMap((f) =>
      specifiers(f)
        .filter((s) => !s.startsWith('.') && !allowed.has(s))
        .map((s) => `${f} imports ${s}`),
    );
  assert.deepEqual(violations, []);
  assert.deepEqual(specifiers('model.ts'), [], 'the web app compiles model.ts, so it imports nothing');
});

test('no import cycles', () => {
  const state = new Map<string, 'open' | 'done'>();
  const cycles: string[] = [];
  const visit = (file: string, path: string[]) => {
    if (state.get(file) === 'done') return;
    if (state.get(file) === 'open') return void cycles.push([...path.slice(path.indexOf(file)), file].join(' -> '));
    state.set(file, 'open');
    for (const target of imports(file)) visit(target, [...path, file]);
    state.set(file, 'done');
  };
  for (const file of files) visit(file, []);
  assert.deepEqual(cycles, []);
});

test('only roles/ decides by the role of a PR', () => {
  const comparison = /\brole\s*[!=]==?\s*'|'(?:own|review)'\s*[!=]==?/;
  const violations = files.filter((f) => !f.startsWith('roles/') && comparison.test(source(f)));
  assert.deepEqual(violations, [], 'ask roleOf(pr) instead of comparing pr.role');
});

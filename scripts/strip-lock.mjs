// Removes the SDK's bundled native Claude binaries from package-lock.json. pr-manager runs the
// claude-code binary from Nix, and fetchNpmDeps would otherwise download all eight platforms.
// Run after every `npm install`.
import { readFileSync, writeFileSync } from 'node:fs';

const file = new URL('../package-lock.json', import.meta.url);
const lock = JSON.parse(readFileSync(file, 'utf8'));
const binary = /^node_modules\/@anthropic-ai\/claude-agent-sdk-/;
let removed = 0;
for (const key of Object.keys(lock.packages)) {
  if (binary.test(key)) {
    delete lock.packages[key];
    removed++;
  }
}
const sdk = lock.packages['node_modules/@anthropic-ai/claude-agent-sdk'];
if (sdk) delete sdk.optionalDependencies;
writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`);
console.log(`removed ${removed} native binary entries`);

import { config } from './config.ts';
import { openDb } from './db.ts';
import { createHttp } from './http.ts';
import { createPoller } from './poller.ts';
import { createRunner } from './runner.ts';
import { initSettings } from './settings.ts';

const dashboardUrl = `http://127.0.0.1:${config.port}`;
const db = openDb();
initSettings(db);

// The poller and the runner need each other; the runner is created right below.
let wake = () => {};
let ownSessionIds = () => new Set<string>();
const poller = createPoller({ db, dashboardUrl, ownSessionIds: () => ownSessionIds(), wake: () => wake() });
const runner = createRunner({ db, poller, dashboardUrl });
wake = runner.wake;
ownSessionIds = runner.ownSessionIds;

runner.recover();
const server = createHttp({ db, poller, runner });
server.listen(config.port, '127.0.0.1', () => console.log(`pr-manager listening on ${dashboardUrl}`));
poller.start();
runner.start();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`${signal}: shutting down`);
    poller.stop();
    runner.stop();
    server.close();
    setTimeout(() => process.exit(0), 2_000).unref();
  });
}

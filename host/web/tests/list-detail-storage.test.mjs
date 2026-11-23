import { beforeAll, afterAll, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve, join } from 'node:path';
import { suiteBrowser } from '../../../scripts/agent-launch.mjs';
import { engineTests } from '../../../scripts/coverage.mjs';
import { serveBuildTree } from '../serve.mjs';

const root = resolve(import.meta.dir, '../../..'), engineTest = await engineTests(['chromium', 'firefox']);
let dir, server, url;
function buildFixture(dir, web = {}) {
  for (const file of ['app.contract', 'app.ts']) cpSync(join(root, 'docs/patterns/list-detail', file), join(dir, file));
  writeFileSync(join(dir, 'app.json'), JSON.stringify({ name: 'Items', app: { id: 'test.exact.list-detail', name: 'Items' }, host: { web }, deploy: {} }));
  const plan = join(dir, 'app.plan'), dist = join(dir, 'dist');
  const compile = spawnSync(join(process.env.CARGO_TARGET_DIR ?? join(root, 'target'), 'debug/contract'), ['build', join(dir, 'app.contract'), '-o', plan], { cwd: root, encoding: 'utf8' });
  expect(compile.status, compile.stderr).toBe(0);
  const build = spawnSync(process.execPath, ['host/web-js/build.mjs', 'items', '--plan', plan, '--out', dist, '--render', 'none'], { cwd: root, encoding: 'utf8', env: { ...process.env, EXACT_APP_DIR: dir } });
  expect(build.status, build.stdout + build.stderr).toBe(0);
  return dist;
}
beforeAll(async () => {
  dir = mkdtempSync(join(root, 'target/list-detail-storage-'));
  const dist = buildFixture(dir);
  server = createServer((request, response) => serveBuildTree(dist, request, response));
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  url = `http://127.0.0.1:${server.address().port}`;
}, 180_000);
afterAll(() => { server?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

const ask = (page, request) => page.evaluate(request => exact.agentSettled(request), request);
async function settle(page) {
  expect(await ask(page, { op: 'clock', settle: true })).toMatchObject({ settled: true });
}
async function visit(page, path = '/', origin = url) {
  await page.goto(`${origin}${path}?agent=1&storage=shared`);
  await page.waitForFunction(() => globalThis.exact?.agentSettled);
  await settle(page);
}
const field = (page, id) => page.locator(`[data-testid="${id}"]`);
async function add(page, title) {
  await field(page, 'add-item').click();
  await settle(page);
  await field(page, 'add-title').fill(title);
  await field(page, 'add-save').click();
  await settle(page);
}
const items = async page => (await ask(page, { op: 'state' })).resources.lib;

for (const engine of ['chromium', 'firefox']) engineTest[engine](`list-detail preserves other tabs' items and concurrent saves (${engine})`, async () => {
  const browser = await suiteBrowser(engine), context = await browser.newContext();
  try {
    const a = await context.newPage(), b = await context.newPage();
    await visit(a);
    await add(a, 'Alpha');
    await visit(b, '/item/1');
    expect((await items(b)).map(i => i.title)).toEqual(['Alpha']);
    await add(a, 'Beta');
    await field(b, 'lock-item').click();
    await settle(b);
    await visit(a);
    expect(await items(a)).toEqual([
      { id: '2', title: 'Beta', notes: '', locked: false },
      { id: '1', title: 'Alpha', notes: '', locked: true },
    ]);
    await visit(b);
    await Promise.all([add(a, 'Gamma'), add(b, 'Delta')]);
    await visit(a);
    expect((await items(a)).map(i => i.title).sort()).toEqual(['Alpha', 'Beta', 'Delta', 'Gamma']);
    await Promise.all([add(a, 'Same'), add(b, 'same')]);
    const refusals = await Promise.all([a, b].map(page => field(page, 'add-error').count()));
    expect(refusals.reduce((sum, n) => sum + n, 0)).toBe(1);
    await visit(a);
    expect((await items(a)).filter(i => i.title.toLowerCase() === 'same')).toHaveLength(1);
    await visit(a, '/item/1');
    await visit(b, '/item/2');
    await Promise.all([field(a, 'lock-item').click(), field(b, 'lock-item').click()]);
    await Promise.all([settle(a), settle(b)]);
    await visit(a);
    const changed = await items(a);
    expect(changed.find(i => i.id === '1').locked).toBe(false);
    expect(changed.find(i => i.id === '2').locked).toBe(true);
    const removed = changed.find(i => i.title === 'Gamma').id;
    await visit(a, `/item/${removed}`);
    await visit(b);
    await field(a, 'delete-item').click();
    await settle(a);
    await Promise.all([field(a, 'remove-confirm').click(), add(b, 'Epsilon')]);
    await settle(a);
    await visit(a);
    expect((await items(a)).map(i => i.title.toLowerCase()).sort()).toEqual(['alpha', 'beta', 'delta', 'epsilon', 'same']);
  } finally { await context.close(); await browser.close(); }
}, 60_000);

engineTest.chromium('a manifest selects OPFS for a SQLite path in the built app (chromium)', async () => {
  const opfsDir = mkdtempSync(join(root, 'target/list-detail-opfs-'));
  let site, browser;
  try {
    const dist = buildFixture(opfsDir, {
      sqlite: { 'app:/data/items.db': { vfs: 'opfs-sahpool', journalMode: 'wal', synchronous: 'normal' } },
    });
    site = createServer((request, response) => serveBuildTree(dist, request, response));
    await new Promise(ok => site.listen(0, '127.0.0.1', ok));
    const origin = `http://127.0.0.1:${site.address().port}`;
    browser = await suiteBrowser('chromium');
    const context = await browser.newContext();
    const first = await context.newPage();
    await visit(first, '/', origin);
    await add(first, 'In the pool');
    expect((await items(first)).map(item => item.title)).toEqual(['In the pool']);
    await first.close();

    const reopened = await context.newPage();
    await visit(reopened, '/', origin);
    expect((await items(reopened)).map(item => item.title)).toEqual(['In the pool']);
    const pools = await reopened.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle('exact-sqlite-sahpool');
      const names = [];
      for await (const name of directory.keys()) names.push(name);
      return names;
    });
    expect(pools).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
  } finally {
    try { await browser?.close(); }
    finally {
      if (site) await new Promise(ok => site.close(ok));
      rmSync(opfsDir, { recursive: true, force: true });
    }
  }
}, 180_000);

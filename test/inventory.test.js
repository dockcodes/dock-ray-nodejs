import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { collectInventory, InventoryReporter, DockRayClient } from '../src/index.js';

async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'dockray-node-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const manifest = { name: 'company/application', dependencies: { express: '^4.0.0', '@scope/core': '^1.0.0' } };
    const packages = {
        '': manifest,
        'node_modules/express': { version: '4.18.0' },
        'node_modules/other/node_modules/express': { version: '5.0.0' },
        'node_modules/@scope/core': { version: '1.2.0' },
        'node_modules/company-private': { version: '1.0.0' },
        'node_modules/dev-tool': { version: '1.0.0', dev: true },
        'node_modules/missing-native': { version: '1.0.0', optional: true },
    };
    await writeFile(join(root, 'package.json'), JSON.stringify(manifest));
    await writeFile(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }));
    for (const [path, entry] of Object.entries(packages)) {
        if (!path || path.endsWith('missing-native')) continue;
        const name = path.slice(path.lastIndexOf('node_modules/') + 13);
        await mkdir(join(root, path), { recursive: true });
        await writeFile(join(root, path, 'package.json'), JSON.stringify({ name, version: entry.version,
            description: 'private information', repository: 'https://user:secret@example.com', scripts: { install: 'DO NOT EXECUTE' } }));
    }
    return root;
}

function options(root, extra = {}) {
    return { enabled: true, token: 'project-token', privateKey: 'top-secret-key',
        environment: 'production', projectDirectory: root, stateDirectory: join(root, 'state'),
        excludePackages: ['company-*'], logger: { warn() {} }, ...extra };
}

function ok() { return new Response('{"success":true,"vulnerable":1,"next_report_in":43200}'); }

test('collector sends only installed production names/versions, scoped names and multiple versions', async (t) => {
    const root = await fixture(t);
    const payload = await collectInventory(options(root));
    assert.equal(payload.platform, 'nodejs');
    assert.equal(payload.platform_version, process.versions.node);
    assert.deepEqual(payload.components.map((item) => item.slug), ['@scope/core@1.2.0', 'express@4.18.0', 'express@5.0.0']);
    const json = JSON.stringify(payload);
    for (const forbidden of ['secret', 'private information', 'repository', 'scripts', 'DO NOT EXECUTE', 'company/application', 'dev-tool', 'missing-native']) {
        assert.equal(json.includes(forbidden), false, forbidden);
    }
    assert.equal(payload.components[0].name, '@scope/core');
    const file = join(root, 'package-lock.json');
    const lock = JSON.parse(await readFile(file));
    lock.lockfileVersion = 2;
    await writeFile(file, JSON.stringify(lock));
    assert.deepEqual((await collectInventory(options(root))).components, payload.components);
});

test('npm aliases use their real advisory name and local links never read outside the project', async (t) => {
    const root = await fixture(t);
    const file = join(root, 'package-lock.json');
    const lock = JSON.parse(await readFile(file));
    lock.packages['node_modules/alias'] = { name: 'actual-name', version: '2.0.0' };
    lock.packages['node_modules/local-package'] = { link: true, resolved: '../local-package' };
    lock.packages['../local-package'] = { version: '1.0.0' };
    await writeFile(file, JSON.stringify(lock));
    await mkdir(join(root, 'node_modules/alias'));
    await writeFile(join(root, 'node_modules/alias/package.json'), '{"name":"actual-name","version":"2.0.0"}');
    const payload = await collectInventory(options(root));
    assert.ok(payload.components.some((item) => item.slug === 'actual-name@2.0.0'));
    assert.ok(!payload.components.some((item) => item.name === 'alias' || item.name === 'local-package'));
});

test('disabled or unconfigured reporter does not send or create state', async (t) => {
    const root = await fixture(t);
    t.mock.method(globalThis, 'fetch', () => assert.fail('Unexpected request'));
    assert.equal((await new InventoryReporter(options(root, { enabled: false })).report({ force: true })).status, 'disabled');
    assert.equal((await new InventoryReporter(options(root, { privateKey: '' })).report()).status, 'not_configured');
    await assert.rejects(stat(join(root, 'state')), { code: 'ENOENT' });
});

test('transport uses HTTPS, bearer header, escaped token and refuses redirects', async (t) => {
    const root = await fixture(t);
    let calls = 0;
    t.mock.method(globalThis, 'fetch', (url, request) => {
        calls++;
        assert.equal(url, 'https://dockray.io/api/v1/project%2Ftoken/inventory');
        assert.equal(request.headers.Authorization, 'Bearer top-secret-key');
        assert.equal(request.redirect, 'error');
        assert.equal(request.method, 'POST');
        assert.equal(request.body.includes('top-secret-key'), false);
        return Promise.resolve(ok());
    });
    const reporter = new InventoryReporter(options(root, { token: 'project/token' }));
    assert.deepEqual(await reporter.report(), { status: 'sent', components: 3, vulnerable: 1 });
    assert.equal((await reporter.report()).status, 'not_due');
    assert.equal((await reporter.report({ force: true })).status, 'sent');
    assert.equal(calls, 2);
    const stateDir = join(root, 'state');
    assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
    const files = await readdir(stateDir);
    assert.equal(files.length, 1);
    assert.equal((await stat(join(stateDir, files[0]))).mode & 0o777, 0o600);
    const state = await readFile(join(stateDir, files[0]), 'utf8');
    assert.equal(state.includes('secret'), false);
    assert.equal(state.includes('express'), false);
    assert.deepEqual(Object.keys(JSON.parse(state)).sort(), ['hash', 'nextAt', 'retryAt']);
});

test('changed inventory sends on next invocation and explicit environments keep separate state', async (t) => {
    const root = await fixture(t);
    const request = t.mock.method(globalThis, 'fetch', async () => ok());
    const reporter = new InventoryReporter(options(root));
    assert.equal((await reporter.report()).status, 'sent');
    const file = join(root, 'package-lock.json');
    const lock = JSON.parse(await readFile(file));
    lock.packages['node_modules/express'].version = '4.18.1';
    await writeFile(file, JSON.stringify(lock));
    await writeFile(join(root, 'node_modules/express/package.json'), '{"name":"express","version":"4.18.1"}');
    assert.equal((await reporter.report()).status, 'sent');
    assert.equal((await new InventoryReporter(options(root, { environment: 'development' })).report()).status, 'sent');
    assert.equal((await new InventoryReporter(options(root, { environment: 'prod' })).report()).status, 'not_due');
    assert.equal((await new InventoryReporter(options(root, { environment: 'preview' })).report()).status, 'not_due');
    assert.equal(request.mock.callCount(), 3);
    assert.equal((await readdir(join(root, 'state'))).length, 2);
});

test('server rate limits cannot be bypassed by manual or changed reports', async (t) => {
    const root = await fixture(t);
    const request = t.mock.method(globalThis, 'fetch', async () => new Response('untrusted secret body', { status: 429, headers: { 'Retry-After': '7200' } }));
    const reporter = new InventoryReporter(options(root));
    assert.deepEqual(await reporter.report(), { status: 'failed', httpStatus: 429 });
    assert.equal((await reporter.report({ force: true })).status, 'backoff');
    assert.equal((await new InventoryReporter(options(root)).report({ force: true })).status, 'backoff');
    assert.equal(request.mock.callCount(), 1);
});

test('concurrent reporter instances cannot send the same snapshot in parallel', async (t) => {
    const root = await fixture(t);
    let entered, finish;
    const started = new Promise((resolve) => { entered = resolve; });
    t.mock.method(globalThis, 'fetch', () => { entered(); return new Promise((resolve) => { finish = resolve; }); });
    const reporter = new InventoryReporter(options(root));
    const sending = reporter.report();
    try {
        await started;
        assert.equal((await reporter.report({ force: true })).status, 'busy');
        assert.equal((await new InventoryReporter(options(root)).report({ force: true })).status, 'busy');
    } finally { finish(ok()); }
    assert.equal((await sending).status, 'sent');
});

test('missing, mismatched and unsupported metadata never send an empty snapshot', async (t) => {
    const root = await fixture(t);
    t.mock.method(globalThis, 'fetch', () => assert.fail('Unexpected request'));
    const file = join(root, 'package-lock.json');
    const original = await readFile(file);
    for (const version of [1, 9]) {
        const lock = JSON.parse(original);
        lock.lockfileVersion = version;
        await writeFile(file, JSON.stringify(lock));
        assert.equal((await new InventoryReporter(options(root)).report()).status, 'failed');
    }
    await writeFile(file, original);
    await writeFile(join(root, 'node_modules/express/package.json'), '{"name":"express","version":"4.17.0"}');
    assert.equal((await new InventoryReporter(options(root)).report()).status, 'failed');
    await rm(file);
    assert.equal((await new InventoryReporter(options(root)).report()).status, 'failed');
});

test('insecure endpoints, unknown environments and public state directories are rejected', async (t) => {
    const root = await fixture(t);
    t.mock.method(globalThis, 'fetch', () => assert.fail('Unexpected request'));
    for (const url of ['http://dockray.io', 'https://user:password@dockray.io', 'https://dockray.io/?secret=value']) {
        assert.equal((await new InventoryReporter(options(root, { url })).report()).status, 'invalid_configuration');
    }
    for (const environment of ['unknown', '', null, 'production\n']) {
        assert.equal((await new InventoryReporter(options(root, { environment })).report()).status, 'failed');
    }
    await mkdir(join(root, 'public-state'), { mode: 0o755 });
    assert.equal((await new InventoryReporter(options(root, { stateDirectory: join(root, 'public-state') })).report()).status, 'failed');
    await symlink(join(root, 'public-state'), join(root, 'linked-state'));
    assert.equal((await new InventoryReporter(options(root, { stateDirectory: join(root, 'linked-state') })).report()).status, 'failed');
});

test('oversized or malformed replies back off without logging their content', async (t) => {
    const root = await fixture(t);
    let logged = '';
    t.mock.method(globalThis, 'fetch', async () => new Response('SECRET'.repeat(12000)));
    const reporter = new InventoryReporter(options(root, { logger: { warn(message) { logged += message; } } }));
    assert.equal((await reporter.report()).status, 'failed');
    assert.equal((await reporter.report({ force: true })).status, 'backoff');
    assert.equal(logged.includes('SECRET'), false);
});

test('client starts the opt-in schedule, exposes manual reporting and stops it on close', async (t) => {
    const root = await fixture(t);
    const request = t.mock.method(globalThis, 'fetch', async () => ok());
    const disabled = new DockRayClient();
    assert.equal(disabled.inventory.timer, undefined);
    assert.equal((await disabled.reportInventory()).status, 'disabled');
    await disabled.close();
    const client = new DockRayClient({ token: 'project-token', privateKey: 'top-secret-key', inventoryEnabled: true,
        environment: 'production', inventoryProjectDirectory: root,
        inventoryStateDirectory: join(root, 'state'), inventoryExcludePackages: ['company-*'] });
    try {
        assert.equal(client.inventory.timer.hasRef(), false);
        assert.equal(client.inventory.timer._idleTimeout, 3600000);
        assert.equal((await client.reportInventory({ force: true })).status, 'sent');
    } finally { await client.close(); }
    assert.equal(client.inventory.timer, null);
    assert.equal(client.inventory.initial, null);
    assert.equal(request.mock.callCount(), 1);
});

test('CLI is opt-in, accepts only documented flags and never logs credentials', async (t) => {
    const root = await fixture(t);
    const cli = new URL('../bin/dockray-inventory.js', import.meta.url);
    const disabled = spawnSync(process.execPath, [cli.pathname], { cwd: root, encoding: 'utf8',
        env: { ...process.env, RAY_INVENTORY: 'false', RAY_PRIVATE_KEY: 'TOP_SECRET' } });
    assert.equal(disabled.status, 0);
    assert.match(disabled.stdout, /disabled/);
    assert.equal(disabled.stdout.includes('TOP_SECRET'), false);
    const bad = spawnSync(process.execPath, [cli.pathname, '--unknown'], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    const unknownEnvironment = spawnSync(process.execPath, [cli.pathname], { cwd: root, encoding: 'utf8',
        env: { ...process.env, RAY_INVENTORY: 'true', RAY_TOKEN: 'test-project', RAY_PRIVATE_KEY: 'TOP_SECRET',
            RAY_ENVIRONMENT: 'unknown', RAY_INVENTORY_SITE_URL: '', RAY_INVENTORY_STATE_DIR: join(root, 'cli-state') } });
    assert.equal(unknownEnvironment.status, 1);
    assert.match(unknownEnvironment.stdout, /failed/);
    assert.equal(unknownEnvironment.stdout.includes('not_configured'), false);
    assert.equal(unknownEnvironment.stdout.includes('TOP_SECRET'), false);
});

 test('inventory normalizes environments without a site URL and ignores obsolete URL options', async t => {
    const root = await fixture(t);
    for (const [environment, expected] of [['production', 'prod'], ['prod', 'prod'], ['dev', 'dev'],
        ['development', 'dev'], ['preview', 'dev'], ['staging', 'dev'], ['test', 'dev'], ['local', 'dev']]) {
        const payload = await collectInventory(options(root, { environment, siteUrl: 'https://secret:secret@obsolete.example' }));
        assert.equal(payload.environment, expected);
        assert.equal(Object.hasOwn(payload, 'site_url'), false);
        assert.equal(JSON.stringify(payload).includes('obsolete.example'), false);
    }
    const previous = process.env.RAY_ENVIRONMENT;
    process.env.RAY_ENVIRONMENT = 'development';
    try {
        const client = new DockRayClient({ inventoryEnabled: false });
        assert.equal(client.environment, 'development');
        assert.equal(client.inventory.options.environment, 'development');
        await client.close();
    } finally {
        if (previous === undefined) delete process.env.RAY_ENVIRONMENT; else process.env.RAY_ENVIRONMENT = previous;
    }
});

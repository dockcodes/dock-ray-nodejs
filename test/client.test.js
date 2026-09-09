import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';

import { AuthData, DockRayClient } from '../src/index.js';
import { rayRequestHandler } from '../src/express.js';

function collector() {
    const received = [];
    const server = createServer((req, res) => {
        const chunks = [];

        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            let body = Buffer.concat(chunks);

            if (req.headers['content-encoding'] === 'gzip') {
                body = gunzipSync(body);
            }

            received.push({
                path: req.url,
                auth: req.headers.authorization,
                encoding: req.headers['content-encoding'] ?? 'none',
                payload: JSON.parse(body.toString('utf8')),
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        });
    });

    return { server, received };
}

async function withCollector(run) {
    const { server, received } = collector();

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    const url = `http://127.0.0.1:${server.address().port}`;

    try {
        await run(url, received);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

test('builds the ingest URLs the panel routes on', () => {
    const auth = new AuthData('tok', 'key');

    assert.equal(auth.projectUrl, 'https://dockray.io/api/v1/tok/project');
    assert.equal(auth.transactionUrl, 'https://dockray.io/api/v1/tok/transaction');
    assert.equal(new AuthData('t', 'k', 'http://localhost:8080/ray').projectUrl,
        'http://localhost:8080/ray/api/v1/t/project');
});

test('a client without credentials sends nothing and never throws', async () => {
    const client = new DockRayClient();

    assert.equal(client.enabled, false);
    assert.equal(await client.captureException(new Error('x')), false);
    assert.equal(await client.captureMessage('x'), false);
});

test('an exception carries the fields the ingest requires', async () => {
    await withCollector(async (url, received) => {
        const client = new DockRayClient({ token: 'tok', privateKey: 'key', url, environment: 'testing' });

        assert.equal(await client.captureException(new TypeError('boom')), true);
        assert.equal(received.length, 1);

        const { payload, auth, path } = received[0];

        assert.equal(path, '/api/v1/tok/project');
        assert.equal(auth, 'Bearer key');
        assert.equal(payload.exception.values[0].type, 'TypeError');
        assert.equal(payload.exception.values[0].value, 'boom');
        assert.ok(payload.exception.values[0].stacktrace.frames.length > 0);
        assert.equal(payload.environment, 'testing');
        assert.equal(payload.sdk.name, 'ray.javascript.node');
        assert.equal(payload.event_id.length, 32);
    });
});

test('the innermost frame is last and carries source context', async () => {
    await withCollector(async (url, received) => {
        const client = new DockRayClient({ token: 'tok', privateKey: 'key', url, appRoot: process.cwd() });

        await client.captureException(new Error('trace me'));

        const frames = received[0].payload.exception.values[0].stacktrace.frames;
        const innermost = frames[frames.length - 1];

        assert.ok(innermost.filename.endsWith('client.test.js'));
        assert.ok(innermost.in_app);
        assert.ok(typeof innermost.context_line === 'string');
        assert.ok(innermost.context_line.includes('trace me'));
    });
});

test('a transaction carries trace data and the status tag', async () => {
    await withCollector(async (url, received) => {
        const client = new DockRayClient({
            token: 'tok', privateKey: 'key', url, tracesSampleRate: 1,
        });

        await client.captureTransaction({
            name: 'GET /orders/:id',
            url: 'https://shop.test/orders/8123',
            method: 'get',
            statusCode: 201,
            startTimestamp: 1,
            endTimestamp: 2,
        });

        const { payload, path } = received[0];

        assert.equal(path, '/api/v1/tok/transaction');
        assert.equal(payload.transaction, 'GET /orders/:id');
        assert.deepEqual(payload.contexts.trace.data, {
            url: 'https://shop.test/orders/8123',
            method: 'GET',
        });
        assert.equal(payload.tags['http.status_code'], '201');
        assert.ok(payload.sent_at);
    });
});

test('tracing stays off until traces_sample_rate is raised', async () => {
    await withCollector(async (url, received) => {
        const client = new DockRayClient({ token: 'tok', privateKey: 'key', url });

        assert.equal(await client.captureTransaction({
            name: 'GET /', url: 'https://x.test/', method: 'GET', statusCode: 200,
            startTimestamp: 1, endTimestamp: 2,
        }), false);
        assert.equal(received.length, 0);
    });
});

test('personal data stays out unless sendDefaultPii is on', async () => {
    await withCollector(async (url, received) => {
        const guarded = new DockRayClient({ token: 'tok', privateKey: 'key', url });
        const permissive = new DockRayClient({ token: 'tok', privateKey: 'key', url, sendDefaultPii: true });
        const user = { id: 7, ip_address: '1.2.3.4', agent: 'Firefox' };

        await guarded.captureException(new Error('a'), { user });
        await permissive.captureException(new Error('b'), { user });

        assert.deepEqual(received[0].payload.user, { id: 7 });
        assert.deepEqual(received[1].payload.user, user);
    });
});

test('a large payload is gzipped', async () => {
    await withCollector(async (url, received) => {
        const client = new DockRayClient({ token: 'tok', privateKey: 'key', url });

        await client.captureMessage('x'.repeat(4000));

        assert.equal(received[0].encoding, 'gzip');
        assert.equal(received[0].payload.message.length, 4000);
    });
});

test('an unreachable panel is reported as failure, not thrown', async () => {
    const client = new DockRayClient({
        token: 'tok', privateKey: 'key', url: 'http://127.0.0.1:1',
        logger: { warn() {} },
    });

    assert.equal(await client.captureException(new Error('x')), false);
});

test('a quota rejection is a failed send, not an error', async () => {
    const server = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false }));
        });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    const client = new DockRayClient({
        token: 'tok', privateKey: 'key', url: `http://127.0.0.1:${server.address().port}`,
    });

    assert.equal(await client.captureException(new Error('x')), false);

    await new Promise((resolve) => server.close(resolve));
});

test('the express middleware reports only after the response finished', async () => {
    await withCollector(async (url, received) => {
        const client = new DockRayClient({ token: 'tok', privateKey: 'key', url, tracesSampleRate: 1 });
        const middleware = rayRequestHandler(client);

        const listeners = [];
        const req = { method: 'GET', url: '/orders/8123', headers: { host: 'shop.test' }, socket: {},
            route: { path: '/orders/:id' } };
        const res = { statusCode: 200, on: (event, fn) => listeners.push([event, fn]) };

        await new Promise((resolve) => middleware(req, res, resolve));

        assert.equal(received.length, 0, 'nothing is sent while the request is being handled');

        listeners.filter(([event]) => event === 'finish').forEach(([, fn]) => fn());
        await client.flush();

        assert.equal(received.length, 1);
        assert.equal(received[0].payload.transaction, 'GET /orders/:id');
    });
});

test('beforeSend can drop an event', async () => {
    await withCollector(async (url, received) => {
        const client = new DockRayClient({
            token: 'tok', privateKey: 'key', url,
            beforeSend: (event) => (event.message === 'secret' ? null : event),
        });

        assert.equal(await client.captureMessage('secret'), false);
        assert.equal(await client.captureMessage('fine'), true);
        assert.equal(received.length, 1);
    });
});

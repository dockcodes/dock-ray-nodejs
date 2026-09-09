import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';

import { DockRayClient } from '../src/index.js';
import { DockRayClient as EdgeClient } from '../src/edge.js';
import { browserEvent } from '../src/browser.js';

async function withCollector(run) {
    const received = [];
    const server = createServer((req, res) => {
        const chunks = [];

        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const encoding = req.headers['content-encoding'] ?? 'none';
            const raw = Buffer.concat(chunks);

            received.push({
                encoding,
                payload: JSON.parse((encoding === 'gzip' ? gunzipSync(raw) : raw).toString('utf8')),
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
        await run(`http://127.0.0.1:${server.address().port}`, received);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

test('the edge entry point pulls in no node built-ins', () => {
    const reachable = ['src/edge.js', 'src/client.js', 'src/auth.js', 'src/event.js',
        'src/transport.js', 'src/http.js', 'src/browser.js', 'src/random.js',
        'src/stacktrace.js', 'src/runtime/edge.js'];

    for (const file of reachable) {
        const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
        const imports = [...source.matchAll(/^import .*from '(node:[^']+)'/gm)];

        assert.deepEqual(imports, [], `${file} imports a node built-in`);
    }
});

test('the edge client reports without a filesystem or zlib', async () => {
    await withCollector(async (url, received) => {
        const client = new EdgeClient({ token: 'tok', privateKey: 'key', url });

        assert.equal(await client.captureMessage('x'.repeat(4000)), true);
        assert.equal(received[0].encoding, 'none', 'edge has no zlib, so no gzip');
        assert.equal(received[0].payload.contexts.runtime[0], 'edge');
        assert.equal(received[0].payload.message.length, 4000);
    });
});

test('the node client still names the machine and compresses', async () => {
    await withCollector(async (url, received) => {
        const client = new DockRayClient({ token: 'tok', privateKey: 'key', url });

        await client.captureMessage('y'.repeat(4000));

        assert.equal(received[0].encoding, 'gzip');
        assert.ok(received[0].payload.server_name);
        assert.equal(received[0].payload.contexts.runtime[0], 'node');
    });
});

test('a browser report becomes an event with a server-side envelope', async () => {
    await withCollector(async (url, received) => {
        const client = new DockRayClient({
            token: 'tok', privateKey: 'key', url, environment: 'production', release: '2.0.0',
        });

        const sent = await client.captureBrowserReport({
            type: 'TypeError',
            message: 'null is not an object',
            stack: [
                { function: 'onClick', filename: 'https://shop.test/_next/static/app.js', lineno: 12 },
                { function: 'boot', filename: 'https://shop.test/_next/static/app.js', lineno: 4 },
            ],
            url: 'https://shop.test/cart',
            handler: 'onerror',
            environment: 'HACKED',
        }, { userAgent: 'Firefox/130' });

        assert.equal(sent, true);

        const { payload } = received[0];

        assert.equal(payload.platform, 'javascript');
        assert.equal(payload.exception.values[0].type, 'TypeError');
        assert.equal(payload.request.url, 'https://shop.test/cart');
        assert.equal(payload.tags.source, 'browser');
        assert.equal(payload.tags.handler, 'onerror');
        assert.equal(payload.event_id.length, 32);
        assert.equal(payload.environment, 'production', 'the browser cannot pick its own environment');
        assert.equal(payload.release, '2.0.0');
        assert.equal(payload.exception.values[0].stacktrace.frames.at(-1).lineno, 12,
            'innermost frame goes last');
    });
});

test('an unusable browser report is refused, not half-reported', () => {
    assert.equal(browserEvent(null), null);
    assert.equal(browserEvent({}), null);
    assert.equal(browserEvent({ message: '   ' }), null);
    assert.equal(browserEvent({ message: 'x', stack: 'not-an-array' }).exception.values[0].stacktrace.frames.length, 0);
});

test('browser strings are capped and unknown fields dropped', () => {
    const event = browserEvent({
        message: 'm'.repeat(5000),
        type: 't'.repeat(5000),
        evil: 'should not survive',
        level: 'not-a-level',
        stack: Array.from({ length: 200 }, (unused, i) => ({ filename: 'a.js', lineno: i })),
    });

    assert.equal(event.message.length, 1024);
    assert.equal(event.exception.values[0].type.length, 1024);
    assert.equal(event.level, 'error');
    assert.equal(event.exception.values[0].stacktrace.frames.length, 50);
    assert.equal(Object.hasOwn(event, 'evil'), false);
});

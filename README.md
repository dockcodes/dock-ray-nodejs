# @dockcodes/dock-ray

Node.js client for [DockRay](https://dockray.io). Reports exceptions,
messages and HTTP transactions from server-side Node applications.

**This is a server package.** There is no browser build, and there will not be
one: authenticating from a browser means shipping the project private key in
page source, where anyone can read it and report into your project. Browser
errors travel through your own server instead — the page reports to a route in
your app, and the app forwards with its key. `captureBrowserReport()` is the
server half of that; the CMS plugins, the Next.js package and the Nuxt module
each ship the route and the collector.

Framework integrations built on this package:

| Package | For |
|---|---|
| `@dockcodes/dock-ray-next` | Next.js, App and Pages Router |
| `@dockcodes/dock-ray-nuxt` | Nuxt 3 and 4 |

## Installation

```bash
npm install @dockcodes/dock-ray
```

Requires Node 18 or newer (it uses the built-in `fetch`). No dependencies.

### Edge runtimes

`@dockcodes/dock-ray` imports `node:fs`, `node:os` and `node:zlib`, which an
edge bundle cannot resolve. Import the edge entry point there instead:

```js
import { DockRayClient } from '@dockcodes/dock-ray/edge';
```

Same API. Events lose stack source context and gzip, because the runtime has no
filesystem and no zlib; nothing else changes.

## Usage

```js
import { DockRayClient } from '@dockcodes/dock-ray';

const ray = new DockRayClient({
    token: process.env.RAY_TOKEN,
    privateKey: process.env.RAY_PRIVATE_KEY,
    environment: process.env.NODE_ENV,
    release: process.env.APP_VERSION,
});

try {
    await settle(order);
} catch (error) {
    await ray.captureException(error);
}
```

Constructed without credentials the client is inert: `ray.enabled` is `false`
and every call resolves to `false` without touching the network. Wire it up
unconditionally and leave the credentials out of development.

### Options

| Option | Default | Meaning |
|---|---|---|
| `token`, `privateKey` | — | project credentials; both required to send anything |
| `environment` | `NODE_ENV` or `production` | environment column in the panel |
| `release` | — | deployed version |
| `sampleRate` | `1` | share of error events sent |
| `tracesSampleRate` | `0` | share of transactions sent; `0` disables tracing |
| `sendDefaultPii` | `false` | keep IP address and user agent on events |
| `appRoot` | `process.cwd()` | frames below it are marked as application code |
| `contextLines` | `3` | source lines around each application frame |
| `timeout` | `5000` | milliseconds before a send is abandoned |
| `beforeSend` | — | receives the event, returns it, a changed copy, or `null` to drop |

## Reporting after the response

Never make a visitor wait for the monitoring service. `report()` queues a send
without awaiting it, keeping a reference so the process cannot exit mid-flight:

```js
ray.report(ray.captureException(error));
```

The framework adapters do this on the hook that fires after the response has
been flushed, so the request to the panel starts once the client already has
its bytes.

### Express

```js
import express from 'express';
import { rayRequestHandler, rayErrorHandler } from '@dockcodes/dock-ray/express';

const app = express();

app.use(rayRequestHandler(ray));      // before the routes
// ... routes ...
app.use(rayErrorHandler(ray));        // after the routes
```

`rayRequestHandler` opens a transaction and reports it on the response's
`finish` event. `rayErrorHandler` reports the error and passes it on — it
never swallows one, so your own error page still renders.

### Fastify

```js
import { rayPlugin } from '@dockcodes/dock-ray/fastify';

await fastify.register(rayPlugin, { client: ray });
```

Transactions are reported from `onResponse`, errors from `onError`.

Both adapters name transactions after the route pattern (`GET /orders/:id`),
so one route stays one row in the panel no matter how many identifiers pass
through it, skip `/health` and `/metrics` by default (`ignorePaths`), report
only `5xx` errors (`shouldReport`), and strip `Authorization`, `Cookie` and
`X-Api-Key` from the reported headers. The client IP is read from
`X-Forwarded-For` or `X-Real-IP` before the socket address.

## Browser errors

Reports that reached one of your routes from a visitor's browser:

```js
app.post('/api/ray/browser', async (req, res) => {
    ray.report(ray.captureBrowserReport(req.body, {
        pageUrl: req.headers.referer,
        userAgent: req.headers['user-agent'],
    }));

    res.status(202).json({ success: true });
});
```

The payload is untrusted: fields it does not recognise are dropped, every
string is capped at 1 KB, the stack is capped at 50 frames, and anything it
cannot make an event of returns `false` rather than a half-filled report. The
envelope — id, timestamp, environment, release — is filled in here, on the
server, so a browser cannot choose which environment its errors land in.

The page-side collector is `@dockcodes/dock-ray/browser`:

```js
import { startCollector } from '@dockcodes/dock-ray/browser';

const stop = startCollector({ endpoint: '/api/ray/browser', token: csrfToken });
```

Guard your route yourself — a CSRF token, a body size limit and a per-address
rate limit are what the shipped integrations use.

## Crashes nobody caught

Off by default, because taking these over changes how the process behaves on a
fatal error:

```js
ray.installGlobalHandlers();
```

`uncaughtException` is reported and then the process exits — a process that
survives an uncaught exception is in an unknown state. Pass
`{ exitOnUncaught: false }` if something else already handles that.

## Shutdown

```js
process.on('SIGTERM', async () => {
    await ray.close();
    server.close();
});
```

`close()` waits for queued reports so a rolling deploy does not drop the errors
that caused it.

## Failure behaviour

Nothing here throws into the application. Network errors, rejected events and
malformed responses are logged through the configured `logger` and reported as
`false`. A `200` carrying `{"success": false}` means the account reached its
monthly error quota.

## Tests

```bash
npm test
```

## License

MIT.

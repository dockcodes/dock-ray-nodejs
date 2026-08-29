import { ThorClient } from './client.js';
import { edgeRuntime } from './runtime/edge.js';

export { ThorClient };
export { AuthData, DEFAULT_URL } from './auth.js';
export { SDK_NAME, SDK_VERSION, exceptionEvent, messageEvent, transactionEvent } from './event.js';
export { describeRequest, routeName } from './http.js';
export { browserEvent, collectorConfig, defaultIgnoreList, startCollector } from './browser.js';
export { edgeRuntime } from './runtime/edge.js';

/**
 * The client for runtimes without a filesystem, a hostname or zlib — Vercel
 * Edge, Cloudflare Workers, Next.js middleware. Reporting works the same;
 * events simply carry no source context and travel uncompressed.
 *
 * Importing this entry point keeps `node:` built-ins out of the bundle, which
 * an edge build refuses to resolve.
 */
export class DockThorClient extends ThorClient {
    constructor(options = {}) {
        super({ runtime: edgeRuntime, ...options });
    }
}

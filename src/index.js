import { ThorClient } from './client.js';
import { nodeRuntime } from './runtime/node.js';

export { ThorClient };
export { AuthData, DEFAULT_URL } from './auth.js';
export { SDK_NAME, SDK_VERSION, exceptionEvent, messageEvent, transactionEvent } from './event.js';
export { describeRequest, routeName } from './http.js';
export { browserEvent, collectorConfig, defaultIgnoreList, startCollector } from './browser.js';
export { thorErrorHandler, thorRequestHandler } from './express.js';
export { thorPlugin } from './fastify.js';
export { nodeRuntime } from './runtime/node.js';

/**
 * The client for a full Node process: stack frames carry source context, the
 * event names the machine and large bodies are gzipped.
 */
export class DockThorClient extends ThorClient {
    constructor(options = {}) {
        super({ runtime: nodeRuntime, ...options });
    }
}

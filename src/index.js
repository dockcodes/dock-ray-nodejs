import { RayClient } from './client.js';
import { nodeRuntime } from './runtime/node.js';
import { InventoryReporter } from './inventory.js';

export { InventoryReporter, collectInventory } from './inventory.js';

export { RayClient };
export { AuthData, DEFAULT_URL } from './auth.js';
export { SDK_NAME, SDK_VERSION, exceptionEvent, messageEvent, transactionEvent } from './event.js';
export { describeRequest, routeName } from './http.js';
export { browserEvent, collectorConfig, defaultIgnoreList, startCollector } from './browser.js';
export { rayErrorHandler, rayRequestHandler } from './express.js';
export { rayPlugin } from './fastify.js';
export { nodeRuntime } from './runtime/node.js';

/**
 * The client for a full Node process: stack frames carry source context, the
 * event names the machine and large bodies are gzipped.
 */
export class DockRayClient extends RayClient {
    constructor(options = {}) {
        super({ runtime: nodeRuntime, ...options,
            environment: options.environment ?? process.env.RAY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'production' });
        this.inventory = new InventoryReporter({
            enabled: options.inventoryEnabled ?? false,
            environment: this.environment,
            excludePackages: options.inventoryExcludePackages ?? [],
            projectDirectory: options.inventoryProjectDirectory ?? this.appRoot,
            stateDirectory: options.inventoryStateDirectory,
            token: options.token, privateKey: options.privateKey, url: options.url,
            logger: options.logger,
        });
        this.inventory.start();
    }

    reportInventory(options = {}) {
        return this.inventory.report(options);
    }

    async close() {
        await this.inventory.stop();
        await super.close();
    }
}

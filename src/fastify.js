import { describeRequest, routeName } from './http.js';

/**
 * Fastify plugin: one transaction per request plus unhandled errors.
 *
 * `onResponse` fires after the reply has been flushed to the client, so the
 * request to the panel never delays the response.
 */
export function rayPlugin(fastify, options, done) {
    const { client, ignorePaths = ['/health', '/metrics'], shouldReport = defaultShouldReport } = options;

    if (!client?.enabled) {
        done();

        return;
    }

    fastify.decorateRequest('ray', null);

    fastify.addHook('onRequest', (request, reply, next) => {
        request.ray = { startTimestamp: Date.now() / 1000, request: describeRequest(request) };
        next();
    });

    fastify.addHook('onError', (request, reply, error, next) => {
        if (shouldReport(error)) {
            client.report(client.captureException(error, {
                user: request.ray?.request?.user,
                request: request.ray?.request?.http,
            }));
        }

        next();
    });

    fastify.addHook('onResponse', (request, reply, next) => {
        const context = request.ray;
        const path = request.url ?? '/';

        if (context && !ignorePaths.some((ignored) => path.startsWith(ignored))) {
            client.report(client.captureTransaction({
                name: routeName(request),
                url: context.request.http.url,
                method: context.request.http.method,
                statusCode: reply.statusCode,
                startTimestamp: context.startTimestamp,
                endTimestamp: Date.now() / 1000,
                user: context.request.user,
                request: context.request.http,
            }));
        }

        next();
    });

    done();
}

rayPlugin[Symbol.for('skip-override')] = true;

function defaultShouldReport(error) {
    const status = error?.status ?? error?.statusCode ?? 500;

    return status >= 500;
}

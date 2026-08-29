import { describeRequest, routeName } from './http.js';

/**
 * Fastify plugin: one transaction per request plus unhandled errors.
 *
 * `onResponse` fires after the reply has been flushed to the client, so the
 * request to the panel never delays the response.
 */
export function thorPlugin(fastify, options, done) {
    const { client, ignorePaths = ['/health', '/metrics'], shouldReport = defaultShouldReport } = options;

    if (!client?.enabled) {
        done();

        return;
    }

    fastify.decorateRequest('thor', null);

    fastify.addHook('onRequest', (request, reply, next) => {
        request.thor = { startTimestamp: Date.now() / 1000, request: describeRequest(request) };
        next();
    });

    fastify.addHook('onError', (request, reply, error, next) => {
        if (shouldReport(error)) {
            client.report(client.captureException(error, {
                user: request.thor?.request?.user,
                request: request.thor?.request?.http,
            }));
        }

        next();
    });

    fastify.addHook('onResponse', (request, reply, next) => {
        const context = request.thor;
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

thorPlugin[Symbol.for('skip-override')] = true;

function defaultShouldReport(error) {
    const status = error?.status ?? error?.statusCode ?? 500;

    return status >= 500;
}

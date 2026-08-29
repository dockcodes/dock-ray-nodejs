import { describeRequest, routeName } from './http.js';

/**
 * Express middleware: one transaction per request.
 *
 * The report is queued on the response's `finish` event, so the request to the
 * panel starts only after the last byte has gone to the client. A slow panel
 * costs the visitor nothing.
 */
export function thorRequestHandler(client, { ignorePaths = ['/health', '/metrics'] } = {}) {
    return function dockThorRequestHandler(req, res, next) {
        if (!client.enabled) {
            next();

            return;
        }

        const startTimestamp = Date.now() / 1000;
        const described = describeRequest(req);

        req.thor = { client, request: described };

        if (ignorePaths.some((path) => (req.path ?? req.url ?? '').startsWith(path))) {
            next();

            return;
        }

        res.on('finish', () => {
            client.report(client.captureTransaction({
                name: routeName(req),
                url: described.http.url,
                method: described.http.method,
                statusCode: res.statusCode,
                startTimestamp,
                endTimestamp: Date.now() / 1000,
                user: described.user,
                request: described.http,
            }));
        });

        next();
    };
}

/**
 * Express error handler. Register it after the routes and before any handler
 * that renders the error page; it reports and passes the error along.
 */
export function thorErrorHandler(client, { shouldReport = defaultShouldReport } = {}) {
    return function dockThorErrorHandler(error, req, res, next) {
        if (client.enabled && shouldReport(error)) {
            const described = req.thor?.request ?? {};

            res.on('finish', () => {
                client.report(client.captureException(error, {
                    user: described.user,
                    request: described.http,
                }));
            });
        }

        next(error);
    };
}

function defaultShouldReport(error) {
    const status = error?.status ?? error?.statusCode ?? 500;

    // 4xx is the client getting it wrong; the panel is for our own faults.
    return status >= 500;
}

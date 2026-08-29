const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key']);

/**
 * Splits an incoming request into what the panel stores as `request` and as
 * `user`.
 *
 * The client address comes from the proxy headers first: behind nginx or a
 * load balancer the socket address is the proxy, not the visitor.
 */
export function describeRequest(req, { trustProxy = true } = {}) {
    const headers = req.headers ?? {};
    const host = headers.host ?? 'localhost';
    const protocol = req.protocol ?? (req.socket?.encrypted ? 'https' : 'http');
    const url = req.originalUrl ?? req.url ?? '/';

    return {
        http: {
            url: `${protocol}://${host}${url}`,
            method: (req.method ?? 'GET').toUpperCase(),
            headers: safeHeaders(headers),
        },
        user: {
            ip_address: clientAddress(req, headers, trustProxy),
            agent: headers['user-agent'],
        },
    };
}

/**
 * The route pattern, not the concrete path: `/orders/:id` keeps one route as
 * one row in the panel instead of one row per order.
 */
export function routeName(req) {
    const pattern = req.route?.path ?? req.routeOptions?.url ?? req.routerPath;
    const path = pattern ?? new URL(req.originalUrl ?? req.url ?? '/', 'http://localhost').pathname;

    return `${(req.method ?? 'GET').toUpperCase()} ${path}`;
}

function clientAddress(req, headers, trustProxy) {
    if (trustProxy) {
        const forwarded = headers['x-forwarded-for'];

        if (typeof forwarded === 'string' && forwarded.length > 0) {
            return forwarded.split(',')[0].trim();
        }

        if (typeof headers['x-real-ip'] === 'string') {
            return headers['x-real-ip'].trim();
        }
    }

    return req.ip ?? req.socket?.remoteAddress;
}

function safeHeaders(headers) {
    const result = {};

    for (const [name, value] of Object.entries(headers)) {
        if (!SENSITIVE_HEADERS.has(name.toLowerCase())) {
            result[name] = value;
        }
    }

    return result;
}

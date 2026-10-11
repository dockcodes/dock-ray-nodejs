import { randomHex } from './random.js';
import { framesFromError } from './stacktrace.js';

export const SDK_NAME = 'ray.javascript.node';

export const SDK_VERSION = '1.1.0';

export function eventId(runtime) {
    return runtime?.randomHex ? runtime.randomHex(16) : randomHex(16);
}

function contexts(runtime) {
    const process = globalThis.process;

    return {
        os: {
            name: process?.platform ?? runtime.name,
            version: process?.version ?? '',
            build: '',
            kernel_version: '',
        },
        runtime: [runtime.name, process?.versions?.node ?? ''],
    };
}

export function baseEvent({ level, message, environment, release, user, request, tags, extra, runtime }) {
    const host = runtime.hostname();

    const event = {
        event_id: eventId(runtime),
        timestamp: new Date().toISOString(),
        platform: 'node',
        level,
        message,
        environment,
        sdk: { name: SDK_NAME, version: SDK_VERSION },
        contexts: contexts(runtime),
        tags: { ...tags },
        extra: { ...extra },
    };

    if (host) {
        event.server_name = host;
    }

    if (release) {
        event.release = release;
    }

    if (user && Object.keys(user).length > 0) {
        event.user = user;
    }

    if (request) {
        event.request = request;
    }

    return event;
}

export function exceptionEvent(error, options = {}) {
    const event = baseEvent({ level: 'error', message: String(error?.message ?? error), ...options });

    event.exception = {
        values: [
            {
                type: error?.name ?? 'Error',
                value: String(error?.message ?? error),
                stacktrace: { frames: framesFromError(error, { ...options, readSource: options.runtime?.readSource }) },
            },
        ],
    };

    return event;
}

export function messageEvent(message, options = {}) {
    return baseEvent({ level: 'info', message, ...options });
}

/**
 * The panel indexes a transaction by `contexts.trace.data.url`,
 * `contexts.trace.data.method` and `tags["http.status_code"]`. An event
 * missing any of the three is discarded on ingest, so they are filled here
 * rather than left to each framework adapter.
 */
export function transactionEvent({ name, url, method, statusCode, startTimestamp, endTimestamp, spans = [], ...options }) {
    const event = baseEvent({ level: 'info', message: `Transaction: ${name}`, ...options });

    event.transaction = name;
    event.sent_at = new Date().toISOString();
    event.start_timestamp = startTimestamp;
    event.timestamp = endTimestamp;
    event.tags['http.status_code'] = String(statusCode);
    event.contexts.trace = {
        trace_id: eventId(options.runtime),
        span_id: options.runtime?.randomHex ? options.runtime.randomHex(8) : randomHex(8),
        op: 'http.server',
        data: { url, method: method.toUpperCase() },
    };
    event.spans = spans;

    return event;
}

/**
 * Browser errors, both ends of the trip.
 *
 * A browser cannot authenticate against the panel - the project private key
 * would have to be readable in page source. So the page reports to the
 * application, and the application forwards with its own key:
 *
 *     browser  ->  your server route  ->  DockRay
 *     (no key)                        (project key)
 *
 * `startCollector()` runs in the page; `browserEvent()` runs on the server and
 * treats everything it receives as untrusted.
 */

const MAX_STRING = 1024;

const MAX_FRAMES = 50;

export function defaultIgnoreList() {
    return [
        'ResizeObserver loop',
        'Script error.',
        'Non-Error promise rejection captured',
    ];
}

export function collectorConfig({
    endpoint,
    token = null,
    release = null,
    sampleRate = 1,
    maxEvents = 10,
    ignore = defaultIgnoreList(),
} = {}) {
    return {
        endpoint,
        token,
        release,
        sampleRate: Math.min(1, Math.max(0, sampleRate)),
        maxEvents: Math.max(1, maxEvents),
        ignore,
    };
}

/**
 * Installs the page-side listeners. Returns a function that removes them,
 * which client-side navigation needs so a single-page app does not stack a new
 * pair of listeners on every route change.
 */
export function startCollector(config) {
    if (typeof window === 'undefined' || !config?.endpoint) {
        return () => {};
    }

    const settings = collectorConfig(config);
    const seen = new Set();
    let sent = 0;

    function report(type, message, error, handler) {
        const text = String(message ?? '');

        if (sent >= settings.maxEvents || text === '') {
            return;
        }

        if (settings.ignore.some((needle) => text.includes(needle))) {
            return;
        }

        if (settings.sampleRate < 1 && Math.random() > settings.sampleRate) {
            return;
        }

        const stack = frames(error);
        const top = stack[0];
        const fingerprint = `${type}|${text}|${top ? `${top.filename}:${top.lineno}` : ''}`;

        // One broken handler in a render loop fires thousands of times a
        // second; a page view is worth one report per distinct error.
        if (seen.has(fingerprint)) {
            return;
        }

        seen.add(fingerprint);
        sent += 1;

        send(settings, {
            type,
            message: text.slice(0, MAX_STRING),
            stack,
            url: window.location.href,
            referrer: document.referrer || '',
            handler,
            level: 'error',
            ...(settings.release ? { release: settings.release } : {}),
        });
    }

    const onError = (event) => {
        if (event.error || event.message) {
            report(
                event.error?.name ?? 'Error',
                event.error?.message ?? event.message,
                event.error,
                'onerror',
            );
        }
    };

    const onRejection = (event) => {
        const reason = event.reason;

        report(
            reason?.name ?? 'UnhandledRejection',
            reason?.message ?? String(reason),
            reason,
            'unhandledrejection',
        );
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);

    window.DockRay = {
        captureException: (error) => report(error?.name ?? 'Error', error?.message, error, 'manual'),
        captureMessage: (message) => report('Message', message, null, 'manual'),
    };

    return () => {
        window.removeEventListener('error', onError);
        window.removeEventListener('unhandledrejection', onRejection);
        delete window.DockRay;
    };
}

const STACK_LINE = /(?:at\s+(.*?)\s+\()?(?:\()?((?:https?|file|blob):\/\/[^\s)]+?|<anonymous>):(\d+):(\d+)\)?/;

function frames(error) {
    if (typeof error?.stack !== 'string') {
        return [];
    }

    const parsed = [];

    for (const line of error.stack.split('\n')) {
        if (parsed.length >= 30) {
            break;
        }

        const match = line.match(STACK_LINE);

        if (match) {
            parsed.push({
                function: match[1] || '?',
                filename: match[2],
                lineno: Number.parseInt(match[3], 10) || 0,
                colno: Number.parseInt(match[4], 10) || 0,
            });
        }
    }

    return parsed;
}

/*
 * `keepalive` lets the request outlive the page, which matters for an error
 * thrown while the visitor is already navigating away. sendBeacon is the
 * fallback because it survives unload where fetch does not.
 */
function send(settings, body) {
    const payload = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json' };

    if (settings.token) {
        headers['X-DockRay-Token'] = settings.token;
    }

    try {
        window.fetch(settings.endpoint, {
            method: 'POST',
            keepalive: true,
            credentials: 'same-origin',
            headers,
            body: payload,
        }).catch(() => {});
    } catch {
        navigator.sendBeacon?.(settings.endpoint, payload);
    }
}

/**
 * Turns a report from a browser into an event. Everything in `payload` came
 * off the network, so every string is length-capped and anything unusable
 * makes the whole report `null` rather than a half-filled event.
 */
export function browserEvent(payload, { pageUrl = null, userAgent = null } = {}) {
    if (!payload || typeof payload !== 'object') {
        return null;
    }

    const message = text(payload.message);

    if (message === '') {
        return null;
    }

    const event = {
        platform: 'javascript',
        level: level(text(payload.level)),
        message,
        tags: { source: 'browser' },
        exception: {
            values: [
                {
                    type: text(payload.type) || 'Error',
                    value: message,
                    stacktrace: { frames: serverFrames(payload.stack) },
                },
            ],
        },
        request: {
            url: text(payload.url) || text(pageUrl),
            method: 'GET',
        },
        contexts: {
            browser: { user_agent: text(userAgent) },
        },
    };

    for (const key of ['handler', 'referrer']) {
        const value = text(payload[key]);

        if (value !== '') {
            event.tags[key] = value;
        }
    }

    const release = text(payload.release);

    if (release !== '') {
        event.release = release;
    }

    return event;
}

function serverFrames(stack) {
    if (!Array.isArray(stack)) {
        return [];
    }

    const frames = [];

    for (const frame of stack.slice(0, MAX_FRAMES)) {
        const filename = text(frame?.filename);

        if (filename === '') {
            continue;
        }

        frames.push({
            function: text(frame?.function) || '?',
            filename,
            abs_path: filename,
            lineno: Math.max(0, Number.parseInt(frame?.lineno, 10) || 0),
            colno: Math.max(0, Number.parseInt(frame?.colno, 10) || 0),
            in_app: !filename.includes('node_modules') && !filename.includes('/_next/static/chunks/framework'),
        });
    }

    // The panel renders innermost last; the browser reports it first.
    return frames.reverse();
}

function level(value) {
    return ['debug', 'info', 'warning', 'error', 'fatal'].includes(value) ? value : 'error';
}

function text(value) {
    if (typeof value !== 'string' && typeof value !== 'number') {
        return '';
    }

    return String(value).trim().slice(0, MAX_STRING);
}

import { AuthData, DEFAULT_URL } from './auth.js';
import { edgeRuntime } from './runtime/edge.js';
import { baseEvent, exceptionEvent, messageEvent, transactionEvent } from './event.js';
import { browserEvent } from './browser.js';
import { HttpTransport } from './transport.js';

const MAX_PENDING = 50;

/**
 * Sends errors, messages and transactions to a DockTHOR project.
 *
 * Without a token and a private key the client is inert: every call is a
 * no-op that resolves to false. An application can wire it up unconditionally
 * and leave the credentials out of development.
 */
export class ThorClient {
    constructor({
        token = '',
        privateKey = '',
        url = DEFAULT_URL,
        environment = globalThis.process?.env?.NODE_ENV || 'production',
        release,
        appRoot = globalThis.process?.cwd?.() ?? '',
        contextLines = 3,
        sampleRate = 1,
        tracesSampleRate = 0,
        sendDefaultPii = false,
        timeout = 5000,
        compress = true,
        logger = console,
        beforeSend,
        runtime = edgeRuntime,
    } = {}) {
        this.environment = environment;
        this.release = release;
        this.appRoot = appRoot;
        this.contextLines = contextLines;
        this.sampleRate = sampleRate;
        this.tracesSampleRate = tracesSampleRate;
        this.sendDefaultPii = sendDefaultPii;
        this.logger = logger;
        this.beforeSend = beforeSend;
        this.runtime = runtime;
        this.transport = token && privateKey
            ? new HttpTransport(new AuthData(token, privateKey, url), {
                timeout, compress, logger, gzip: runtime.gzip,
            })
            : null;

        this.pending = new Set();
    }

    get enabled() {
        return this.transport !== null;
    }

    async captureEvent(event, { transaction = false } = {}) {
        if (!this.transport) {
            return false;
        }

        const prepared = this.beforeSend ? await this.beforeSend(event) : event;

        if (!prepared) {
            return false;
        }

        return this.transport.send(prepared, { transaction });
    }

    async captureException(error, options = {}) {
        if (!this.enabled || !sampled(this.sampleRate)) {
            return false;
        }

        return this.captureEvent(exceptionEvent(error, this.eventOptions(options)));
    }

    async captureMessage(message, options = {}) {
        if (!this.enabled || !sampled(this.sampleRate)) {
            return false;
        }

        return this.captureEvent(messageEvent(message, this.eventOptions(options)));
    }

    async captureTransaction(options) {
        if (!this.enabled || !sampled(this.tracesSampleRate)) {
            return false;
        }

        return this.captureEvent(
            transactionEvent({ ...options, ...this.eventOptions(options) }),
            { transaction: true },
        );
    }

    /**
     * Reports an error a visitor's browser sent to one of your routes.
     *
     * The payload is untrusted: `browserEvent()` keeps only fields it
     * recognises, caps every string and returns null for anything it cannot
     * make an event of. The envelope — id, timestamp, environment, release —
     * is filled in here, on the server, and never taken from the browser.
     */
    async captureBrowserReport(payload, context = {}) {
        if (!this.enabled) {
            return false;
        }

        const reported = browserEvent(payload, context);

        if (!reported) {
            return false;
        }

        const envelope = baseEvent({
            level: reported.level,
            message: reported.message,
            environment: this.environment,
            release: reported.release ?? this.release,
            runtime: this.runtime,
            request: reported.request,
            tags: reported.tags,
        });

        return this.captureEvent({
            ...envelope,
            platform: reported.platform,
            exception: reported.exception,
            contexts: { ...envelope.contexts, ...reported.contexts },
        });
    }

    /**
     * Reports without making the caller wait.
     *
     * The promise is held until it settles: a floating promise gives Node
     * nothing to keep alive, so a process exiting right after the call would
     * drop the report. Failures are logged rather than surfacing as an
     * unhandled rejection somewhere unrelated.
     */
    report(promise) {
        if (!this.enabled) {
            return;
        }

        if (this.pending.size >= MAX_PENDING) {
            return;
        }

        const tracked = Promise.resolve(promise)
            .catch((error) => this.logger.warn?.(`DockTHOR failed to report: ${error.message}`))
            .finally(() => this.pending.delete(tracked));

        this.pending.add(tracked);
    }

    async flush() {
        await Promise.allSettled([...this.pending]);
    }

    async close() {
        await this.flush();
    }

    /**
     * Reports crashes that no handler caught. Off by default: taking over
     * these events changes how the process behaves on a fatal error, and that
     * is the application's decision, not the SDK's.
     */
    installGlobalHandlers({ exitOnUncaught = true } = {}) {
        process.on('uncaughtException', async (error) => {
            await this.captureException(error, { tags: { handler: 'uncaughtException' } });

            if (exitOnUncaught) {
                process.exit(1);
            }
        });

        process.on('unhandledRejection', (reason) => {
            const error = reason instanceof Error ? reason : new Error(String(reason));

            this.report(this.captureException(error, { tags: { handler: 'unhandledRejection' } }));
        });

        return this;
    }

    eventOptions(options = {}) {
        return {
            environment: this.environment,
            release: this.release,
            appRoot: this.appRoot,
            contextLines: this.contextLines,
            runtime: this.runtime,
            ...options,
            user: this.sendDefaultPii ? options.user : stripPii(options.user),
        };
    }
}

function sampled(rate) {
    return rate >= 1 || (rate > 0 && Math.random() < rate);
}

function stripPii(user) {
    if (!user) {
        return user;
    }

    const { ip_address: ignoredIp, agent: ignoredAgent, ...rest } = user;

    return rest;
}

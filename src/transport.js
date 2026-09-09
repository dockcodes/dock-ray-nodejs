import { SDK_VERSION } from './event.js';

const COMPRESSION_THRESHOLD = 1024;

/**
 * Delivers events to the ingest endpoints.
 *
 * Never rejects: an outage of the monitoring service must not become an
 * outage of the application it monitors. Failures go to the configured logger
 * and the call resolves to false.
 */
export class HttpTransport {
    constructor(auth, { timeout = 5000, compress = true, logger = console, gzip = null } = {}) {
        this.auth = auth;
        this.timeout = timeout;
        this.logger = logger;
        // Without a gzip implementation the body simply travels uncompressed;
        // the ingest accepts both.
        this.gzip = compress ? gzip : null;
    }

    async send(event, { transaction = false } = {}) {
        const url = transaction ? this.auth.transactionUrl : this.auth.projectUrl;
        const headers = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.auth.privateKey}`,
            'User-Agent': `ray.javascript.node/${SDK_VERSION}`,
        };

        let body = new TextEncoder().encode(JSON.stringify(event));

        if (this.gzip && body.length > COMPRESSION_THRESHOLD) {
            body = this.gzip(body);
            headers['Content-Encoding'] = 'gzip';
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeout);

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers,
                body,
                signal: controller.signal,
            });

            if (!response.ok) {
                this.logger.warn?.(`DockRay rejected the event with HTTP ${response.status}`);

                return false;
            }

            // A 200 carrying success:false means the monthly quota is used up.
            const payload = await response.json().catch(() => ({}));

            return payload.success === true;
        } catch (error) {
            this.logger.warn?.(`DockRay could not be reached: ${error.message}`);

            return false;
        } finally {
            clearTimeout(timer);
        }
    }
}

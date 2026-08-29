export const DEFAULT_URL = 'https://thor.dock.codes';

const API_PATH = '/api/v1';

/**
 * Ingest address and the credentials of a single project.
 *
 * The token is a public identifier that goes into the URL; the private key is
 * the project secret sent as a bearer token and must never leave the server.
 */
export class AuthData {
    constructor(token, privateKey, url = DEFAULT_URL) {
        if (!token) {
            throw new TypeError('The project token must not be empty.');
        }

        if (!privateKey) {
            throw new TypeError('The project private key must not be empty.');
        }

        const parsed = new URL(url);

        this.token = token;
        this.privateKey = privateKey;
        this.origin = `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`;
    }

    get baseUrl() {
        return `${this.origin}${API_PATH}/${this.token}`;
    }

    get projectUrl() {
        return `${this.baseUrl}/project`;
    }

    get transactionUrl() {
        return `${this.baseUrl}/transaction`;
    }
}

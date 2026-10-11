/**
 * Hex identifiers from Web Crypto for browser and edge runtimes. The full
 * Node runtime provides its own randomBytes implementation. `node:crypto` would tie the package to Node and
 * break the moment it is bundled for a middleware or an edge route.
 */
export function randomHex(bytes) {
    const buffer = new Uint8Array(bytes);

    globalThis.crypto.getRandomValues(buffer);

    return Array.from(buffer, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

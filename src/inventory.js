import { constants } from 'node:fs';
import { open, lstat, mkdir, realpath, rename, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import lockfile from 'proper-lockfile';
import { DEFAULT_URL } from './auth.js';
import { SDK_VERSION } from './event.js';

const MAX_METADATA = 8 * 1024 * 1024;
const NAME = /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const ENTRY = /^(?:node_modules\/(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+)(?:\/node_modules\/(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+)*$/;

async function jsonFile(file, max = MAX_METADATA) {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > max) throw new Error('Invalid metadata.');
        // Read a bounded amount even if a deployment changes the file after stat().
        const buffer = Buffer.alloc(stat.size + 1);
        let offset = 0;
        while (offset < buffer.length) {
            const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
            if (!bytesRead) break;
            offset += bytesRead;
        }
        if (offset > max || offset > stat.size) throw new Error('Metadata changed or exceeds the limit.');
        const value = JSON.parse(buffer.subarray(0, offset).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid metadata.');
        return value;
    } finally {
        await handle.close();
    }
}

function matches(name, pattern) {
    const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(name);
}

function inventoryEnvironment(value) {
    if (['prod', 'production'].includes(value)) return 'prod';
    if (['dev', 'development', 'staging', 'preview', 'test', 'local'].includes(value)) return 'dev';
    throw new Error('Unsupported inventory environment.');
}

/** Reads only npm lock metadata and installed package.json files, never scripts or application code. */
export async function collectInventory({ projectDirectory = process.cwd(), environment = 'production', excludePackages = [] } = {}) {
    const resolvedEnvironment = inventoryEnvironment(environment);
    if (!Array.isArray(excludePackages) || excludePackages.length > 1000
        || excludePackages.some((item) => typeof item !== 'string' || item.length > 191)) throw new Error('Invalid exclusions.');
    const root = await realpath(projectDirectory);
    const manifest = await jsonFile(join(root, 'package.json'));
    let lock;
    try {
        lock = await jsonFile(join(root, 'npm-shrinkwrap.json'));
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        lock = await jsonFile(join(root, 'package-lock.json'));
    }
    if (![2, 3].includes(lock.lockfileVersion) || !lock.packages || typeof lock.packages !== 'object'
        || Array.isArray(lock.packages) || Object.keys(lock.packages).length > 10000) throw new Error('Unsupported lockfile.');
    const lockedRoot = lock.packages[''];
    if (!lockedRoot || typeof lockedRoot !== 'object') throw new Error('Missing root metadata.');
    for (const field of ['dependencies', 'optionalDependencies']) {
        const declared = Object.entries(manifest[field] ?? {}).sort(([a], [b]) => a.localeCompare(b));
        const locked = Object.entries(lockedRoot[field] ?? {}).sort(([a], [b]) => a.localeCompare(b));
        if (JSON.stringify(declared) !== JSON.stringify(locked)) throw new Error('Lockfile is out of date.');
    }
    if (manifest.workspaces) throw new Error('Workspace inventory is unsupported.');
    const linkedTargets = new Set(Object.values(lock.packages).filter((entry) => entry?.link === true).map((entry) => entry.resolved));
    const components = new Map();
    for (const [path, metadata] of Object.entries(lock.packages)) {
        if (!path || metadata?.dev === true || metadata?.link === true || linkedTargets.has(path)) continue;
        if (!ENTRY.test(path) || !metadata || typeof metadata !== 'object') throw new Error('Invalid package path.');
        const directory = join(root, path);
        let actualDirectory;
        let installed;
        try {
            actualDirectory = await realpath(directory);
            if (!actualDirectory.startsWith(`${root}${sep}node_modules${sep}`)) throw new Error('External package directory.');
            installed = await jsonFile(join(actualDirectory, 'package.json'), 1024 * 1024);
        } catch (error) {
            // Optional packages absent on this OS are not installed; other missing metadata is a failed snapshot.
            if (error.code === 'ENOENT' && metadata.optional === true) continue;
            throw error;
        }
        const { name, version } = installed;
        if (typeof name !== 'string' || !NAME.test(name) || typeof version !== 'string' || !VERSION.test(version)
            || version.length > 64 || metadata.version !== version) throw new Error('Invalid installed package metadata.');
        if (name === manifest.name || excludePackages.some((pattern) => matches(name, pattern))) continue;
        const slug = `${name}@${version}`;
        if (slug.length > 191) throw new Error('Package identity exceeds the component limit.');
        components.set(slug, { type: 'package', slug, name, version, active: true });
        if (components.size > 1000) throw new Error('Too many packages.');
    }
    return {
        schema: 1, platform: 'nodejs', platform_version: process.versions.node,
        agent_version: SDK_VERSION, environment: resolvedEnvironment,
        components: [...components.values()].sort((a, b) => a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
    };
}

/** Explicit opt-in; safe, bounded delivery with private state and a cross-process lock. */
export class InventoryReporter {
    constructor({ enabled = false, token = '', privateKey = '', url = DEFAULT_URL,
        environment = process.env.RAY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'production', projectDirectory = process.cwd(), stateDirectory,
        excludePackages = [], logger = console } = {}) {
        this.options = { enabled, token, privateKey, url, environment, projectDirectory, excludePackages };
        this.stateDirectory = stateDirectory ?? join(tmpdir(), `dockray-node-inventory-${process.getuid?.() ?? 'user'}`);
        this.logger = logger;
        this.pending = null;
    }

    report({ force = false } = {}) {
        if (this.pending) return Promise.resolve({ status: 'busy' });
        this.pending = this.send(force).finally(() => { this.pending = null; });
        return this.pending;
    }

    start() {
        if (this.timer || this.options.enabled !== true) return;
        this.initial = setTimeout(() => { this.initial = null; void this.report(); }, 0);
        this.initial.unref();
        this.timer = setInterval(() => { void this.report(); }, 3600000);
        this.timer.unref();
    }

    async stop() {
        clearTimeout(this.initial);
        clearInterval(this.timer);
        this.initial = this.timer = null;
        if (this.pending) await this.pending;
    }

    async send(force) {
        const options = this.options;
        if (options.enabled !== true) return { status: 'disabled' };
        if (!options.token || !options.privateKey) return { status: 'not_configured' };
        let release;
        let controller;
        let timer;
        let compromised = false;
        try {
            if (typeof options.token !== 'string' || typeof options.privateKey !== 'string'
                || typeof options.url !== 'string' || /[\x00-\x20\x7f]/.test(options.url)) return { status: 'invalid_configuration' };
            const server = new URL(options.url);
            if (server.protocol !== 'https:' || server.username || server.password || server.search || server.hash
                || /[\x00-\x20\x7f]/.test(options.privateKey) || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
                return { status: 'invalid_configuration' };
            }
            const resolvedEnvironment = inventoryEnvironment(options.environment);
            await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
            const dir = await lstat(this.stateDirectory);
            if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077)) throw new Error('State must be private.');
            const identity = createHash('sha256').update(`${server.href}|${options.token}|${resolvedEnvironment}`).digest('hex');
            const file = join(this.stateDirectory, `${identity}.json`);
            try {
                release = await lockfile.lock(file, { realpath: false, retries: 0, stale: 120000, update: 15000,
                    onCompromised: () => { compromised = true; controller?.abort(); } });
            } catch (error) {
                if (error.code === 'ELOCKED') return { status: 'busy' };
                throw error;
            }
            let state = {};
            try {
                state = await jsonFile(file, 8192);
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
            const now = Math.floor(Date.now() / 1000);
            if (Number(state.retryAt ?? 0) > now) return { status: 'backoff' };
            const payload = await collectInventory(options);
            const body = JSON.stringify(payload);
            if (Buffer.byteLength(body) > 512000) throw new Error('Payload limit exceeded.');
            const hash = createHash('sha256').update(body).digest('hex');
            if (!force && state.hash === hash && Number(state.nextAt ?? 0) > now) return { status: 'not_due' };
            const save = async (value) => {
                if (compromised) throw new Error('Lock lost.');
                const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
                try {
                    const handle = await open(temporary, 'wx', 0o600);
                    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
                    await rename(temporary, file);
                } finally {
                    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
                }
            };
            state.retryAt = now + 300;
            await save(state);
            if (compromised) throw new Error('Lock lost.');
            controller = new AbortController();
            timer = setTimeout(() => controller.abort(), 8000);
            const endpoint = `${server.origin}${server.pathname.replace(/\/$/, '')}/api/v1/${encodeURIComponent(options.token)}/inventory`;
            const response = await fetch(endpoint, {
                method: 'POST', redirect: 'error', signal: controller.signal,
                headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${options.privateKey}` },
                body,
            });
            if (response.status !== 200) {
                const rawRetry = response.headers.get('retry-after');
                const seconds = /^\d+$/.test(rawRetry ?? '') ? Number(rawRetry) : Math.ceil((Date.parse(rawRetry) - Date.now()) / 1000);
                state.retryAt = now + Math.min(86400, Math.max([401, 403, 404, 429].includes(response.status) ? 3600 : 300, Number.isFinite(seconds) ? seconds : 0));
                await response.body?.cancel();
                await save(state);
                return { status: 'failed', httpStatus: response.status };
            }
            if (!response.body) throw new Error('No response body.');
            const chunks = [];
            let size = 0;
            for await (const chunk of response.body) {
                size += chunk.length;
                if (size > 65536) { controller.abort(); throw new Error('Response limit exceeded.'); }
                chunks.push(Buffer.from(chunk));
            }
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (result?.success !== true) throw new Error('Invalid response.');
            const requested = Number(result.next_report_in ?? 43200);
            const interval = Number.isFinite(requested) ? Math.min(604800, Math.max(3600, requested)) : 43200;
            await save({ hash, nextAt: now + interval, retryAt: 0 });
            const vulnerable = Number(result.vulnerable ?? 0);
            return { status: 'sent', components: payload.components.length,
                vulnerable: Number.isFinite(vulnerable) ? Math.max(0, Math.floor(vulnerable)) : 0 };
        } catch {
            // Transport errors and response bodies can contain secrets. Log no dynamic messages.
            this.logger.warn?.('DockRay package inventory could not be sent.');
            return { status: 'failed' };
        } finally {
            clearTimeout(timer);
            if (release) {
                try { await release(); } catch { this.logger.warn?.('DockRay inventory lock could not be released.'); }
            }
        }
    }
}

const FRAME = /^\s*at\s+(?:(.+?)\s+\()?(?:(.+?):(\d+):(\d+))\)?\s*$/;

const CONTEXT_LINES = 3;

const sourceCache = new Map();

/**
 * Frames from an Error, innermost call last — the order the panel renders.
 *
 * Source context is read for application frames only: a stack that runs
 * through node_modules is dozens of frames deep, and reading all of them would
 * turn every report into a burst of file I/O. Where the runtime has no
 * filesystem, frames carry no source at all.
 */
export function framesFromError(error, { contextLines = CONTEXT_LINES, appRoot = cwd(), readSource = null } = {}) {
    if (!error || typeof error.stack !== 'string') {
        return [];
    }

    const frames = [];

    for (const line of error.stack.split('\n').slice(1)) {
        const match = line.match(FRAME);

        if (!match) {
            continue;
        }

        const filename = normalisePath(match[2]);
        const lineno = Number.parseInt(match[3], 10) || 0;
        const inApp = isInApp(filename, appRoot);

        const frame = {
            function: match[1] || '?',
            filename,
            abs_path: filename,
            lineno,
            colno: Number.parseInt(match[4], 10) || 0,
            in_app: inApp,
        };

        if (inApp && contextLines > 0 && readSource) {
            Object.assign(frame, sourceContext(filename, lineno, contextLines, readSource));
        }

        frames.push(frame);
    }

    return frames.reverse();
}

function cwd() {
    return globalThis.process?.cwd?.() ?? '';
}

function normalisePath(path) {
    if (!path.startsWith('file://')) {
        return path;
    }

    try {
        return decodeURIComponent(new URL(path).pathname);
    } catch {
        return path;
    }
}

function isInApp(filename, appRoot) {
    if (filename.includes('node_modules') || filename.startsWith('node:') || filename.startsWith('webpack')) {
        return false;
    }

    return appRoot === '' || filename.startsWith(appRoot);
}

function sourceContext(filename, lineno, contextLines, readSource) {
    if (lineno < 1) {
        return {};
    }

    const lines = readSourceCached(filename, readSource);

    if (!lines || lineno > lines.length) {
        return {};
    }

    return {
        pre_context: lines.slice(Math.max(0, lineno - 1 - contextLines), lineno - 1),
        context_line: lines[lineno - 1],
        post_context: lines.slice(lineno, Math.min(lines.length, lineno + contextLines)),
    };
}

function readSourceCached(filename, readSource) {
    if (sourceCache.has(filename)) {
        return sourceCache.get(filename);
    }

    let lines = null;

    try {
        lines = readSource(filename).split('\n');
    } catch {
        lines = null;
    }

    // Misses are cached too: a file unreadable once stays unreadable.
    sourceCache.set(filename, lines);

    return lines;
}

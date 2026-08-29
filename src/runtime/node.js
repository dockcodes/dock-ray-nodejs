import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { gzipSync } from 'node:zlib';

/**
 * The parts of reporting that only a full Node process can do: naming the
 * machine, reading source files for stack context and compressing the body.
 */
export const nodeRuntime = {
    name: 'node',
    hostname,
    readSource: (path) => readFileSync(path, 'utf8'),
    gzip: (buffer) => gzipSync(buffer),
};

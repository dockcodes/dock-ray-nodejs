/**
 * Edge runtimes (Vercel Edge, Cloudflare Workers, Next middleware) have no
 * filesystem, no hostname and no zlib. Reporting still works - the event
 * simply carries no source context and travels uncompressed.
 */
export const edgeRuntime = {
    name: 'edge',
    hostname: () => null,
    readSource: () => null,
    gzip: null,
};

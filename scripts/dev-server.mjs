/**
 * Zero-dependency development server.
 *
 * Replicates the production routing contract closely enough to develop and
 * smoke-test the configurator locally without installing the Vercel CLI:
 *
 *   GET /api/badge?...   → api/badge.js (the real serverless handler)
 *   GET /<static path>   → files served from the repository root
 *
 * The server intentionally mirrors Vercel's behaviour by populating
 * `req.query` from the URL and exposing a minimal `res.status()/send()` pair,
 * so the handler under test runs unmodified.
 *
 * Usage: node scripts/dev-server.mjs [--port 3000]
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import handler from '../api/badge.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml; charset=utf-8',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.md': 'text/markdown; charset=utf-8'
};

/** Directories and dotted files that the development server never serves. */
const BLOCKED_DIRECTORIES = ['.git', 'node_modules'];

function resolveRequestedPath(urlPath) {
    const decoded = decodeURIComponent(urlPath.split('?')[0]);
    const relative = decoded === '/' ? '/index.html' : decoded;
    const resolved = path.resolve(repoRoot, `.${relative}`);
    // Reject path traversal outside the repository root.
    if (!resolved.startsWith(repoRoot + path.sep)) return null;
    const segments = path.relative(repoRoot, resolved).split(path.sep);
    // Never expose VCS metadata, dependencies or dotted files (`.env`, ...).
    if (segments.some((segment) => segment.startsWith('.') || BLOCKED_DIRECTORIES.includes(segment))) {
        return null;
    }
    return resolved;
}

/** Adapt a Node `ServerResponse` to the minimal Express-like surface. */
function adaptResponse(res) {
    res.status = (code) => {
        res.statusCode = code;
        return res;
    };
    res.send = (body) => {
        res.end(body);
        return res;
    };
    return res;
}

const port = Number.parseInt(process.argv[process.argv.indexOf('--port') + 1], 10) || Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';

const server = createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    adaptResponse(res);

    if (requestUrl.pathname === '/api/badge' || requestUrl.pathname === '/api/badge/') {
        req.query = Object.fromEntries(requestUrl.searchParams);
        try {
            await handler(req, res);
        } catch (error) {
            console.error('Handler crashed:', error);
            if (!res.headersSent) res.status(500).send('Internal Server Error');
        }
        return;
    }

    const filePath = resolveRequestedPath(requestUrl.pathname);
    if (!filePath) {
        res.status(403).setHeader('Content-Type', 'text/plain; charset=utf-8').end('Forbidden');
        return;
    }

    try {
        const stats = await stat(filePath);
        if (!stats.isFile()) throw new Error('Not a file');
    } catch {
        res.status(404).setHeader('Content-Type', 'text/plain; charset=utf-8').end('Not found');
        return;
    }

    res.writeHead(200, {
        'Content-Type': CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store'
    });
    createReadStream(filePath).pipe(res);
});

server.listen(port, host, () => {
    console.log(`Badge configurator running at http://localhost:${port}`);
    console.log(`Badge endpoint:      http://localhost:${port}/api/badge?username=OstinUA`);
});

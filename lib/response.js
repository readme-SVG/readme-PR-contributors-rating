/**
 * HTTP response helpers.
 *
 * The endpoint serves two representations with deliberately different
 * policies:
 *
 *   * `image/svg+xml` — the embeddable badge. Errors keep HTTP 200 because a
 *     non-2xx response makes GitHub Camo render a broken image; instead the
 *     badge itself becomes an explanatory notice with a short TTL so a fixed
 *     deployment recovers quickly.
 *   * `application/json` — the machine-readable API. Standard status codes,
 *     no-store caching and a permissive CORS policy so the configurator (and
 *     third-party tooling) can inspect results.
 */

import { CACHE_CONTROL_ERROR, CACHE_CONTROL_SUCCESS } from './constants.js';

/** Headers common to every SVG response. */
function svgHeaders(cacheControl) {
    return {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': cacheControl,
        'X-Content-Type-Options': 'nosniff',
        // Keep the badge inert if opened directly in a browser.
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'Access-Control-Allow-Origin': '*'
    };
}

function jsonHeaders(cacheControl) {
    return {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': cacheControl,
        'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    };
}

function applyHeaders(res, headers) {
    for (const [name, value] of Object.entries(headers)) {
        res.setHeader(name, value);
    }
}

/** Send a rendered badge. */
export function sendSvg(res, svg, { cacheControl = CACHE_CONTROL_SUCCESS } = {}) {
    applyHeaders(res, svgHeaders(cacheControl));
    res.status(200).send(svg);
}

/** Send a pre-rendered notice badge (HTTP 200 by design, see module comment). */
export function sendNotice(res, svg) {
    sendSvg(res, svg, { cacheControl: CACHE_CONTROL_ERROR });
}

/** Send a JSON body with an explicit status code. */
export function sendJson(res, payload, { status = 200, cacheControl = 'no-store' } = {}) {
    applyHeaders(res, jsonHeaders(cacheControl));
    res.status(status).send(JSON.stringify(payload, null, 2));
}

/** Answer a CORS pre-flight request. */
export function sendPreflight(res) {
    applyHeaders(res, jsonHeaders('no-store'));
    res.status(204).send('');
}

/** Answer a `HEAD` request: identical headers, empty body. */
export function sendHead(res, { cacheControl = CACHE_CONTROL_SUCCESS } = {}) {
    applyHeaders(res, svgHeaders(cacheControl));
    res.status(200).send('');
}

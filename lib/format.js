/**
 * String, number and date formatting primitives shared by the SVG renderer
 * and the JSON serializer.
 *
 * Truncation always happens *before* escaping so an XML entity is never cut
 * in half, and it is code-point aware so emoji-containing PR titles are not
 * mangled into lone surrogates.
 */

const XML_ENTITIES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
};

/** Escape the five XML metacharacters. */
export function escapeXml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => XML_ENTITIES[char]);
}

/**
 * Truncate a string to at most `maxLength` code points, appending an ellipsis
 * when characters were dropped, then XML-escape the result.
 */
export function truncate(value, maxLength) {
    const chars = [...String(value ?? '')];
    if (chars.length <= maxLength) return escapeXml(chars.join(''));
    const keep = Math.max(0, maxLength - 3);
    return escapeXml(`${chars.slice(0, keep).join('')}...`);
}

/**
 * Estimate how many characters fit into `widthPx` and truncate accordingly.
 *
 * @param {string} value Raw text.
 * @param {number} widthPx Available horizontal space.
 * @param {number} [pxPerChar] Average glyph width for the font size in use.
 * @param {number} [minLength] Lower bound so a narrow column keeps a hint.
 */
export function truncateToWidth(value, widthPx, pxPerChar = 7.2, minLength = 4) {
    const maxLength = Math.max(minLength, Math.floor(Math.max(0, widthPx) / pxPerChar));
    return truncate(value, maxLength);
}

/**
 * Format a star count using compact suffixes (`1.5k`, `12.3k`, `1.2m`).
 * Values below 1000 are returned verbatim.
 */
export function formatCompactNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return '0';
    if (number < 1000) return String(Math.trunc(number));
    if (number < 1_000_000) return `${(number / 1000).toFixed(1)}k`;
    if (number < 1_000_000_000) return `${(number / 1_000_000).toFixed(1)}m`;
    return `${(number / 1_000_000_000).toFixed(1)}b`;
}

/** Format an ISO timestamp as `YYYY-MM-DD`, tolerating invalid input. */
export function formatDate(isoTimestamp) {
    if (!isoTimestamp) return '—';
    const date = new Date(isoTimestamp);
    return Number.isNaN(date.getTime()) ? '—' : date.toISOString().slice(0, 10);
}

/**
 * Coerce an arbitrary value into a finite, non-negative integer with a safe
 * fallback. Used for upstream counters that are occasionally `null`.
 */
export function safeNonNegativeInt(value, fallback = 0) {
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback;
}

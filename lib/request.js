/**
 * Defensive parsing of every user-controlled input that reaches the badge.
 *
 * Design rules:
 *   1. A malformed value never throws: it falls back to the documented
 *      default, so an embedded badge cannot break because of a typo.
 *   2. Only *semantically impossible* requests (an inverted date range, a
 *      username that sanitises to nothing) raise {@link BadgeRequestError}.
 *   3. Everything returned here is already safe to interpolate into SVG, with
 *      the single exception of `customTitle`, which is escaped at render time.
 */

import {
    COLUMN_KEYS,
    COLOR_KEYS,
    DEFAULTS,
    LIMITS,
    ORDER_KEYS,
    OUTPUT_FORMATS,
    SORT_KEYS,
    THEME_PRESETS
} from './constants.js';
import { BadgeRequestError } from './errors.js';

/**
 * Read a single-valued query parameter.
 *
 * Serverless platforms parse repeated parameters (`?limit=1&limit=2`) into an
 * array, and some proxies pass `null`; both cases collapse to the first
 * string value, and anything non-scalar collapses to `undefined`.
 */
export function queryParam(query, key) {
    const value = query?.[key];
    if (Array.isArray(value)) {
        const first = value.find((entry) => entry !== null && entry !== undefined);
        return first === undefined ? undefined : String(first);
    }
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'object') return undefined;
    return String(value);
}

/** Parse a strict `true` / `false` flag, falling back to `defaultValue`. */
export function parseBoolean(query, key, defaultValue) {
    const raw = queryParam(query, key)?.trim().toLowerCase();
    if (raw === 'true' || raw === '1' || raw === 'yes') return true;
    if (raw === 'false' || raw === '0' || raw === 'no') return false;
    return defaultValue;
}

/** Clamp a number into the inclusive `[min, max]` range. */
export function clamp(value, min, max) {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
}

/**
 * Parse an integer and clamp it to a range.
 *
 * @param {unknown} raw Raw parameter value.
 * @param {number} fallback Value used when `raw` is not a number.
 * @param {[number, number]} range Inclusive bounds.
 */
export function parseIntegerInRange(raw, fallback, [min, max]) {
    const parsed = Number.parseInt(String(raw ?? ''), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return clamp(parsed, min, max);
}

/** Restrict a GitHub login to its legal character set and maximum length. */
export function sanitizeUsername(input) {
    return String(input ?? '')
        .replace(/[^a-zA-Z0-9-]/g, '')
        .slice(0, 39);
}

/**
 * Strip characters that carry no meaning in a badge caption, collapse
 * whitespace and cap the length.
 */
export function sanitizeCaption(input, maxLength = 80) {
    return String(input ?? '')
        .replace(/[^\w\s\-.,!?()@#&:;'/]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
}

/**
 * Validate a hex colour literal. Accepts the 3, 4, 6 and 8 digit forms (RGB,
 * RGBA and their shorthand); anything else falls back to `fallback`.
 */
export function sanitizeHexColor(input, fallback) {
    if (typeof input !== 'string') return fallback;
    const cleaned = input.trim().replace(/^#/, '');
    return /^(?:[a-fA-F0-9]{6}|[a-fA-F0-9]{3,4}|[a-fA-F0-9]{8})$/.test(cleaned) ? cleaned.toLowerCase() : fallback;
}

/**
 * Normalise a hex colour to the 6 digit form consumed by `<input type="color">`.
 * Returns `null` when the value cannot be expanded losslessly.
 */
export function expandHexColor(value) {
    const cleaned = String(value ?? '').trim().replace(/^#/, '');
    if (/^[a-fA-F0-9]{3}$/.test(cleaned)) {
        return cleaned
            .split('')
            .map((char) => char + char)
            .join('')
            .toLowerCase();
    }
    if (/^[a-fA-F0-9]{6}$/.test(cleaned)) return cleaned.toLowerCase();
    return null;
}

/**
 * Parse `col_order` into a de-duplicated list of known column keys, falling
 * back to the default order when no valid key is present.
 */
export function parseColumnOrder(raw) {
    const seen = new Set();
    const parsed = [];
    for (const token of String(raw ?? '').split(',')) {
        const key = token.trim().toLowerCase();
        if (COLUMN_KEYS.includes(key) && !seen.has(key)) {
            seen.add(key);
            parsed.push(key);
        }
    }
    return parsed.length > 0 ? parsed : [...COLUMN_KEYS];
}

/** Pick the first whitelisted token, or `fallback`. */
function parseEnum(raw, allowed, fallback) {
    const value = String(raw ?? '').trim().toLowerCase();
    return allowed.includes(value) ? value : fallback;
}

/**
 * Parse an ISO-8601 `YYYY-MM-DD` (or full ISO timestamp) date bound.
 *
 * @returns {number | null} Epoch milliseconds, or `null` when unset.
 * @throws {BadgeRequestError} When the value is present but unparseable.
 */
export function parseIsoDate(raw, field) {
    const value = String(raw ?? '').trim();
    if (!value) return null;
    const timestamp = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
    if (Number.isNaN(timestamp)) {
        throw new BadgeRequestError(`\`${field}\` must be an ISO-8601 date (YYYY-MM-DD).`, 'invalid_date');
    }
    return timestamp;
}

/** Resolve the base colours for a theme, honouring an unknown-theme fallback. */
function resolvePalette(query, transparent) {
    const themeName = parseEnum(queryParam(query, 'theme'), Object.keys(THEME_PRESETS), DEFAULTS.theme);
    const preset = THEME_PRESETS[themeName].colors;
    const colors = {};
    for (const key of COLOR_KEYS) {
        colors[key] = sanitizeHexColor(queryParam(query, `${key}_color`), preset[key]);
    }
    return { theme: themeName, colors, transparent };
}

/**
 * Translate an incoming request into a fully validated options object.
 *
 * @param {Record<string, unknown>} query Parsed query string object.
 * @returns {Readonly<object>} Validated options consumed by the client/rendering layers.
 */
export function parseOptions(query = {}) {
    const username = sanitizeUsername(queryParam(query, 'username') || DEFAULTS.username);
    if (!username) {
        throw new BadgeRequestError('`username` must contain at least one GitHub login character.', 'invalid_username');
    }

    const transparent = parseBoolean(query, 'transparent', false);
    const since = parseIsoDate(queryParam(query, 'since'), 'since');
    const until = parseIsoDate(queryParam(query, 'until'), 'until');
    if (since !== null && until !== null && since > until) {
        throw new BadgeRequestError('`since` must be earlier than or equal to `until`.', 'invalid_range');
    }

    const sort = parseEnum(queryParam(query, 'sort'), SORT_KEYS, DEFAULTS.sort);
    const order = parseEnum(queryParam(query, 'order'), ORDER_KEYS, DEFAULTS.order);

    return Object.freeze({
        username,
        limit: parseIntegerInRange(queryParam(query, 'limit'), DEFAULTS.limit, LIMITS.limit),
        sort,
        order,
        format: parseEnum(queryParam(query, 'format'), OUTPUT_FORMATS, DEFAULTS.format),
        showPr: parseBoolean(query, 'show_pr', true),
        showDate: parseBoolean(query, 'show_date', true),
        showLang: parseBoolean(query, 'show_lang', false),
        showChanges: parseBoolean(query, 'show_changes', false),
        showRank: parseBoolean(query, 'show_rank', false),
        uniqueRepos: parseBoolean(query, 'unique_repos', false),
        showRejected: parseBoolean(query, 'show_rejected', false),
        repoNameFormat: parseEnum(queryParam(query, 'repo_name_format'), ['full', 'short'], 'full'),
        colOrder: parseColumnOrder(queryParam(query, 'col_order')),
        customTitle: sanitizeCaption(queryParam(query, 'custom_title'), 80),
        badgeWidth: parseIntegerInRange(queryParam(query, 'badge_width'), DEFAULTS.badgeWidth, LIMITS.badgeWidth),
        rowHeight: parseIntegerInRange(queryParam(query, 'row_height'), DEFAULTS.rowHeight, LIMITS.rowHeight),
        repoWidth: parseIntegerInRange(queryParam(query, 'repo_width'), DEFAULTS.repoWidth, LIMITS.repoWidth),
        langWidth: parseIntegerInRange(queryParam(query, 'lang_width'), DEFAULTS.langWidth, LIMITS.langWidth),
        prWidth: parseIntegerInRange(queryParam(query, 'pr_width'), DEFAULTS.prWidth, LIMITS.prWidth),
        dateWidth: parseIntegerInRange(queryParam(query, 'date_width'), DEFAULTS.dateWidth, LIMITS.dateWidth),
        changesWidth: parseIntegerInRange(
            queryParam(query, 'changes_width'),
            DEFAULTS.changesWidth,
            LIMITS.changesWidth
        ),
        starsWidth: parseIntegerInRange(queryParam(query, 'stars_width'), DEFAULTS.starsWidth, LIMITS.starsWidth),
        since,
        until,
        ...resolvePalette(query, transparent)
    });
}

/**
 * Render an options object back into a canonical query string, omitting every
 * value that equals its server-side default. Used by the JSON payload so the
 * configurator can round-trip an existing badge URL.
 *
 * @param {object} opts Validated options.
 * @returns {string} Query string without the leading `?`.
 */
export function serializeOptions(opts) {
    const params = new URLSearchParams();
    params.set('username', opts.username);
    const setIfDefaultDiffers = (param, value, fallback) => {
        if (String(value) !== String(fallback)) params.set(param, String(value));
    };

    setIfDefaultDiffers('limit', opts.limit, DEFAULTS.limit);
    if (opts.sort !== DEFAULTS.sort) params.set('sort', opts.sort);
    if (opts.order !== DEFAULTS.order) params.set('order', opts.order);
    if (opts.showPr !== true) params.set('show_pr', String(opts.showPr));
    if (opts.showDate !== true) params.set('show_date', String(opts.showDate));
    if (opts.showLang) params.set('show_lang', 'true');
    if (opts.showChanges) params.set('show_changes', 'true');
    if (opts.showRank) params.set('show_rank', 'true');
    if (opts.uniqueRepos) params.set('unique_repos', 'true');
    if (opts.showRejected) params.set('show_rejected', 'true');
    if (opts.repoNameFormat !== 'full') params.set('repo_name_format', opts.repoNameFormat);
    if (opts.colOrder.join(',') !== COLUMN_KEYS.join(',')) params.set('col_order', opts.colOrder.join(','));
    if (opts.customTitle) params.set('custom_title', opts.customTitle);

    setIfDefaultDiffers('badge_width', opts.badgeWidth, DEFAULTS.badgeWidth);
    setIfDefaultDiffers('row_height', opts.rowHeight, DEFAULTS.rowHeight);
    setIfDefaultDiffers('repo_width', opts.repoWidth, DEFAULTS.repoWidth);
    setIfDefaultDiffers('lang_width', opts.langWidth, DEFAULTS.langWidth);
    setIfDefaultDiffers('pr_width', opts.prWidth, DEFAULTS.prWidth);
    setIfDefaultDiffers('date_width', opts.dateWidth, DEFAULTS.dateWidth);
    setIfDefaultDiffers('changes_width', opts.changesWidth, DEFAULTS.changesWidth);
    setIfDefaultDiffers('stars_width', opts.starsWidth, DEFAULTS.starsWidth);

    if (opts.since !== null) params.set('since', new Date(opts.since).toISOString().slice(0, 10));
    if (opts.until !== null) params.set('until', new Date(opts.until).toISOString().slice(0, 10));

    const preset = THEME_PRESETS[opts.theme];
    for (const key of COLOR_KEYS) {
        if (opts.colors[key] !== preset.colors[key]) params.set(`${key}_color`, opts.colors[key]);
    }
    if (opts.theme !== DEFAULTS.theme) params.set('theme', opts.theme);
    if (opts.transparent) params.set('transparent', 'true');
    return params.toString();
}

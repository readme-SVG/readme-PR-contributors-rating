/**
 * Vercel serverless handler that renders a configurable SVG badge with the
 * top pull requests of a GitHub user, ordered by repository star count.
 *
 * The module is organized in five sections:
 *   1. Constants           – defaults, limits and static lookup tables.
 *   2. Request parsing     – defensive parsing of every query parameter.
 *   3. GitHub API client   – paginated GraphQL search with timeout and a
 *                            small in-memory cache to shield the upstream.
 *   4. SVG rendering       – layout computation and markup generation.
 *   5. HTTP helpers        – response writers for success and error badges.
 *
 * All user-controlled values are either whitelisted, clamped to a numeric
 * range, or XML-escaped before they reach the SVG output.
 */

// ---------------------------------------------------------------------------
// 1. Constants
// ---------------------------------------------------------------------------

const GRAPHQL_ENDPOINT = 'https://api.github.com/graphql';
const REST_API_ROOT = 'https://api.github.com';

/** Maximum number of search pages fetched per request (100 nodes each). */
const MAX_PAGES = 5;
const PAGE_SIZE = 100;

/** Number of `repo:owner/name` qualifiers batched per REST search request. */
const REST_REPO_BATCH_SIZE = 30;

/** Per-request timeout for upstream GitHub API calls, in milliseconds. */
const UPSTREAM_TIMEOUT_MS = 8_000;

/**
 * Cumulative budget for multi-page GraphQL search pagination, kept comfortably
 * below Vercel Hobby's 10 s serverless execution limit.
 */
const GRAPHQL_PAGINATION_BUDGET_MS = 6_500;

/**
 * Warm-instance cache for raw pull request pages, keyed by GitHub username.
 * Serverless instances are short-lived, so this is a best-effort optimization
 * that mainly protects the upstream API from bursty README traffic.
 */
const PR_CACHE_TTL_MS = 10 * 60 * 1000;
const PR_CACHE_MAX_ENTRIES = 200;
const prCache = new Map();

/** Cache-Control applied to successfully rendered badges (2 days). */
const CACHE_CONTROL_OK = 'public, s-maxage=172800, stale-while-revalidate=86400';
/** Cache-Control applied to error badges (kept short so retries recover fast). */
const CACHE_CONTROL_ERROR = 'public, s-maxage=300, stale-while-revalidate=60';

/**
 * GitHub's primary language colors, mirrored from
 * https://github.com/github/linguist/blob/main/lib/linguist/languages.yml
 * for the most common languages.
 */
const LANG_COLORS = {
    'JavaScript': '#f1e05a',
    'TypeScript': '#3178c6',
    'Python': '#3572A5',
    'Java': '#b07219',
    'Go': '#00ADD8',
    'Rust': '#dea584',
    'C': '#555555',
    'C++': '#f34b7d',
    'C#': '#178600',
    'Ruby': '#701516',
    'PHP': '#4F5D95',
    'Swift': '#F05138',
    'Kotlin': '#A97BFF',
    'Dart': '#00B4AB',
    'Scala': '#c22d40',
    'Shell': '#89e051',
    'Lua': '#000080',
    'HTML': '#e34c26',
    'CSS': '#563d7c',
    'Vue': '#41b883',
    'Svelte': '#ff3e00',
    'Elixir': '#6e4a7e',
    'Haskell': '#5e5086',
    'R': '#198CE7',
    'Objective-C': '#438eff',
    'Perl': '#0298c3',
    'Zig': '#ec915c'
};

const DEFAULT_LANGUAGE_COLOR = '#8b949e';

/** Octicon paths used for the PR status and star icons (16x16 viewBox). */
const ICONS = {
    merged: {
        color: '#a371f7',
        path: 'M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z'
    },
    open: {
        color: '#3fb950',
        path: 'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.25 2.25 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854v4.792a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm.75-2.25a2.25 2.25 0 1 1 0 4.5 2.25 2.25 0 0 1 0-4.5Z'
    },
    closed: {
        color: '#f85149',
        path: 'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.25 2.25 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854v4.792a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z'
    },
    star: {
        path: 'M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z'
    }
};

const FONT_STACK = 'Segoe UI, Helvetica, Arial, sans-serif';

/** Fixed layout metrics (pixels) shared by the header and every row. */
const LAYOUT = {
    leftPad: 20,
    rightPad: 20,
    iconWidth: 24,
    iconGap: 8,
    colGap: 12,
    headerY: 75,
    headerLineY: 85,
    firstRowY: 110,
    titleY: 35,
    repoMinWidth: 60,
    columnMinWidth: 50
};

/** Column keys accepted in the `col_order` query parameter, in default order. */
const COLUMN_KEYS = ['pr', 'date', 'lang', 'changes'];

const DEFAULTS = {
    username: 'OstinUA',
    limit: 7,
    badgeWidth: 830,
    rowHeight: 40,
    repoWidth: 180,
    langWidth: 80,
    prWidth: 320,
    dateWidth: 90,
    changesWidth: 100,
    starsWidth: 60,
    colors: {
        bg: '0d1117',
        text: 'c9d1d9',
        title: '58a6ff',
        muted: '8b949e',
        star: 'e3b341',
        border: '30363d',
        shadow: '000000'
    }
};

// ---------------------------------------------------------------------------
// 2. Request parsing
// ---------------------------------------------------------------------------

/**
 * Read a single-valued query parameter. Vercel parses repeated parameters
 * (e.g. `?limit=1&limit=2`) into arrays; the first value wins.
 */
function queryParam(query, key) {
    const value = query[key];
    return Array.isArray(value) ? value[0] : value;
}

function parseBool(query, key, defaultValue) {
    const value = queryParam(query, key);
    if (value === 'true') return true;
    if (value === 'false') return false;
    return defaultValue;
}

function parseIntInRange(raw, fallback, min, max) {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return clamp(parsed, min, max);
}

function clamp(value, min, max) {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
}

/** Restrict a GitHub login to its legal character set and length. */
function sanitizeUsername(input) {
    return String(input).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 39);
}

/** Strip characters that carry no meaning in a badge title, then cap length. */
function sanitizeText(input, maxLength) {
    return String(input)
        .replace(/[^\w\s\-.,!?()@#&:;'/]/g, '')
        .trim()
        .slice(0, maxLength);
}

/**
 * Validate a hex color literal. Accepts 3, 4, 6 and 8 digit forms (RGB,
 * RGBA and their shorthand); anything else falls back to the default.
 */
function sanitizeHex(input, fallback) {
    if (typeof input !== 'string') return fallback;
    const cleaned = input.replace(/^#/, '');
    return /^[a-fA-F0-9]{3}$|^[a-fA-F0-9]{4}$|^[a-fA-F0-9]{6}$|^[a-fA-F0-9]{8}$/.test(cleaned)
        ? cleaned
        : fallback;
}

/**
 * Parse the `col_order` parameter into a deduplicated list of known column
 * keys, falling back to the default order when nothing valid is provided.
 */
function parseColumnOrder(raw) {
    const parsed = String(raw || '')
        .split(',')
        .map((key) => key.trim().toLowerCase())
        .filter((key, index, arr) => COLUMN_KEYS.includes(key) && arr.indexOf(key) === index);
    return parsed.length ? parsed : [...COLUMN_KEYS];
}

/**
 * Translate the incoming request into a fully validated options object.
 * No value returned here requires further sanitization before rendering,
 * except free-form text (title), which is escaped at render time.
 */
function parseOptions(query) {
    return {
        username: sanitizeUsername(queryParam(query, 'username') || DEFAULTS.username),
        limit: parseIntInRange(queryParam(query, 'limit'), DEFAULTS.limit, 1, 15),
        showPr: parseBool(query, 'show_pr', true),
        showDate: parseBool(query, 'show_date', true),
        showLang: parseBool(query, 'show_lang', false),
        showChanges: parseBool(query, 'show_changes', false),
        uniqueRepos: parseBool(query, 'unique_repos', false),
        showRejected: parseBool(query, 'show_rejected', false),
        repoNameFormat: queryParam(query, 'repo_name_format') === 'short' ? 'short' : 'full',
        colOrder: parseColumnOrder(queryParam(query, 'col_order')),
        customTitle: sanitizeText(queryParam(query, 'custom_title') || '', 80),
        badgeWidth: parseIntInRange(queryParam(query, 'badge_width'), DEFAULTS.badgeWidth, 700, 1400),
        rowHeight: parseIntInRange(queryParam(query, 'row_height'), DEFAULTS.rowHeight, 30, 60),
        repoWidth: parseIntInRange(queryParam(query, 'repo_width'), DEFAULTS.repoWidth, 60, 500),
        langWidth: parseIntInRange(queryParam(query, 'lang_width'), DEFAULTS.langWidth, 60, 300),
        prWidth: parseIntInRange(queryParam(query, 'pr_width'), DEFAULTS.prWidth, 100, 900),
        dateWidth: parseIntInRange(queryParam(query, 'date_width'), DEFAULTS.dateWidth, 60, 300),
        changesWidth: parseIntInRange(queryParam(query, 'changes_width'), DEFAULTS.changesWidth, 70, 300),
        starsWidth: parseIntInRange(queryParam(query, 'stars_width'), DEFAULTS.starsWidth, 50, 240),
        colors: {
            bg: sanitizeHex(queryParam(query, 'bg_color'), DEFAULTS.colors.bg),
            text: sanitizeHex(queryParam(query, 'text_color'), DEFAULTS.colors.text),
            title: sanitizeHex(queryParam(query, 'title_color'), DEFAULTS.colors.title),
            muted: sanitizeHex(queryParam(query, 'muted_color'), DEFAULTS.colors.muted),
            star: sanitizeHex(queryParam(query, 'star_color'), DEFAULTS.colors.star),
            border: sanitizeHex(queryParam(query, 'border_color'), DEFAULTS.colors.border),
            shadow: sanitizeHex(queryParam(query, 'shadow_color'), DEFAULTS.colors.shadow)
        },
        transparent: parseBool(query, 'transparent', false)
    };
}

// ---------------------------------------------------------------------------
// 3. GitHub API client
// ---------------------------------------------------------------------------

/** Thrown for expected upstream failures; carries a user-visible message. */
class BadgeUpstreamError extends Error {
    constructor(message) {
        super(message);
        this.name = 'BadgeUpstreamError';
    }
}

const PULL_REQUEST_SEARCH_QUERY = `
    query FetchUserPrs($query: String!, $first: Int!, $after: String) {
        search(query: $query, type: ISSUE, first: $first, after: $after) {
            pageInfo {
                hasNextPage
                endCursor
            }
            nodes {
                ... on PullRequest {
                    id
                    title
                    url
                    createdAt
                    state
                    mergedAt
                    repository {
                        url
                        stargazerCount
                        primaryLanguage {
                            name
                        }
                    }
                }
            }
        }
    }
`;

const PULL_REQUEST_DIFF_STATS_QUERY = `
    query FetchPrDiffStats($ids: [ID!]!) {
        nodes(ids: $ids) {
            ... on PullRequest {
                id
                additions
                deletions
            }
        }
    }
`;

function stripWrappingQuotes(value) {
    if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'")))
    ) {
        return value.slice(1, -1).trim();
    }
    return value;
}

/**
 * Normalize a raw token value read from environment variables. Strips
 * surrounding whitespace, accidental `KEY=` assignments, wrapping quotes and
 * redundant `Bearer` / `token` scheme prefixes that are often pasted into
 * hosting dashboards by mistake.
 *
 * @param {string | undefined} raw Raw environment variable value.
 * @returns {string} Cleaned token string, or `""` when nothing usable remains.
 */
export function normalizeGithubToken(raw) {
    if (typeof raw !== 'string') return '';
    let value = raw.trim();
    if (!value) return '';

    value = value.replace(/^(?:GITHUB_TOKEN|GH_TOKEN)\s*=\s*/i, '').trim();
    value = stripWrappingQuotes(value);
    value = value.replace(/^(?:bearer|token)\s+/i, '').trim();
    value = stripWrappingQuotes(value);
    return value;
}

function resolveGithubToken() {
    return normalizeGithubToken(process.env.GITHUB_TOKEN) || normalizeGithubToken(process.env.GH_TOKEN);
}

function buildGithubHeaders(token) {
    const headers = {
        'User-Agent': 'readme-pr-contributors-rating',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
    };
    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }
    return headers;
}

/** Clear the warm-instance PR cache (exposed for deterministic unit tests). */
export function clearPrCache() {
    prCache.clear();
}

/** Evict expired entries, then trim the cache to its maximum size (FIFO). */
function pruneCache() {
    const now = Date.now();
    for (const [key, entry] of prCache) {
        if (now - entry.timestamp >= PR_CACHE_TTL_MS) {
            prCache.delete(key);
        }
    }
    while (prCache.size > PR_CACHE_MAX_ENTRIES) {
        prCache.delete(prCache.keys().next().value);
    }
}

function isRateLimitResponse(response, bodyText = '') {
    if (response.status === 429) return true;
    if (response.headers && typeof response.headers.get === 'function') {
        if (response.headers.get('x-ratelimit-remaining') === '0') return true;
        if (response.headers.get('retry-after')) return true;
    }
    return /rate limit|secondary rate|abuse detection/i.test(bodyText);
}

/**
 * Translate a non-2xx GitHub HTTP response into a specific, actionable
 * `BadgeUpstreamError`.
 */
async function throwForHttpError(response, { token, username, allow422 = false }) {
    if (allow422 && response.status === 422) {
        throw new BadgeUpstreamError(`User "${username}" not found.`);
    }
    if (response.status === 401) {
        throw new BadgeUpstreamError(
            token
                ? 'Invalid or expired GITHUB_TOKEN in deployment settings.'
                : 'GitHub API authentication required (set GITHUB_TOKEN).'
        );
    }
    if (response.status === 403 || response.status === 429) {
        const bodyText = await response.text().catch(() => '');
        if (isRateLimitResponse(response, bodyText)) {
            throw new BadgeUpstreamError(
                token
                    ? 'API rate limit exceeded. Please try again later.'
                    : 'Anonymous API rate limit exceeded. Set GITHUB_TOKEN.'
            );
        }
        throw new BadgeUpstreamError('GitHub API access forbidden (check GITHUB_TOKEN permissions).');
    }
    throw new BadgeUpstreamError(`GitHub API error (${response.status}).`);
}

async function fetchWithTimeout(url, options) {
    try {
        return await fetch(url, {
            ...options,
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
        });
    } catch (error) {
        if (error && error.name === 'TimeoutError') {
            throw new BadgeUpstreamError('GitHub API request timed out. Please try again later.');
        }
        throw error;
    }
}

/**
 * Fetch pull requests authored by `username` (up to MAX_PAGES * 100 PRs) via
 * the authenticated GitHub GraphQL API.
 */
async function fetchPullRequestsGraphql(username, token) {
    const headers = { ...buildGithubHeaders(token), 'Content-Type': 'application/json' };
    const startedAt = Date.now();
    const prs = [];
    let cursor = null;
    let hasNextPage = true;
    let page = 0;

    while (hasNextPage && page < MAX_PAGES) {
        if (page > 0 && Date.now() - startedAt >= GRAPHQL_PAGINATION_BUDGET_MS) {
            break;
        }

        const response = await fetchWithTimeout(GRAPHQL_ENDPOINT, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                query: PULL_REQUEST_SEARCH_QUERY,
                variables: {
                    query: `is:pr author:${username} sort:created-desc`,
                    first: PAGE_SIZE,
                    after: cursor
                }
            })
        });

        if (!response.ok) {
            await throwForHttpError(response, { token, username });
        }

        const payload = await response.json();
        const search = payload.data && payload.data.search;

        if (Array.isArray(payload.errors) && payload.errors.length) {
            const combined = payload.errors
                .map((entry) => entry && entry.message)
                .filter(Boolean)
                .join(' ');
            if (/Could not resolve to a User/i.test(combined)) {
                throw new BadgeUpstreamError(`User "${username}" not found.`);
            }
            if (/rate limit|secondary rate|abuse/i.test(combined)) {
                throw new BadgeUpstreamError('API rate limit exceeded. Please try again later.');
            }
            if (/bad credentials|requires authentication/i.test(combined)) {
                throw new BadgeUpstreamError('Invalid or expired GITHUB_TOKEN in deployment settings.');
            }
            // Partial node errors (e.g. a single PR in an org-SAML-restricted
            // repository) still return valid `data.search.nodes` alongside
            // `null` placeholders; only abort if `search` itself is missing.
            if (!search) {
                throw new BadgeUpstreamError('GitHub GraphQL query failed.');
            }
        }

        if (!search) {
            throw new BadgeUpstreamError('GitHub GraphQL query failed.');
        }

        for (const node of Array.isArray(search.nodes) ? search.nodes : []) {
            if (!node || !node.repository) continue;
            prs.push(normalizeGraphqlPullRequest(node));
        }

        hasNextPage = Boolean(search.pageInfo && search.pageInfo.hasNextPage);
        cursor = search.pageInfo ? search.pageInfo.endCursor : null;
        page += 1;
    }

    return prs;
}

/** Extract `owner/repo` from a GitHub repository URL (`https://.../owner/repo`). */
function extractRepoFullName(repositoryUrl) {
    const parts = String(repositoryUrl || '').split('/').filter(Boolean).slice(-2);
    return parts.length === 2 ? `${parts[0]}/${parts[1]}` : '';
}

/**
 * Unauthenticated fallback via the GitHub REST Search API. Because GitHub's
 * GraphQL endpoint strictly requires a token, deployments that omit
 * `GITHUB_TOKEN` fall back to `/search/issues` plus batched
 * `/search/repositories` lookups (typically 2 requests per uncached user).
 */
async function fetchPullRequestsRest(username) {
    const headers = buildGithubHeaders('');
    const issueParams = new URLSearchParams({
        q: `is:pr author:${username}`,
        sort: 'created',
        order: 'desc',
        per_page: String(PAGE_SIZE)
    });

    const issueResponse = await fetchWithTimeout(
        `${REST_API_ROOT}/search/issues?${issueParams.toString()}`,
        { method: 'GET', headers }
    );
    if (!issueResponse.ok) {
        await throwForHttpError(issueResponse, { token: '', username, allow422: true });
    }

    const issuePayload = await issueResponse.json();
    const items = Array.isArray(issuePayload.items) ? issuePayload.items : [];
    if (items.length === 0) return [];

    // Collect unique `owner/repo` identifiers and batch-query their star counts
    // and primary languages through `/search/repositories`.
    const uniqueRepos = [];
    const seenLower = new Set();
    for (const item of items) {
        const fullName = extractRepoFullName(item && item.repository_url);
        if (!fullName) continue;
        const lower = fullName.toLowerCase();
        if (!seenLower.has(lower)) {
            seenLower.add(lower);
            uniqueRepos.push(fullName);
        }
    }

    const repoMeta = new Map();
    const batches = [];
    for (let i = 0; i < uniqueRepos.length; i += REST_REPO_BATCH_SIZE) {
        batches.push(uniqueRepos.slice(i, i + REST_REPO_BATCH_SIZE));
    }

    await Promise.all(
        batches.map(async (batch) => {
            const repoParams = new URLSearchParams({
                q: batch.map((name) => `repo:${name}`).join(' '),
                per_page: '100'
            });
            const repoResponse = await fetchWithTimeout(
                `${REST_API_ROOT}/search/repositories?${repoParams.toString()}`,
                { method: 'GET', headers }
            );
            // If every repository in a batch was deleted or turned private,
            // GitHub returns 422; treat that batch as empty metadata.
            if (repoResponse.status === 422) return;
            if (!repoResponse.ok) {
                await throwForHttpError(repoResponse, { token: '', username });
            }
            const repoPayload = await repoResponse.json();
            for (const repo of Array.isArray(repoPayload.items) ? repoPayload.items : []) {
                if (!repo || typeof repo.full_name !== 'string') continue;
                repoMeta.set(repo.full_name.toLowerCase(), {
                    stars: Number.isFinite(repo.stargazers_count) ? repo.stargazers_count : 0,
                    language: repo.language || null
                });
            }
        })
    );

    const prs = [];
    for (const item of items) {
        if (!item || !item.repository_url) continue;
        const fullName = extractRepoFullName(item.repository_url);
        const meta = repoMeta.get(fullName.toLowerCase()) || { stars: 0, language: null };
        prs.push(normalizeRestPullRequest(item, meta));
    }
    return prs;
}

/**
 * Lazily populate `additions` and `deletions` for the already-selected badge
 * rows (`<= 15`) when `show_changes=true` was requested. Fetching diff stats
 * only for displayed rows avoids hundreds of slow Git RPCs during multi-page
 * search pagination. Best-effort: transient failures fall back to `+0 / -0`
 * without failing the badge, while successful lookups update the cache.
 */
async function enrichPullRequestChanges(rows, token) {
    const missing = rows.filter((pr) => pr.additions === null || pr.deletions === null);
    if (missing.length === 0) return;

    if (token) {
        const byId = new Map();
        for (const pr of missing) {
            if (typeof pr.id === 'string' && pr.id) {
                byId.set(pr.id, pr);
            }
        }
        if (byId.size === 0) return;

        try {
            const response = await fetchWithTimeout(GRAPHQL_ENDPOINT, {
                method: 'POST',
                headers: { ...buildGithubHeaders(token), 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query: PULL_REQUEST_DIFF_STATS_QUERY,
                    variables: { ids: [...byId.keys()] }
                })
            });
            if (!response.ok) return;
            const payload = await response.json();
            const nodes = payload && payload.data && payload.data.nodes;
            for (const node of Array.isArray(nodes) ? nodes : []) {
                if (!node || !node.id) continue;
                const target = byId.get(node.id);
                if (!target) continue;
                target.additions = Number.isFinite(node.additions) ? node.additions : 0;
                target.deletions = Number.isFinite(node.deletions) ? node.deletions : 0;
            }
        } catch {
            // Keep null so renderRow falls back to +0/-0 without poisoning cache.
        }
        return;
    }

    const restTargets = missing.filter(
        (pr) => typeof pr.pullApiUrl === 'string' && pr.pullApiUrl.startsWith(`${REST_API_ROOT}/repos/`)
    );
    if (restTargets.length === 0) return;

    const headers = buildGithubHeaders('');
    await Promise.all(
        restTargets.map(async (pr) => {
            try {
                const response = await fetchWithTimeout(pr.pullApiUrl, { method: 'GET', headers });
                if (!response.ok) return;
                const detail = await response.json();
                pr.additions = Number.isFinite(detail.additions) ? detail.additions : 0;
                pr.deletions = Number.isFinite(detail.deletions) ? detail.deletions : 0;
            } catch {
                // Keep null so renderRow falls back to +0/-0 without poisoning cache.
            }
        })
    );
}

/**
 * Fetch pull requests authored by `username`, using GraphQL when `token` is
 * available and falling back to the public REST Search API otherwise. Results
 * are cached per `(mode, username)` for a short TTL to shield upstream quotas.
 *
 * @param {string} username Sanitized GitHub login.
 * @param {string} token Normalized GitHub token (empty string if unset).
 * @returns {Promise<Array<object>>} Normalized pull request records.
 * @throws {BadgeUpstreamError} On rate limits, auth failures or API errors.
 */
async function fetchUserPullRequests(username, token) {
    const cacheKey = `${token ? 'graphql' : 'rest'}:${username.toLowerCase()}`;
    const cached = prCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < PR_CACHE_TTL_MS) {
        return cached.prs;
    }

    const prs = token
        ? await fetchPullRequestsGraphql(username, token)
        : await fetchPullRequestsRest(username);

    pruneCache();
    prCache.set(cacheKey, { timestamp: Date.now(), prs });
    return prs;
}

/** Map a GraphQL PullRequest node onto the flat record used by the renderer. */
function normalizeGraphqlPullRequest(node) {
    return {
        id: node.id,
        title: node.title || '',
        url: node.url || '',
        createdAt: node.createdAt,
        state: String(node.state || '').toLowerCase(),
        mergedAt: node.mergedAt || null,
        repositoryUrl: node.repository.url || '',
        repoStars: Number.isFinite(node.repository.stargazerCount) ? node.repository.stargazerCount : 0,
        repoLanguage: node.repository.primaryLanguage ? node.repository.primaryLanguage.name : null,
        additions: Number.isFinite(node.additions) ? node.additions : null,
        deletions: Number.isFinite(node.deletions) ? node.deletions : null,
        pullApiUrl: null
    };
}

/** Map a REST `/search/issues` PR item + repo metadata onto the renderer record. */
function normalizeRestPullRequest(item, repoMeta) {
    const pullInfo = item.pull_request || {};
    return {
        id: String(item.node_id || item.id || ''),
        title: item.title || '',
        url: item.html_url || '',
        createdAt: item.created_at,
        state: String(item.state || '').toLowerCase(),
        mergedAt: pullInfo.merged_at || null,
        repositoryUrl: item.repository_url || '',
        repoStars: repoMeta.stars,
        repoLanguage: repoMeta.language,
        additions: null,
        deletions: null,
        pullApiUrl: typeof pullInfo.url === 'string' ? pullInfo.url : null
    };
}

/**
 * Filter, deduplicate and rank pull requests according to the badge options.
 *
 * @param {Array<object>} prs Normalized pull request records.
 * @param {object} opts Parsed request options.
 * @returns {Array<object>} The rows to render, already sorted and capped.
 */
function selectPullRequests(prs, opts) {
    let selected = prs.filter((pr) => {
        const isMerged = Boolean(pr.mergedAt);
        if (isMerged || pr.state === 'open') return true;
        return opts.showRejected && pr.state === 'closed';
    });

    if (opts.uniqueRepos) {
        const latestPerRepo = new Map();
        for (const pr of selected) {
            const repoKey = String(pr.repositoryUrl || '').toLowerCase();
            const existing = latestPerRepo.get(repoKey);
            if (!existing || Date.parse(pr.createdAt) > Date.parse(existing.createdAt)) {
                latestPerRepo.set(repoKey, pr);
            }
        }
        selected = [...latestPerRepo.values()];
    }

    selected.sort((a, b) => b.repoStars - a.repoStars);
    return selected.slice(0, opts.limit);
}

// ---------------------------------------------------------------------------
// 4. SVG rendering
// ---------------------------------------------------------------------------

function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Truncate a raw string to `length` characters (code-point safe) and escape
 * the result. Truncation happens before escaping so XML entities are never
 * cut in half.
 */
function truncate(str, length) {
    const chars = [...String(str)];
    const truncated = chars.length > length ? `${chars.slice(0, Math.max(0, length - 3)).join('')}...` : chars.join('');
    return escapeXml(truncated);
}

/** Estimate how many characters fit into `widthPx` and truncate accordingly. */
function truncateToWidth(str, widthPx, pxPerChar = 7.2, minLength = 4) {
    const maxLength = Math.max(minLength, Math.floor(Math.max(0, widthPx) / pxPerChar));
    return truncate(str, maxLength);
}

/** Format a star count with a compact `k` suffix for large values. */
function formatStars(stars) {
    return stars >= 1000 ? `${(stars / 1000).toFixed(1)}k` : String(stars);
}

/** Format an ISO timestamp as `YYYY-MM-DD`, tolerating invalid dates. */
function formatDate(isoTimestamp) {
    const date = new Date(isoTimestamp);
    return Number.isNaN(date.getTime()) ? '—' : date.toISOString().slice(0, 10);
}

/** Resolve the status icon (merged / open / closed) for a pull request. */
function getStatusIcon(pr) {
    if (pr.mergedAt) return ICONS.merged;
    if (pr.state === 'open') return ICONS.open;
    return ICONS.closed;
}

/** Derive the display name of a repository from its API URL. */
function formatRepoName(repositoryUrl, format) {
    const parts = String(repositoryUrl).split('/').filter(Boolean).slice(-2);
    if (format === 'short') return parts[parts.length - 1] || '';
    return parts.join('/');
}

/**
 * Distribute `remainingWidth` across optional columns proportionally to their
 * preferred widths, guaranteeing `minWidth` per column whenever possible and
 * consuming every pixel exactly (no rounding drift).
 */
function distributePreferredWidths(columns, remainingWidth, minWidth) {
    if (!columns.length) return [];
    if (remainingWidth <= 0) return columns.map(() => 0);

    const sumPreferred = columns.reduce((sum, col) => sum + col.preferredWidth, 0);

    // Everything fits: hand out preferred widths and give the slack to the
    // widest column so the row still spans the full badge.
    if (sumPreferred <= remainingWidth) {
        const widths = columns.map((col) => col.preferredWidth);
        let largestIdx = 0;
        for (let i = 1; i < columns.length; i += 1) {
            if (columns[i].preferredWidth > columns[largestIdx].preferredWidth) {
                largestIdx = i;
            }
        }
        widths[largestIdx] += remainingWidth - sumPreferred;
        return widths;
    }

    // Not even the minimums fit: split whatever space is left evenly.
    const floorMinTotal = minWidth * columns.length;
    if (remainingWidth <= floorMinTotal) {
        const even = Math.floor(remainingWidth / columns.length);
        const widths = columns.map(() => even);
        widths[widths.length - 1] += remainingWidth - even * columns.length;
        return widths;
    }

    // Proportional distribution with a hard per-column minimum, then repair
    // rounding overshoot from the right and give any remainder to the last
    // column so the total matches `remainingWidth` exactly.
    const widths = columns.map((col) =>
        Math.max(minWidth, Math.floor((col.preferredWidth * remainingWidth) / sumPreferred))
    );
    let used = widths.reduce((sum, value) => sum + value, 0);

    while (used > remainingWidth) {
        let changed = false;
        for (let i = widths.length - 1; i >= 0 && used > remainingWidth; i -= 1) {
            if (widths[i] > minWidth) {
                widths[i] -= 1;
                used -= 1;
                changed = true;
            }
        }
        if (!changed) break;
    }
    if (used < remainingWidth) {
        widths[widths.length - 1] += remainingWidth - used;
    }
    return widths;
}

/**
 * Compute the horizontal position and final width of every visible column.
 * The repository column absorbs shrinking first; optional columns then share
 * whatever width remains between the repo and stars columns.
 */
function computeColumnLayout(opts) {
    const { badgeWidth, repoWidth, starsWidth, colOrder } = opts;
    const { leftPad, rightPad, iconWidth, iconGap, colGap, repoMinWidth, columnMinWidth } = LAYOUT;

    const columnDefs = {
        pr: { key: 'pr', label: 'PULL REQUEST', preferredWidth: opts.prWidth, enabled: opts.showPr },
        date: { key: 'date', label: 'DATE', preferredWidth: opts.dateWidth, enabled: opts.showDate },
        lang: { key: 'lang', label: 'LANGUAGE', preferredWidth: opts.langWidth, enabled: opts.showLang },
        changes: { key: 'changes', label: 'CHANGES', preferredWidth: opts.changesWidth, enabled: opts.showChanges }
    };
    const optionalColumns = colOrder.map((key) => columnDefs[key]).filter((col) => col && col.enabled);

    const xIcon = leftPad;
    const xRepo = xIcon + iconWidth + iconGap;
    const xStars = badgeWidth - rightPad - starsWidth;

    let repoActualWidth = repoWidth;

    if (optionalColumns.length === 0) {
        // Repo is the only flexible column: let it span the full middle area.
        repoActualWidth = Math.max(0, xStars - xRepo - colGap);
    } else {
        const totalGaps = (optionalColumns.length + 1) * colGap;
        const fixedWidth = leftPad + iconWidth + iconGap + repoActualWidth + starsWidth + rightPad + totalGaps;
        let remainingWidth = badgeWidth - fixedWidth;

        if (remainingWidth < 0) {
            // Shrink the repo column (never below its minimum) to make room.
            const shrink = Math.min(repoActualWidth - repoMinWidth, -remainingWidth);
            repoActualWidth -= Math.max(0, shrink);
            remainingWidth =
                badgeWidth - (leftPad + iconWidth + iconGap + repoActualWidth + starsWidth + rightPad + totalGaps);
        }

        const optionalWidths = distributePreferredWidths(
            optionalColumns,
            Math.max(0, remainingWidth),
            columnMinWidth
        );
        optionalColumns.forEach((col, index) => {
            col.actualWidth = optionalWidths[index];
        });
    }

    const columns = {
        repo: { key: 'repo', label: 'REPOSITORY', x: xRepo, actualWidth: repoActualWidth },
        stars: { key: 'stars', label: 'STARS', x: xStars, actualWidth: starsWidth }
    };

    let xCurrent = xRepo + repoActualWidth + colGap;
    for (const col of optionalColumns) {
        columns[col.key] = { key: col.key, label: col.label, x: xCurrent, actualWidth: col.actualWidth };
        xCurrent += col.actualWidth + colGap;
    }

    return { columns, optionalColumns, xIcon };
}

/** Render the uppercase header row (column captions plus divider line). */
function renderHeader(layout, opts) {
    const { columns, optionalColumns } = layout;
    const shadowAttr = opts.transparent ? ' filter="url(#textShadow)"' : '';

    const headerColumns = [
        columns.repo,
        ...optionalColumns.map((col) => columns[col.key]),
        columns.stars
    ];
    const labels = headerColumns
        .filter((col) => col && col.actualWidth > 0)
        .map(
            (col) =>
                `<text x="${col.x}" y="${LAYOUT.headerY}" font-family="${FONT_STACK}" font-size="12" font-weight="bold" fill="#${opts.colors.muted}"${shadowAttr}>${col.label}</text>`
        )
        .join('');

    const line = opts.transparent
        ? ''
        : `<line x1="${LAYOUT.leftPad}" y1="${LAYOUT.headerLineY}" x2="${opts.badgeWidth - LAYOUT.rightPad}" y2="${LAYOUT.headerLineY}" stroke="#${opts.colors.border}" stroke-width="1"/>`;

    return labels + line;
}

/** Render a single pull request row (status icon plus enabled columns). */
function renderRow(pr, index, layout, opts) {
    const { columns, xIcon } = layout;
    const textColor = `#${opts.colors.text}`;
    const mutedColor = `#${opts.colors.muted}`;
    const shadowAttr = opts.transparent ? ' filter="url(#textShadow)"' : '';
    const yOffset = LAYOUT.firstRowY + index * opts.rowHeight;
    const icon = getStatusIcon(pr);

    const parts = [`<g transform="translate(0, ${yOffset})">`];
    parts.push(
        `<svg x="${xIcon}" y="-12" width="16" height="16" viewBox="0 0 16 16" fill="${icon.color}"><path fill-rule="evenodd" d="${icon.path}"></path></svg>`
    );

    if (columns.repo.actualWidth > 0) {
        const repoName = formatRepoName(pr.repositoryUrl, opts.repoNameFormat);
        const repoText = truncateToWidth(repoName, columns.repo.actualWidth - 6, 7.2, 6);
        parts.push(
            `<text x="${columns.repo.x}" y="0" font-family="${FONT_STACK}" font-size="14" font-weight="600" fill="${textColor}"${shadowAttr}>${repoText}</text>`
        );
    }

    if (columns.pr && columns.pr.actualWidth > 0) {
        const titleText = truncateToWidth(pr.title, columns.pr.actualWidth - 6, 7.2, 8);
        parts.push(
            `<text x="${columns.pr.x}" y="0" font-family="${FONT_STACK}" font-size="14" fill="${mutedColor}"${shadowAttr}>${titleText}</text>`
        );
    }

    if (columns.date && columns.date.actualWidth > 0) {
        const dateText = truncateToWidth(formatDate(pr.createdAt), columns.date.actualWidth - 6, 7, 8);
        parts.push(
            `<text x="${columns.date.x}" y="0" font-family="${FONT_STACK}" font-size="13" fill="${mutedColor}"${shadowAttr}>${dateText}</text>`
        );
    }

    if (columns.lang && columns.lang.actualWidth > 0) {
        const language = pr.repoLanguage || 'Unknown';
        const languageColor = LANG_COLORS[pr.repoLanguage] || DEFAULT_LANGUAGE_COLOR;
        const languageText = truncateToWidth(language, Math.max(12, columns.lang.actualWidth - 16), 7, 4);
        parts.push(`<circle cx="${columns.lang.x + 5}" cy="-4" r="5" fill="${languageColor}"/>`);
        parts.push(
            `<text x="${columns.lang.x + 14}" y="0" font-family="${FONT_STACK}" font-size="13" fill="${textColor}"${shadowAttr}>${languageText}</text>`
        );
    }

    if (columns.changes && columns.changes.actualWidth > 0) {
        const additions = `+${Number.isFinite(pr.additions) ? pr.additions : 0}`;
        const deletions = `-${Number.isFinite(pr.deletions) ? pr.deletions : 0}`;
        // Fall back to a compact separator when the column is narrow.
        const compact = (additions.length + deletions.length + 3) * 7.2 > Math.max(0, columns.changes.actualWidth - 2);
        const separator = compact ? '/' : ' / ';
        parts.push(
            `<text x="${columns.changes.x}" y="0" font-family="${FONT_STACK}" font-size="13"${shadowAttr}>` +
                `<tspan fill="#3fb950">${escapeXml(additions)}</tspan>` +
                `<tspan fill="${mutedColor}">${escapeXml(separator)}</tspan>` +
                `<tspan fill="#f85149">${escapeXml(deletions)}</tspan></text>`
        );
    }

    if (columns.stars.actualWidth > 0) {
        const starsText = truncateToWidth(formatStars(pr.repoStars), Math.max(10, columns.stars.actualWidth - 20), 7, 2);
        parts.push(
            `<svg x="${columns.stars.x}" y="-12" width="16" height="16" viewBox="0 0 16 16" fill="#${opts.colors.star}"><path fill-rule="evenodd" d="${ICONS.star.path}"></path></svg>`
        );
        parts.push(
            `<text x="${columns.stars.x + 20}" y="0" font-family="${FONT_STACK}" font-size="13" font-weight="bold" fill="#${opts.colors.star}"${shadowAttr}>${starsText}</text>`
        );
    }

    parts.push('</g>');
    return parts.join('');
}

/**
 * Assemble the complete badge SVG document.
 *
 * @param {Array<object>} prs Rows to render (already filtered and sorted).
 * @param {object} opts Parsed and validated request options.
 * @returns {string} SVG markup.
 */
function buildSvg(prs, opts) {
    const layout = computeColumnLayout(opts);
    const svgHeight = LAYOUT.headerLineY + 10 + prs.length * opts.rowHeight;
    const shadowAttr = opts.transparent ? ' filter="url(#textShadow)"' : '';

    const headerText = opts.customTitle
        ? escapeXml(opts.customTitle)
        : `Top Contributions by ${escapeXml(opts.username)}`;

    const defs = opts.transparent
        ? `<defs><filter id="textShadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="0" stdDeviation="1" flood-color="#${opts.colors.shadow}" flood-opacity="1"/></filter></defs>`
        : '';
    const background = opts.transparent
        ? ''
        : `<rect width="${opts.badgeWidth - 2}" height="${svgHeight - 2}" x="1" y="1" rx="8" fill="#${opts.colors.bg}" stroke="#${opts.colors.border}" stroke-width="1"/>`;

    const rows = prs.map((pr, index) => renderRow(pr, index, layout, opts)).join('');

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${opts.badgeWidth}" height="${svgHeight}" viewBox="0 0 ${opts.badgeWidth} ${svgHeight}">
  ${defs}
  ${background}
  <text x="${LAYOUT.leftPad}" y="${LAYOUT.titleY}" font-family="${FONT_STACK}" font-size="18" font-weight="bold" fill="#${opts.colors.title}"${shadowAttr}>${headerText}</text>
  ${renderHeader(layout, opts)}
  ${rows}
</svg>`;
}

/**
 * Render a small placeholder badge conveying an error message. Errors are
 * still served as `image/svg+xml` with HTTP 200 so README embeds degrade
 * gracefully instead of showing a broken image.
 */
function buildErrorSvg(message, opts) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="60" viewBox="0 0 500 60">
  <rect width="498" height="58" x="1" y="1" rx="8" fill="#${opts.colors.bg}" stroke="#${opts.colors.border}" stroke-width="1"/>
  <text x="20" y="35" font-family="${FONT_STACK}" font-size="14" fill="#f85149">${escapeXml(message)}</text>
</svg>`;
}

// ---------------------------------------------------------------------------
// 5. HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Apply headers common to every SVG response. The strict CSP keeps the badge
 * inert if it is opened directly in a browser.
 */
function applySvgHeaders(res, cacheControl) {
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', cacheControl);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', 'default-src \'none\'; style-src \'unsafe-inline\'; sandbox');
}

function sendSvg(res, svg, cacheControl) {
    applySvgHeaders(res, cacheControl);
    res.status(200).send(svg);
}

function sendErrorSvg(res, message, opts) {
    sendSvg(res, buildErrorSvg(message, opts), CACHE_CONTROL_ERROR);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
    const opts = parseOptions(req.query || {});
    const token = resolveGithubToken();

    try {
        const allPrs = await fetchUserPullRequests(opts.username, token);
        if (allPrs.length === 0) {
            sendErrorSvg(res, `No Pull Requests found for "${opts.username}".`, opts);
            return;
        }

        const rows = selectPullRequests(allPrs, opts);
        if (rows.length === 0) {
            sendErrorSvg(res, 'No Pull Requests match the selected filters.', opts);
            return;
        }

        if (opts.showChanges) {
            await enrichPullRequestChanges(rows, token);
        }

        sendSvg(res, buildSvg(rows, opts), CACHE_CONTROL_OK);
    } catch (error) {
        if (error instanceof BadgeUpstreamError) {
            sendErrorSvg(res, error.message, opts);
            return;
        }
        // Unexpected failure: log for observability, answer with a generic badge.
        console.error('Badge generation failed:', error);
        sendErrorSvg(res, 'Error generating badge. Please try again.', opts);
    }
}

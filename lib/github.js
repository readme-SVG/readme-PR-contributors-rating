/**
 * GitHub API client.
 *
 * Two mutually exclusive transports are supported:
 *
 *   * GraphQL (preferred, requires `GITHUB_TOKEN`) — one paginated `search`
 *     query returns pull requests together with repository stars and primary
 *     language; diff statistics are fetched later, in a single batched call,
 *     and only for the rows that are actually rendered.
 *   * REST Search (fallback, works anonymously) — `/search/issues` plus
 *     batched `/search/repositories` lookups for star counts and languages.
 *
 * Both transports normalise into the same `PullRequestRecord` shape so the
 * ranking and rendering layers stay transport-agnostic.
 *
 * @typedef {object} PullRequestRecord
 * @property {string}      id           Stable GitHub node id (used for batching).
 * @property {string}      title        PR title.
 * @property {string}      url          HTML URL of the PR.
 * @property {string}      createdAt    ISO-8601 creation timestamp.
 * @property {'open'|'merged'|'closed'} state  Normalised lifecycle state.
 * @property {string|null} mergedAt     ISO-8601 merge timestamp.
 * @property {string}      repositoryUrl Repository HTML URL.
 * @property {number}      repoStars    Stargazer count of the repository.
 * @property {string|null} repoLanguage Primary language name.
 * @property {number|null} additions    Added lines, `null` until enriched.
 * @property {number|null} deletions    Deleted lines, `null` until enriched.
 * @property {string|null} pullApiUrl   REST URL of the PR, REST transport only.
 */

import {
    CHANGE_SORT_CANDIDATES_ANON,
    CHANGE_SORT_CANDIDATES_AUTH,
    GITHUB_GRAPHQL_ENDPOINT,
    GITHUB_REST_ROOT,
    PAGINATION_BUDGET_MS,
    PR_CACHE_MAX_ENTRIES,
    PR_CACHE_TTL_MS,
    REST_REPO_BATCH_SIZE,
    SEARCH_MAX_PAGES,
    SEARCH_PAGE_SIZE,
    UPSTREAM_TIMEOUT_MS
} from './constants.js';
import { TtlCache } from './cache.js';
import { BadgeUpstreamError } from './errors.js';
import { safeNonNegativeInt } from './format.js';

// ---------------------------------------------------------------------------
// Token handling
// ---------------------------------------------------------------------------

function stripWrappingQuotes(value) {
    const paired =
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));
    return paired ? value.slice(1, -1).trim() : value;
}

/**
 * Normalise a raw token value read from an environment variable.
 *
 * Hosting dashboards make it remarkably easy to paste `GITHUB_TOKEN=ghp_...`,
 * a `Bearer ` prefix or stray quotes into the value field; all of those are
 * transparently repaired instead of surfacing a confusing 401 to the user.
 *
 * @param {string | undefined} raw Raw environment variable value.
 * @returns {string} Cleaned token, or `""` when nothing usable remains.
 */
export function normalizeGithubToken(raw) {
    if (typeof raw !== 'string') return '';
    let value = raw.trim();
    if (!value) return '';

    value = value.replace(/^(?:GITHUB_TOKEN|GH_TOKEN)\s*=\s*/i, '').trim();
    value = stripWrappingQuotes(value);
    // Reject placeholder values that would otherwise be sent as credentials.
    if (/^(?:<.*>|\$\{.*\}|changeme|null|undefined|true|false)$/i.test(value)) return '';
    value = value.replace(/^(?:bearer|token)\s+/i, '').trim();
    value = stripWrappingQuotes(value);
    return value;
}

/** Resolve the active token from the supported environment variables. */
export function resolveGithubToken(env = process.env) {
    return normalizeGithubToken(env.GITHUB_TOKEN) || normalizeGithubToken(env.GH_TOKEN);
}

function buildHeaders(token) {
    const headers = {
        'User-Agent': 'readme-pr-contributors-rating',
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url, options) {
    try {
        return await fetch(url, { ...options, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    } catch (error) {
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
            throw new BadgeUpstreamError('GitHub API request timed out. Please try again later.', 'upstream_timeout', 504);
        }
        throw new BadgeUpstreamError('Could not reach the GitHub API.', 'upstream_unreachable', 502);
    }
}

function isRateLimitResponse(response, bodyText = '') {
    if (response.status === 429) return true;
    if (typeof response.headers?.get === 'function') {
        if (response.headers.get('x-ratelimit-remaining') === '0') return true;
        if (response.headers.get('retry-after')) return true;
    }
    return /rate limit|secondary rate|abuse detection/i.test(bodyText);
}

/** Translate a non-2xx GitHub response into an actionable error. */
async function throwForHttpError(response, { token, username, allow422 = false }) {
    if (allow422 && response.status === 422) {
        throw new BadgeUpstreamError(`User "${username}" not found.`, 'user_not_found', 404);
    }
    if (response.status === 401) {
        throw new BadgeUpstreamError(
            token
                ? 'Invalid or expired GITHUB_TOKEN in deployment settings.'
                : 'GitHub API authentication required (set GITHUB_TOKEN).',
            'unauthorized',
            502
        );
    }
    if (response.status === 403 || response.status === 429) {
        const bodyText = await response.text().catch(() => '');
        if (isRateLimitResponse(response, bodyText)) {
            throw new BadgeUpstreamError(
                token
                    ? 'API rate limit exceeded. Please try again later.'
                    : 'Anonymous API rate limit exceeded. Set GITHUB_TOKEN.',
                'rate_limited',
                429
            );
        }
        throw new BadgeUpstreamError(
            'GitHub API access forbidden (check GITHUB_TOKEN permissions).',
            'forbidden',
            502
        );
    }
    throw new BadgeUpstreamError(`GitHub API error (${response.status}).`, 'upstream_error', 502);
}

/**
 * Map GraphQL `errors[]` entries onto a specific error. Partial node errors
 * (a single PR hidden by organisation SAML enforcement) are tolerated as long
 * as usable data came back.
 */
function throwForGraphqlErrors(errors, hasSearchData) {
    const combined = errors
        .map((entry) => entry?.message)
        .filter(Boolean)
        .join(' ');

    if (/could not resolve to a user/i.test(combined)) {
        throw new BadgeUpstreamError('User not found.', 'user_not_found', 404);
    }
    if (/rate limit|secondary rate|abuse/i.test(combined)) {
        throw new BadgeUpstreamError('API rate limit exceeded. Please try again later.', 'rate_limited', 429);
    }
    if (/bad credentials|requires authentication/i.test(combined)) {
        throw new BadgeUpstreamError('Invalid or expired GITHUB_TOKEN in deployment settings.', 'unauthorized', 502);
    }
    if (!hasSearchData) {
        throw new BadgeUpstreamError('GitHub GraphQL query failed.', 'upstream_error', 502);
    }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const PULL_REQUEST_SEARCH_QUERY = `
    query FetchUserPullRequests($query: String!, $first: Int!, $after: String) {
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
    query FetchPullRequestDiffStats($ids: [ID!]!) {
        nodes(ids: $ids) {
            ... on PullRequest {
                id
                additions
                deletions
            }
        }
    }
`;

// ---------------------------------------------------------------------------
// Transport: GraphQL
// ---------------------------------------------------------------------------

async function postGraphql({ query, variables, token, username = '' }) {
    const response = await fetchWithTimeout(GITHUB_GRAPHQL_ENDPOINT, {
        method: 'POST',
        headers: { ...buildHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables })
    });
    if (!response.ok) {
        await throwForHttpError(response, { token, username });
    }
    return response.json();
}

/**
 * Build the GitHub search qualifiers describing the requested time window.
 *
 * Sorting is transport-specific (GraphQL accepts `sort:` inside the query,
 * REST exposes it as dedicated query parameters), so it is deliberately not
 * part of this string.
 */
function buildSearchQuery(username, since, until) {
    const qualifiers = ['is:pr', `author:${username}`];
    if (since !== null) qualifiers.push(`created:>=${toIsoDate(since)}`);
    if (until !== null) qualifiers.push(`created:<=${toIsoDate(until)}`);
    return qualifiers.join(' ');
}

/** Format an epoch timestamp as `YYYY-MM-DD` in UTC. */
function toIsoDate(timestamp) {
    return new Date(timestamp).toISOString().slice(0, 10);
}

/**
 * Fetch pull requests authored by `username` through the GraphQL search API.
 * Pagination stops on the last page, at the page cap or when the cumulative
 * latency budget for the serverless invocation is exhausted.
 */
async function fetchPullRequestsGraphql({ username, token, since, until }) {
    const prs = [];
    const startedAt = Date.now();
    let cursor = null;
    let hasNextPage = true;

    for (let page = 0; hasNextPage && page < SEARCH_MAX_PAGES; page += 1) {
        if (page > 0 && Date.now() - startedAt >= PAGINATION_BUDGET_MS) break;

        const payload = await postGraphql({
            query: PULL_REQUEST_SEARCH_QUERY,
            variables: {
                query: `${buildSearchQuery(username, since, until)} sort:created-desc`,
                first: SEARCH_PAGE_SIZE,
                after: cursor
            },
            token,
            username
        });

        const search = payload?.data?.search;
        if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
            throwForGraphqlErrors(payload.errors, Boolean(search));
        }
        if (!search) throw new BadgeUpstreamError('GitHub GraphQL query failed.', 'upstream_error', 502);

        for (const node of Array.isArray(search.nodes) ? search.nodes : []) {
            const record = normalizeGraphqlPullRequest(node);
            if (record) prs.push(record);
        }

        hasNextPage = Boolean(search.pageInfo?.hasNextPage);
        cursor = search.pageInfo?.endCursor ?? null;
    }

    return prs;
}

/** Map a GraphQL `PullRequest` node onto a {@link PullRequestRecord}. */
function normalizeGraphqlPullRequest(node) {
    if (!node?.repository?.url) return null;
    const merged = Boolean(node.mergedAt);
    return {
        id: typeof node.id === 'string' ? node.id : '',
        title: typeof node.title === 'string' ? node.title : '',
        url: typeof node.url === 'string' ? node.url : '',
        createdAt: node.createdAt ?? null,
        state: merged ? 'merged' : String(node.state ?? '').toLowerCase() === 'open' ? 'open' : 'closed',
        mergedAt: node.mergedAt ?? null,
        repositoryUrl: node.repository.url,
        repoStars: safeNonNegativeInt(node.repository.stargazerCount),
        repoLanguage: node.repository.primaryLanguage?.name ?? null,
        additions: Number.isFinite(node.additions) ? node.additions : null,
        deletions: Number.isFinite(node.deletions) ? node.deletions : null,
        pullApiUrl: null
    };
}

// ---------------------------------------------------------------------------
// Transport: REST Search
// ---------------------------------------------------------------------------

/** Extract `owner/repo` from a GitHub repository API URL. */
function extractRepoFullName(repositoryUrl) {
    const parts = String(repositoryUrl ?? '')
        .split('/')
        .filter(Boolean)
        .slice(-2);
    return parts.length === 2 ? parts.join('/') : '';
}

/** Batch-query star counts and primary languages for a set of repositories. */
async function fetchRepositoryMetadata(repositories, headers) {
    const metadata = new Map();
    const batches = [];
    for (let index = 0; index < repositories.length; index += REST_REPO_BATCH_SIZE) {
        batches.push(repositories.slice(index, index + REST_REPO_BATCH_SIZE));
    }

    await Promise.all(
        batches.map(async (batch) => {
            const params = new URLSearchParams({
                q: batch.map((name) => `repo:${name}`).join(' '),
                per_page: '100'
            });
            const response = await fetchWithTimeout(`${GITHUB_REST_ROOT}/search/repositories?${params}`, {
                method: 'GET',
                headers
            });
            // A batch where every repository was deleted or made private
            // yields 422; treat it as "no metadata" instead of failing.
            if (response.status === 422) return;
            if (!response.ok) {
                await throwForHttpError(response, { token: '', username: '' });
            }
            const payload = await response.json();
            for (const repo of Array.isArray(payload?.items) ? payload.items : []) {
                if (typeof repo?.full_name !== 'string') continue;
                metadata.set(repo.full_name.toLowerCase(), {
                    stars: safeNonNegativeInt(repo.stargazers_count),
                    language: repo.language ?? null
                });
            }
        })
    );

    return metadata;
}

/**
 * Unauthenticated fallback. GraphQL strictly requires a token, so deployments
 * without one use `/search/issues` (up to 100 recent PRs) plus batched
 * `/search/repositories` lookups — typically two requests per uncached user.
 */
async function fetchPullRequestsRest({ username, since, until }) {
    const headers = buildHeaders('');
    const params = new URLSearchParams({
        q: buildSearchQuery(username, since, until),
        sort: 'created',
        order: 'desc',
        per_page: String(SEARCH_PAGE_SIZE)
    });

    const response = await fetchWithTimeout(`${GITHUB_REST_ROOT}/search/issues?${params}`, {
        method: 'GET',
        headers
    });
    if (!response.ok) {
        await throwForHttpError(response, { token: '', username, allow422: true });
    }

    const payload = await response.json();
    const items = (Array.isArray(payload?.items) ? payload.items : []).filter((item) => item?.repository_url);
    if (items.length === 0) return [];

    const uniqueRepositories = [];
    const seen = new Set();
    for (const item of items) {
        const fullName = extractRepoFullName(item.repository_url);
        if (!fullName) continue;
        const key = fullName.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            uniqueRepositories.push(fullName);
        }
    }

    const metadata = await fetchRepositoryMetadata(uniqueRepositories, headers);
    return items.map((item) => {
        const fullName = extractRepoFullName(item.repository_url);
        return normalizeRestPullRequest(item, metadata.get(fullName.toLowerCase()) ?? { stars: 0, language: null });
    });
}

/** Map a REST `/search/issues` item plus repository metadata to a record. */
function normalizeRestPullRequest(item, repositoryMeta) {
    const pull = item.pull_request ?? {};
    const merged = Boolean(pull.merged_at);
    return {
        id: String(item.node_id ?? item.id ?? ''),
        title: typeof item.title === 'string' ? item.title : '',
        url: typeof item.html_url === 'string' ? item.html_url : '',
        createdAt: item.created_at ?? null,
        state: merged ? 'merged' : String(item.state ?? '').toLowerCase() === 'open' ? 'open' : 'closed',
        mergedAt: pull.merged_at ?? null,
        repositoryUrl: item.repository_url,
        repoStars: repositoryMeta.stars,
        repoLanguage: repositoryMeta.language,
        additions: null,
        deletions: null,
        pullApiUrl: typeof pull.url === 'string' ? pull.url : null
    };
}

// ---------------------------------------------------------------------------
// Diff statistics
// ---------------------------------------------------------------------------

/**
 * Populate `additions` / `deletions` for the supplied records.
 *
 * The function is best-effort by design: a failed lookup leaves the fields as
 * `null` so the renderer prints an em dash instead of a misleading `+0 / -0`,
 * and never fails the badge.
 *
 * @param {PullRequestRecord[]} records Records to enrich in place.
 * @param {{ token: string, limit?: number }} context Transport and batch cap.
 */
export async function enrichDiffStatistics(records, { token, limit = records.length }) {
    const pending = records.slice(0, limit).filter((pr) => pr.additions === null || pr.deletions === null);
    if (pending.length === 0) return;

    if (token) {
        const byId = new Map(pending.filter((pr) => pr.id).map((pr) => [pr.id, pr]));
        if (byId.size === 0) return;
        try {
            const payload = await postGraphql({
                query: PULL_REQUEST_DIFF_STATS_QUERY,
                variables: { ids: [...byId.keys()] },
                token
            });
            for (const node of Array.isArray(payload?.data?.nodes) ? payload.data.nodes : []) {
                const target = node?.id ? byId.get(node.id) : null;
                if (!target) continue;
                target.additions = safeNonNegativeInt(node.additions);
                target.deletions = safeNonNegativeInt(node.deletions);
            }
        } catch {
            // Keep `null`; the renderer degrades gracefully.
        }
        return;
    }

    const headers = buildHeaders('');
    await Promise.all(
        pending
            .filter((pr) => typeof pr.pullApiUrl === 'string' && pr.pullApiUrl.startsWith(`${GITHUB_REST_ROOT}/repos/`))
            .map(async (pr) => {
                try {
                    const response = await fetchWithTimeout(pr.pullApiUrl, { method: 'GET', headers });
                    if (!response.ok) return;
                    const detail = await response.json();
                    pr.additions = safeNonNegativeInt(detail?.additions);
                    pr.deletions = safeNonNegativeInt(detail?.deletions);
                } catch {
                    // Best-effort: leave the fields unset.
                }
            })
    );
}

/** Number of rows worth enriching when sorting by change size. */
export function diffEnrichmentBudget(token) {
    return token ? CHANGE_SORT_CANDIDATES_AUTH : CHANGE_SORT_CANDIDATES_ANON;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

const pullRequestCache = new TtlCache({ ttlMs: PR_CACHE_TTL_MS, maxEntries: PR_CACHE_MAX_ENTRIES });

/** Clear the warm-instance cache (exposed for deterministic unit tests). */
export function clearPullRequestCache() {
    pullRequestCache.clear();
}

/**
 * Fetch the pull requests authored by `options.username`, using GraphQL when a
 * token is available and the public REST Search API otherwise.
 *
 * Results are cached per `(transport, username, window)` for a short TTL. The
 * window is part of the key because it is pushed down to GitHub as a search
 * qualifier, which keeps every cached page set consistent with its request.
 *
 * @param {{ username: string, token: string, since?: number|null, until?: number|null }} options
 * @returns {Promise<PullRequestRecord[]>}
 * @throws {BadgeUpstreamError} On authentication, rate-limit and API failures.
 */
export async function fetchUserPullRequests({ username, token, since = null, until = null }) {
    const cacheKey = `${token ? 'graphql' : 'rest'}:${username.toLowerCase()}:${since ?? ''}:${until ?? ''}`;
    const cached = pullRequestCache.get(cacheKey);
    if (cached) return cached;

    const records = token
        ? await fetchPullRequestsGraphql({ username, token, since, until })
        : await fetchPullRequestsRest({ username, since, until });

    return pullRequestCache.set(cacheKey, records);
}

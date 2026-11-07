import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import handler from '../api/badge.js';
import { clearPullRequestCache, normalizeGithubToken, resolveGithubToken } from '../lib/github.js';

const originalFetch = globalThis.fetch;
const originalGithubToken = process.env.GITHUB_TOKEN;
const originalGhToken = process.env.GH_TOKEN;

function restoreEnv() {
    for (const [name, value] of [
        ['GITHUB_TOKEN', originalGithubToken],
        ['GH_TOKEN', originalGhToken]
    ]) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...headers }
    });
}

/** Minimal Vercel-like response double that records what the handler emits. */
async function invokeHandler(query = {}, { method = 'GET' } = {}) {
    const headers = {};
    let statusCode = 0;
    let body = '';
    const res = {
        setHeader(name, value) {
            headers[name.toLowerCase()] = value;
        },
        status(code) {
            statusCode = code;
            return this;
        },
        send(payload) {
            body = payload;
            return this;
        }
    };
    await handler({ query, method }, res);
    return { statusCode, headers, body };
}

/** GraphQL node factory with sensible defaults. */
function graphqlNode(overrides = {}) {
    return {
        id: 'PR_1',
        title: 'Fix rendering pipeline',
        url: 'https://github.com/acme/widget/pull/42',
        createdAt: '2026-10-01T12:00:00Z',
        state: 'MERGED',
        mergedAt: '2026-10-02T12:00:00Z',
        repository: {
            url: 'https://github.com/acme/widget',
            stargazerCount: 1500,
            primaryLanguage: { name: 'TypeScript' }
        },
        ...overrides
    };
}

/** Install a fetch double that answers search + diff-statistics queries. */
function mockGraphql(nodes, { diffStats = [], onRequest } = {}) {
    globalThis.fetch = async (url, options = {}) => {
        const payload = options.body ? JSON.parse(options.body) : {};
        onRequest?.({ url: String(url), options, payload });

        if (payload.query?.includes('FetchPullRequestDiffStats')) {
            return jsonResponse({ data: { nodes: diffStats } });
        }
        return jsonResponse({
            data: {
                search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes }
            }
        });
    };
}

describe('normalizeGithubToken', () => {
    it('repairs common hosting-dashboard copy-paste mistakes', () => {
        assert.equal(normalizeGithubToken(undefined), '');
        assert.equal(normalizeGithubToken('   \n\t '), '');
        assert.equal(normalizeGithubToken('""'), '');
        assert.equal(normalizeGithubToken('ghp_cleanToken123'), 'ghp_cleanToken123');
        assert.equal(normalizeGithubToken('  "ghp_quoted123"\n'), 'ghp_quoted123');
        assert.equal(normalizeGithubToken(" 'github_pat_11AAA_bbb' "), 'github_pat_11AAA_bbb');
        assert.equal(normalizeGithubToken('Bearer ghp_prefixed123'), 'ghp_prefixed123');
        assert.equal(normalizeGithubToken('token ghp_prefixed456'), 'ghp_prefixed456');
        assert.equal(normalizeGithubToken('GITHUB_TOKEN="ghp_envLine"'), 'ghp_envLine');
        assert.equal(normalizeGithubToken('GH_TOKEN=github_pat_envLine'), 'github_pat_envLine');
    });

    it('rejects placeholder values that would otherwise become credentials', () => {
        for (const placeholder of ['<your-token>', '${GITHUB_TOKEN}', 'changeme', 'null', 'undefined']) {
            assert.equal(normalizeGithubToken(placeholder), '', placeholder);
        }
    });

    it('prefers GITHUB_TOKEN over GH_TOKEN', () => {
        assert.equal(resolveGithubToken({ GITHUB_TOKEN: 'primary', GH_TOKEN: 'secondary' }), 'primary');
        assert.equal(resolveGithubToken({ GH_TOKEN: 'secondary' }), 'secondary');
        assert.equal(resolveGithubToken({}), '');
    });
});

describe('badge handler', () => {
    beforeEach(() => {
        clearPullRequestCache();
        delete process.env.GITHUB_TOKEN;
        delete process.env.GH_TOKEN;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        restoreEnv();
        clearPullRequestCache();
    });

    it('authenticates with a normalized token and tolerates partial node errors', async () => {
        process.env.GITHUB_TOKEN = '  "Bearer github_pat_testToken123" \n';

        const requests = [];
        globalThis.fetch = async (url, options = {}) => {
            const payload = options.body ? JSON.parse(options.body) : {};
            requests.push({ url: String(url), options, payload });
            if (payload.query?.includes('FetchPullRequestDiffStats')) {
                return jsonResponse({ data: { nodes: [{ id: 'PR_1', additions: 25, deletions: 4 }] } });
            }
            return jsonResponse({
                data: {
                    search: {
                        pageInfo: { hasNextPage: false, endCursor: null },
                        nodes: [null, graphqlNode()]
                    }
                },
                errors: [
                    {
                        type: 'FORBIDDEN',
                        path: ['search', 'nodes', 0],
                        message: 'Resource protected by organization SAML enforcement.'
                    }
                ]
            });
        };

        const result = await invokeHandler({ username: 'OstinUA', show_lang: 'true', show_changes: 'true' });

        assert.equal(requests.length, 2);
        assert.equal(requests[0].options.headers.Authorization, 'Bearer github_pat_testToken123');
        assert.deepEqual(requests[1].payload.variables.ids, ['PR_1']);
        assert.equal(result.statusCode, 200);
        assert.match(result.headers['content-type'], /image\/svg\+xml/);
        assert.match(result.body, /acme\/widget/);
        assert.match(result.body, /1\.5k/);
        assert.match(result.body, /\+25/);
        // The language column renders the Linguist colour for TypeScript.
        assert.match(result.body, /#3178c6/);
    });

    it('reports an invalid token when GitHub answers 401', async () => {
        process.env.GH_TOKEN = 'ghp_expiredToken';
        globalThis.fetch = async () => jsonResponse({ message: 'Bad credentials' }, { status: 401 });

        const result = await invokeHandler({ username: 'OstinUA' });
        assert.equal(result.statusCode, 200);
        assert.match(result.body, /Invalid or expired GITHUB_TOKEN in deployment settings\./);
    });

    it('distinguishes permission failures from rate limits', async () => {
        process.env.GITHUB_TOKEN = 'github_pat_restricted';

        globalThis.fetch = async () =>
            jsonResponse(
                { message: 'Resource not accessible by personal access token' },
                { status: 403, headers: { 'x-ratelimit-remaining': '4999' } }
            );
        assert.match((await invokeHandler({ username: 'OstinUA' })).body, /access forbidden/);

        clearPullRequestCache();
        globalThis.fetch = async () =>
            jsonResponse({ message: 'API rate limit exceeded' }, { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
        assert.match((await invokeHandler({ username: 'OstinUA' })).body, /rate limit exceeded/);
    });

    it('falls back to the unauthenticated REST Search API without a token', async () => {
        const calls = [];
        globalThis.fetch = async (url, options = {}) => {
            const urlString = String(url);
            calls.push({ url: urlString, headers: options.headers ?? {} });

            if (urlString.startsWith('https://api.github.com/search/issues?')) {
                return jsonResponse({
                    total_count: 2,
                    items: [
                        {
                            id: 101,
                            node_id: 'PR_101',
                            title: 'Add docs section',
                            html_url: 'https://github.com/org/low-stars/pull/7',
                            created_at: '2026-11-01T10:00:00Z',
                            state: 'closed',
                            repository_url: 'https://api.github.com/repos/org/low-stars',
                            pull_request: { url: 'https://api.github.com/repos/org/low-stars/pulls/7', merged_at: null }
                        },
                        {
                            id: 102,
                            node_id: 'PR_102',
                            title: 'Optimize core engine',
                            html_url: 'https://github.com/org/high-stars/pull/19',
                            created_at: '2026-11-02T10:00:00Z',
                            state: 'open',
                            repository_url: 'https://api.github.com/repos/org/high-stars',
                            pull_request: { url: 'https://api.github.com/repos/org/high-stars/pulls/19', merged_at: null }
                        }
                    ]
                });
            }
            if (urlString.startsWith('https://api.github.com/search/repositories?')) {
                return jsonResponse({
                    total_count: 2,
                    items: [
                        { full_name: 'org/low-stars', stargazers_count: 12, language: 'Python' },
                        { full_name: 'org/high-stars', stargazers_count: 3400, language: 'Rust' }
                    ]
                });
            }
            if (urlString === 'https://api.github.com/repos/org/high-stars/pulls/19') {
                return jsonResponse({ additions: 120, deletions: 30 });
            }
            throw new Error(`Unexpected URL: ${urlString}`);
        };

        const result = await invokeHandler({
            username: 'OstinUA',
            limit: '1',
            show_lang: 'true',
            show_changes: 'true'
        });

        assert.equal(result.statusCode, 200);
        for (const call of calls) {
            assert.equal(call.headers.Authorization, undefined);
        }
        assert.match(result.body, /org\/high-stars/);
        assert.doesNotMatch(result.body, /org\/low-stars/);
        assert.match(result.body, /Rust/);
        assert.match(result.body, /3\.4k/);
        assert.match(result.body, /\+120/);
        assert.match(result.body, /-30/);
    });

    it('maps REST 422 on an unknown author to a user-not-found notice', async () => {
        globalThis.fetch = async () => jsonResponse({ message: 'Validation Failed' }, { status: 422 });

        const result = await invokeHandler({ username: 'unknown-user-xyz' });
        assert.equal(result.statusCode, 200);
        assert.match(result.body, /User &quot;unknown-user-xyz&quot; not found\./);
    });

    it('renders an empty-state badge when no PR matches the filters', async () => {
        process.env.GITHUB_TOKEN = 'ghp_token';
        mockGraphql([
            graphqlNode({ id: 'PR_2', state: 'CLOSED', mergedAt: null, repository: { url: 'https://github.com/acme/closed', stargazerCount: 5, primaryLanguage: null } })
        ]);

        const result = await invokeHandler({ username: 'OstinUA' });
        assert.equal(result.statusCode, 200);
        assert.match(result.body, /No pull requests match the selected filters\./);
    });

    it('answers OPTIONS pre-flight requests with CORS headers', async () => {
        const result = await invokeHandler({}, { method: 'OPTIONS' });
        assert.equal(result.statusCode, 204);
        assert.equal(result.headers['access-control-allow-origin'], '*');
    });

    it('returns HTTP 400 for an invalid date range in JSON mode', async () => {
        const result = await invokeHandler({ username: 'OstinUA', since: '2026-05-01', until: '2026-01-01', format: 'json' });
        assert.equal(result.statusCode, 400);
        assert.match(JSON.parse(result.body).error.code, /invalid_range/);
    });
});

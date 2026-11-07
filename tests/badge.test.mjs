import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import handler, { clearPrCache, normalizeGithubToken } from '../api/badge.js';

const originalFetch = globalThis.fetch;
const originalGithubToken = process.env.GITHUB_TOKEN;
const originalGhToken = process.env.GH_TOKEN;

function restoreEnv() {
    if (originalGithubToken === undefined) {
        delete process.env.GITHUB_TOKEN;
    } else {
        process.env.GITHUB_TOKEN = originalGithubToken;
    }
    if (originalGhToken === undefined) {
        delete process.env.GH_TOKEN;
    } else {
        process.env.GH_TOKEN = originalGhToken;
    }
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...headers }
    });
}

async function invokeHandler(query = {}) {
    const responseHeaders = {};
    let statusCode = 0;
    let body = '';
    const req = { query };
    const res = {
        setHeader(name, value) {
            responseHeaders[name.toLowerCase()] = value;
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
    await handler(req, res);
    return { statusCode, headers: responseHeaders, body };
}

describe('normalizeGithubToken', () => {
    it('cleans common hosting-dashboard copy-paste mistakes', () => {
        assert.equal(normalizeGithubToken(undefined), '');
        assert.equal(normalizeGithubToken('   \n\t '), '');
        assert.equal(normalizeGithubToken('""'), '');
        assert.equal(normalizeGithubToken('ghp_cleanToken123'), 'ghp_cleanToken123');
        assert.equal(normalizeGithubToken('  "ghp_quoted123"\n'), 'ghp_quoted123');
        assert.equal(normalizeGithubToken(" 'github_pat_11AAA_bbb' "), 'github_pat_11AAA_bbb');
        assert.equal(normalizeGithubToken('Bearer ghp_prefixed123'), 'ghp_prefixed123');
        assert.equal(normalizeGithubToken('token ghp_prefixed456'), 'ghp_prefixed456');
        assert.equal(normalizeGithubToken('"Bearer ghp_both789"'), 'ghp_both789');
        assert.equal(normalizeGithubToken('Bearer "ghp_innerQuote"'), 'ghp_innerQuote');
        assert.equal(normalizeGithubToken('GITHUB_TOKEN="ghp_envLine"'), 'ghp_envLine');
        assert.equal(normalizeGithubToken('GH_TOKEN=github_pat_envLine'), 'github_pat_envLine');
    });
});

describe('badge handler authentication and fallback behavior', () => {
    beforeEach(() => {
        clearPrCache();
        delete process.env.GITHUB_TOKEN;
        delete process.env.GH_TOKEN;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        restoreEnv();
        clearPrCache();
    });

    it('uses Bearer auth with normalized token for GraphQL and tolerates partial node errors', async () => {
        process.env.GITHUB_TOKEN = '  "Bearer github_pat_testToken123" \n';

        const calls = [];
        globalThis.fetch = async (url, options = {}) => {
            calls.push({ url: String(url), options });
            return jsonResponse({
                data: {
                    search: {
                        pageInfo: { hasNextPage: false, endCursor: null },
                        nodes: [
                            null,
                            {
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
                                }
                            }
                        ]
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

        const originalMock = globalThis.fetch;
        globalThis.fetch = async (url, options = {}) => {
            const parsedBody = options.body ? JSON.parse(options.body) : {};
            if (parsedBody.query && parsedBody.query.includes('FetchPrDiffStats')) {
                calls.push({ url: String(url), options, parsedBody });
                return jsonResponse({
                    data: {
                        nodes: [{ id: 'PR_1', additions: 25, deletions: 4 }]
                    }
                });
            }
            return originalMock(url, options);
        };

        const result = await invokeHandler({
            username: 'OstinUA',
            show_lang: 'true',
            show_changes: 'true'
        });

        assert.equal(calls.length, 2);
        assert.equal(calls[0].url, 'https://api.github.com/graphql');
        assert.equal(calls[0].options.headers.Authorization, 'Bearer github_pat_testToken123');
        assert.deepEqual(calls[1].parsedBody.variables.ids, ['PR_1']);
        assert.equal(result.statusCode, 200);
        assert.match(result.body, /acme\/widget/);
        assert.match(result.body, /1\.5k/);
        assert.match(result.body, /\+25/);
    });

    it('surfaces a clear message when GITHUB_TOKEN is rejected with 401', async () => {
        process.env.GH_TOKEN = 'ghp_expiredToken';

        globalThis.fetch = async () => jsonResponse({ message: 'Bad credentials' }, { status: 401 });

        const result = await invokeHandler({ username: 'OstinUA' });
        assert.equal(result.statusCode, 200);
        assert.match(result.body, /Invalid or expired GITHUB_TOKEN in deployment settings\./);
    });

    it('distinguishes 403 permission errors from 403 rate-limit responses', async () => {
        process.env.GITHUB_TOKEN = 'github_pat_restricted';

        globalThis.fetch = async () =>
            jsonResponse(
                { message: 'Resource not accessible by personal access token' },
                { status: 403, headers: { 'x-ratelimit-remaining': '4999' } }
            );

        const forbidden = await invokeHandler({ username: 'OstinUA' });
        assert.match(forbidden.body, /GitHub API access forbidden \(check GITHUB_TOKEN permissions\)\./);

        clearPrCache();
        globalThis.fetch = async () =>
            jsonResponse(
                { message: 'API rate limit exceeded' },
                { status: 403, headers: { 'x-ratelimit-remaining': '0' } }
            );

        const rateLimited = await invokeHandler({ username: 'OstinUA' });
        assert.match(rateLimited.body, /API rate limit exceeded\. Please try again later\./);
    });

    it('falls back to unauthenticated REST Search API when GITHUB_TOKEN is unset', async () => {
        const calls = [];
        globalThis.fetch = async (url, options = {}) => {
            const urlStr = String(url);
            calls.push({ url: urlStr, headers: options.headers || {} });

            if (urlStr.startsWith('https://api.github.com/search/issues?')) {
                return jsonResponse({
                    total_count: 2,
                    items: [
                        {
                            id: 101,
                            node_id: 'PR_101',
                            number: 7,
                            title: 'Add docs section',
                            html_url: 'https://github.com/org/low-stars/pull/7',
                            created_at: '2026-11-01T10:00:00Z',
                            state: 'closed',
                            repository_url: 'https://api.github.com/repos/org/low-stars',
                            pull_request: {
                                url: 'https://api.github.com/repos/org/low-stars/pulls/7',
                                merged_at: '2026-11-01T12:00:00Z'
                            }
                        },
                        {
                            id: 102,
                            node_id: 'PR_102',
                            number: 19,
                            title: 'Optimize core engine',
                            html_url: 'https://github.com/org/high-stars/pull/19',
                            created_at: '2026-11-02T10:00:00Z',
                            state: 'open',
                            repository_url: 'https://api.github.com/repos/org/high-stars',
                            pull_request: {
                                url: 'https://api.github.com/repos/org/high-stars/pulls/19',
                                merged_at: null
                            }
                        }
                    ]
                });
            }

            if (urlStr.startsWith('https://api.github.com/search/repositories?')) {
                return jsonResponse({
                    total_count: 2,
                    items: [
                        { full_name: 'org/low-stars', stargazers_count: 12, language: 'Python' },
                        { full_name: 'org/high-stars', stargazers_count: 3400, language: 'Rust' }
                    ]
                });
            }

            if (urlStr === 'https://api.github.com/repos/org/high-stars/pulls/19') {
                return jsonResponse({ additions: 120, deletions: 30 });
            }

            throw new Error(`Unexpected URL: ${urlStr}`);
        };

        const result = await invokeHandler({
            username: 'OstinUA',
            limit: '1',
            show_lang: 'true',
            show_changes: 'true'
        });

        assert.equal(calls.length, 3);
        for (const call of calls) {
            assert.equal(call.headers.Authorization, undefined);
        }
        assert.equal(result.statusCode, 200);
        assert.match(result.body, /org\/high-stars/);
        assert.doesNotMatch(result.body, /org\/low-stars/);
        assert.match(result.body, /Rust/);
        assert.match(result.body, /3\.4k/);
        assert.match(result.body, /\+120/);
        assert.match(result.body, /-30/);
    });

    it('maps REST 422 on unknown author to User not found', async () => {
        globalThis.fetch = async () => jsonResponse({ message: 'Validation Failed' }, { status: 422 });

        const result = await invokeHandler({ username: 'unknown-user-xyz' });
        assert.equal(result.statusCode, 200);
        assert.match(result.body, /User &quot;unknown-user-xyz&quot; not found\./);
    });
});

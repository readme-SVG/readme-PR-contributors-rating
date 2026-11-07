/**
 * Serverless handler for the pull request badge service.
 *
 * The handler is intentionally thin: it orchestrates the library modules and
 * owns no domain logic of its own.
 *
 *   1. `lib/request.js`  – parse and validate every query parameter.
 *   2. `lib/github.js`   – fetch and normalise pull requests (GraphQL / REST).
 *   3. `lib/ranking.js`  – filter, aggregate, rank, cap and summarise.
 *   4. `lib/renderer.js` – turn the ranked rows into SVG (or JSON) output.
 *   5. `lib/response.js` – negotiate status codes, caching and CORS.
 *
 * Two representations are served from the same URL space:
 *   * `format=svg`  (default) — an embeddable image, always HTTP 200.
 *   * `format=json`            — the machine-readable dataset plus metadata.
 *
 * @see README.md for the full query parameter reference.
 */

import { asOperationalError, BadgeRequestError } from '../lib/errors.js';
import { diffEnrichmentBudget, enrichDiffStatistics, fetchUserPullRequests, resolveGithubToken } from '../lib/github.js';
import { rowChurn, selectPullRequests, summarize } from '../lib/ranking.js';
import { renderBadge, renderNotice } from '../lib/renderer.js';
import { parseOptions, serializeOptions } from '../lib/request.js';
import { sendHead, sendJson, sendNotice, sendPreflight, sendSvg } from '../lib/response.js';

/**
 * Produce the row selection for the response, fetching diff statistics when
 * they influence either the ordering or the rendered output.
 *
 * Sorting by change volume needs the counters *before* ranking, so the most
 * star-worthy candidates are enriched first (bounded by a single batched
 * round-trip). For every other ordering only the rows that will be drawn need
 * statistics, which keeps the upstream cost proportional to `limit`.
 *
 * @param {Array<object>} records Normalised pull request records.
 * @param {object} opts Validated options.
 * @param {{ token: string, needsStatistics: boolean }} context
 * @returns {Promise<{ rows: Array<object>, filtered: Array<object>, summary: object }>}
 */
async function selectRows(records, opts, { token, needsStatistics }) {
    if (opts.sort === 'changes') {
        const candidates = [...records]
            .sort((a, b) => b.repoStars - a.repoStars)
            .slice(0, diffEnrichmentBudget(token));
        await enrichDiffStatistics(candidates, { token });
        return selectPullRequests(records, opts);
    }

    const selection = selectPullRequests(records, opts);
    if (needsStatistics) {
        await enrichDiffStatistics(selection.rows, { token });
        selection.summary = summarize(selection.rows, selection.filtered);
    }
    return selection;
}

/** Build the JSON payload returned for `format=json`. */
function buildPayload({ rows, summary, opts, source }) {
    return {
        username: opts.username,
        source,
        generatedAt: new Date().toISOString(),
        query: serializeOptions(opts),
        summary,
        rows: rows.map((row, index) => ({
            rank: index + 1,
            repository: row.repositoryUrl.replace(/^https?:\/\/[^/]+\//, ''),
            repositoryUrl: row.repositoryUrl,
            title: row.title,
            url: row.url,
            state: row.state,
            createdAt: row.createdAt,
            mergedAt: row.mergedAt,
            stars: row.repoStars,
            language: row.repoLanguage,
            additions: row.additions,
            deletions: row.deletions,
            churn: rowChurn(row),
            pullRequests: row.pullRequestCount ?? 1
        }))
    };
}

/**
 * Emit a notice badge for the given message.
 *
 * Notices are always HTTP 200: GitHub Camo renders a broken image for any
 * non-2xx response, which would be worse than an explanatory badge.
 */
function sendMessage(res, message, opts) {
    sendNotice(res, renderNotice(message, opts));
}

/** Emit an empty dataset in whichever representation the caller requested. */
function sendEmpty(res, { opts, source, message }) {
    if (opts.format === 'json') {
        sendJson(res, {
            username: opts.username,
            source,
            generatedAt: new Date().toISOString(),
            query: serializeOptions(opts),
            summary: null,
            rows: [],
            message
        });
        return;
    }
    sendMessage(res, message, opts);
}

/**
 * Vercel serverless entry point.
 *
 * @param {import('http').IncomingMessage & { query?: Record<string, unknown> }} req
 * @param {import('http').ServerResponse & { status(code: number): any, send(body: string): any }} res
 */
export default async function handler(req, res) {
    if (String(req.method ?? 'GET').toUpperCase() === 'OPTIONS') {
        sendPreflight(res);
        return;
    }

    let opts;
    try {
        opts = parseOptions(req.query ?? {});
    } catch (error) {
        const operational = asOperationalError(error);
        const message = operational?.message ?? 'Invalid request.';
        if (String(req.query?.format ?? '').toLowerCase() === 'json') {
            sendJson(res, { error: { code: operational?.code ?? 'invalid_request', message } }, { status: 400 });
        } else {
            // No validated options exist yet, so fall back to default styling.
            sendNotice(res, renderNotice(message, parseOptions({})));
        }
        return;
    }

    const token = resolveGithubToken();
    const wantsJson = opts.format === 'json';
    const source = token ? 'graphql' : 'rest';

    try {
        const records = await fetchUserPullRequests({
            username: opts.username,
            token,
            since: opts.since,
            until: opts.until
        });

        if (records.length === 0) {
            sendEmpty(res, { opts, source, message: `No pull requests found for "${opts.username}".` });
            return;
        }

        const selection = await selectRows(records, opts, {
            token,
            needsStatistics: opts.showChanges || wantsJson
        });

        if (selection.rows.length === 0) {
            sendEmpty(res, { opts, source, message: 'No pull requests match the selected filters.' });
            return;
        }

        if (wantsJson) {
            sendJson(res, buildPayload({ rows: selection.rows, summary: selection.summary, opts, source }));
            return;
        }

        if (String(req.method ?? 'GET').toUpperCase() === 'HEAD') {
            sendHead(res);
            return;
        }

        sendSvg(res, renderBadge(selection.rows, opts));
    } catch (error) {
        const operational = asOperationalError(error);
        if (operational) {
            const status = operational instanceof BadgeRequestError ? 400 : operational.status ?? 502;
            if (wantsJson) {
                sendJson(res, { error: { code: operational.code, message: operational.message } }, { status });
            } else {
                sendMessage(res, operational.message, opts);
            }
            return;
        }

        // Unexpected failure: log for observability and answer generically.
        console.error('Badge generation failed:', error);
        if (wantsJson) {
            sendJson(res, { error: { code: 'internal_error', message: 'Badge generation failed.' } }, { status: 500 });
        } else {
            sendMessage(res, 'Error generating badge. Please try again.', opts);
        }
    }
}

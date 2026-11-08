/**
 * Pure ranking pipeline: filter → aggregate → sort → cap.
 *
 * Keeping this layer free of I/O makes the badge output fully deterministic
 * for a given record set, which in turn makes it straightforward to unit test.
 */

import { safeNonNegativeInt } from './format.js';

/** Number of distinct pull requests a row represents. */
function rowPullRequestCount(pr) {
    return safeNonNegativeInt(pr.pullRequestCount, 1) || 1;
}

/** Total added lines for a row. */
function rowAdditions(pr) {
    return safeNonNegativeInt(pr.additions, 0);
}

/** Total deleted lines for a row. */
function rowDeletions(pr) {
    return safeNonNegativeInt(pr.deletions, 0);
}

/** Total churn (added + deleted lines) for a row. */
export function rowChurn(pr) {
    return rowAdditions(pr) + rowDeletions(pr);
}

/** Epoch milliseconds of a row's creation date; `0` when unparseable. */
function rowTimestamp(pr) {
    const parsed = Date.parse(pr.createdAt);
    return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Keep merged and open pull requests, plus closed (rejected) ones when the
 * caller opted in. Unparseable records are dropped rather than rendered as
 * empty rows.
 */
export function filterPullRequests(records, opts) {
    return records.filter((pr) => {
        if (!pr || !pr.repositoryUrl) return false;
        if (pr.state === 'merged' || pr.state === 'open') return true;
        return opts.showRejected && pr.state === 'closed';
    });
}

/**
 * Collapse the record set so every repository appears at most once, counting
 * the suppressed siblings in `pullRequestCount`.
 *
 * The representative row is the newest *merged* pull request when the
 * repository has one, because a merged contribution is the stronger signal for
 * a portfolio badge; otherwise the newest pull request overall is used. The
 * rule is deterministic, so identical inputs always yield identical badges.
 *
 * @param {Array<object>} records Filtered records.
 * @returns {Array<object>} One row per repository.
 */
export function aggregateUniqueRepositories(records) {
    const byRepository = new Map();
    for (const pr of records) {
        const key = pr.repositoryUrl.toLowerCase();
        const existing = byRepository.get(key);
        if (!existing) {
            byRepository.set(key, { ...pr, pullRequestCount: 1 });
            continue;
        }

        const existingIsMerged = existing.state === 'merged';
        const candidateIsMerged = pr.state === 'merged';
        const outranksExisting =
            (candidateIsMerged && !existingIsMerged) ||
            (candidateIsMerged === existingIsMerged && rowTimestamp(pr) > rowTimestamp(existing));

        const count = existing.pullRequestCount + 1;
        byRepository.set(key, outranksExisting ? { ...pr, pullRequestCount: count } : { ...existing, pullRequestCount: count });
    }
    return [...byRepository.values()];
}

function compareRows(sort, a, b) {
    switch (sort) {
        case 'date':
            return rowTimestamp(a) - rowTimestamp(b);
        case 'changes':
            return rowChurn(a) - rowChurn(b);
        case 'stars':
        default:
            return safeNonNegativeInt(a.repoStars) - safeNonNegativeInt(b.repoStars);
    }
}

/**
 * Rank rows by the requested metric and direction, with stable tie-breakers
 * (repository stars, then newest PR) so equal metrics never shuffle between
 * identical requests.
 *
 * @param {Array<object>} rows Aggregated rows.
 * @param {{ sort: string, order: 'asc'|'desc' }} opts Ranking options.
 */
export function rankPullRequests(rows, { sort, order }) {
    const direction = order === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
        const primary = compareRows(sort, a, b);
        if (primary !== 0) return primary * direction;
        const stars = safeNonNegativeInt(a.repoStars) - safeNonNegativeInt(b.repoStars);
        if (stars !== 0) return -stars;
        return rowTimestamp(b) - rowTimestamp(a);
    });
}

/**
 * Compute the aggregate activity counters shown in the JSON payload and used
 * by the configurator's summary line.
 *
 * @param {Array<object>} rows Rows that will be rendered.
 * @param {Array<object>} all  Every filtered record (before aggregation).
 */
export function summarize(rows, all) {
    const repositories = new Set(all.map((pr) => pr.repositoryUrl.toLowerCase()));
    return {
        pullRequests: all.reduce((sum, pr) => sum + rowPullRequestCount(pr), 0),
        repositories: repositories.size,
        merged: all.filter((pr) => pr.state === 'merged').length,
        open: all.filter((pr) => pr.state === 'open').length,
        closed: all.filter((pr) => pr.state === 'closed').length,
        stars: rows.reduce((sum, pr) => sum + safeNonNegativeInt(pr.repoStars), 0),
        additions: rows.reduce((sum, pr) => sum + rowAdditions(pr), 0),
        deletions: rows.reduce((sum, pr) => sum + rowDeletions(pr), 0)
    };
}

/**
 * Run the whole pipeline.
 *
 * @param {Array<object>} records Normalised pull request records.
 * @param {object} opts Validated options.
 * @returns {{ rows: Array<object>, filtered: Array<object>, summary: object }}
 */
export function selectPullRequests(records, opts) {
    const filtered = filterPullRequests(records, opts);
    const aggregated = opts.uniqueRepos ? aggregateUniqueRepositories(filtered) : filtered;
    const ranked = rankPullRequests(aggregated, opts).slice(0, opts.limit);
    return { rows: ranked, filtered, summary: summarize(ranked, filtered) };
}

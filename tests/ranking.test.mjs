import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    aggregateUniqueRepositories,
    filterPullRequests,
    rankPullRequests,
    rowChurn,
    selectPullRequests,
    summarize
} from '../lib/ranking.js';

function record(overrides = {}) {
    return {
        id: overrides.id ?? 'PR_1',
        title: 'Improve throughput',
        url: 'https://github.com/acme/widget/pull/1',
        createdAt: '2026-01-01T00:00:00Z',
        state: 'merged',
        mergedAt: '2026-01-02T00:00:00Z',
        repositoryUrl: 'https://github.com/acme/widget',
        repoStars: 100,
        repoLanguage: 'TypeScript',
        additions: 10,
        deletions: 2,
        pullApiUrl: null,
        ...overrides
    };
}

const OPTIONS = { showRejected: false, uniqueRepos: false, sort: 'stars', order: 'desc', limit: 10 };

describe('filterPullRequests', () => {
    it('keeps merged and open records by default', () => {
        const rows = filterPullRequests(
            [record({ state: 'merged' }), record({ state: 'open', mergedAt: null }), record({ state: 'closed', mergedAt: null })],
            OPTIONS
        );
        assert.equal(rows.length, 2);
    });

    it('includes rejected records only when requested', () => {
        const input = [record({ state: 'closed', mergedAt: null })];
        assert.equal(filterPullRequests(input, { ...OPTIONS, showRejected: true }).length, 1);
    });

    it('drops records without a repository URL', () => {
        assert.equal(filterPullRequests([record({ repositoryUrl: '' })], OPTIONS).length, 0);
    });
});

describe('aggregateUniqueRepositories', () => {
    it('keeps one row per repository and counts the suppressed siblings', () => {
        const rows = aggregateUniqueRepositories([
            record({ id: 'A', createdAt: '2026-01-01T00:00:00Z' }),
            record({ id: 'B', createdAt: '2026-02-01T00:00:00Z' }),
            record({ id: 'C', repositoryUrl: 'https://github.com/acme/other', createdAt: '2026-01-15T00:00:00Z' })
        ]);

        assert.equal(rows.length, 2);
        const widget = rows.find((row) => row.repositoryUrl.endsWith('widget'));
        assert.equal(widget.pullRequestCount, 2);
        assert.equal(widget.id, 'B');
    });
});

describe('rankPullRequests', () => {
    const rows = [
        record({ id: 'low', repoStars: 10, createdAt: '2026-03-01T00:00:00Z', additions: 1, deletions: 0 }),
        record({ id: 'high', repoStars: 900, createdAt: '2026-01-01T00:00:00Z', additions: 5, deletions: 5 }),
        record({ id: 'mid', repoStars: 10, createdAt: '2026-02-01T00:00:00Z', additions: 40, deletions: 0 })
    ];

    it('sorts by stars descending by default', () => {
        assert.deepEqual(
            rankPullRequests(rows, { sort: 'stars', order: 'desc' }).map((row) => row.id),
            ['high', 'low', 'mid']
        );
    });

    it('sorts by creation date ascending when requested', () => {
        assert.deepEqual(
            rankPullRequests(rows, { sort: 'date', order: 'asc' }).map((row) => row.id),
            ['high', 'mid', 'low']
        );
    });

    it('sorts by churn, not by additions alone', () => {
        assert.deepEqual(
            rankPullRequests(rows, { sort: 'changes', order: 'desc' }).map((row) => row.id),
            ['mid', 'high', 'low']
        );
    });
});

describe('summarize', () => {
    it('aggregates counts across the filtered dataset', () => {
        const filtered = [
            record({ state: 'merged' }),
            record({ id: 'B', state: 'open', mergedAt: null, repositoryUrl: 'https://github.com/acme/other', repoStars: 50 })
        ];
        const summary = summarize(filtered, filtered);

        assert.equal(summary.pullRequests, 2);
        assert.equal(summary.repositories, 2);
        assert.equal(summary.merged, 1);
        assert.equal(summary.open, 1);
        assert.equal(summary.stars, 150);
        assert.equal(summary.additions, 20);
        assert.equal(summary.deletions, 4);
    });
});

describe('selectPullRequests', () => {
    it('applies filtering, aggregation, ranking and the row cap', () => {
        const records = [
            record({ id: 'A', repoStars: 5 }),
            record({ id: 'B', repoStars: 500, repositoryUrl: 'https://github.com/acme/second' }),
            record({ id: 'C', repoStars: 900, state: 'closed', mergedAt: null, repositoryUrl: 'https://github.com/acme/third' })
        ];

        const selection = selectPullRequests(records, { ...OPTIONS, limit: 1 });
        assert.equal(selection.rows.length, 1);
        assert.equal(selection.rows[0].id, 'B');
        assert.equal(selection.filtered.length, 2);
    });
});

describe('rowChurn', () => {
    it('treats missing statistics as zero', () => {
        assert.equal(rowChurn({ additions: null, deletions: null }), 0);
        assert.equal(rowChurn({ additions: 7, deletions: 3 }), 10);
    });
});

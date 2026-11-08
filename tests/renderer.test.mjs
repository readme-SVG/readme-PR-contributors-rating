import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatCompactNumber, formatDate, truncate, truncateToWidth } from '../lib/format.js';
import { computeColumnLayout, distributePreferredWidths } from '../lib/layout.js';
import { computeBadgeHeight, formatRepoName, renderBadge, renderNotice } from '../lib/renderer.js';
import { parseOptions } from '../lib/request.js';

const OPTIONS = parseOptions({});

function row(overrides = {}) {
    return {
        title: 'Improve throughput',
        url: 'https://github.com/acme/widget/pull/1',
        createdAt: '2026-01-01T00:00:00Z',
        state: 'merged',
        mergedAt: '2026-01-02T00:00:00Z',
        repositoryUrl: 'https://github.com/acme/widget',
        repoStars: 1234,
        repoLanguage: 'TypeScript',
        additions: 10,
        deletions: 2,
        ...overrides
    };
}

describe('format helpers', () => {
    it('escapes every XML metacharacter', () => {
        assert.equal(truncate('<script>&"', 40), '&lt;script&gt;&amp;&quot;');
    });

    it('truncates on code-point boundaries and appends an ellipsis', () => {
        assert.equal(truncate('abcdefgh', 5), 'ab...');
        assert.equal(truncate('abc', 5), 'abc');
        // Astral plane characters must not be split into lone surrogates.
        assert.equal(truncate('🚀🚀🚀🚀🚀', 4), '🚀...');
    });

    it('derives a character budget from the available width', () => {
        assert.equal(truncateToWidth('abcdefghij', 72, 7.2, 4), 'abcdefghij');
        assert.equal(truncateToWidth('abcdefghij', 50, 7.2, 4), 'abc...');
        assert.equal(truncateToWidth('abcdefghij', 0, 7.2, 4), 'a...');
    });

    it('formats star counts compactly', () => {
        assert.equal(formatCompactNumber(999), '999');
        assert.equal(formatCompactNumber(1500), '1.5k');
        assert.equal(formatCompactNumber(1_250_000), '1.3m');
        assert.equal(formatCompactNumber(Number.NaN), '0');
    });

    it('formats dates defensively', () => {
        assert.equal(formatDate('2026-01-01T00:00:00Z'), '2026-01-01');
        assert.equal(formatDate('not-a-date'), '—');
        assert.equal(formatDate(null), '—');
    });
});

describe('distributePreferredWidths', () => {
    it('returns zero widths when no space is available', () => {
        assert.deepEqual(distributePreferredWidths([{ preferredWidth: 10 }], 0, 5), [0]);
        assert.deepEqual(distributePreferredWidths([], 100, 5), []);
    });

    it('hands out preferred widths and gives the slack to the widest column', () => {
        const widths = distributePreferredWidths([{ preferredWidth: 50 }, { preferredWidth: 100 }], 200, 20);
        assert.deepEqual(widths, [50, 150]);
    });

    it('splits evenly when even the minimums do not fit', () => {
        assert.deepEqual(distributePreferredWidths([{ preferredWidth: 80 }, { preferredWidth: 80 }], 60, 50), [30, 30]);
    });

    it('never produces a total wider than the budget', () => {
        const columns = [{ preferredWidth: 400 }, { preferredWidth: 300 }, { preferredWidth: 200 }];
        for (const budget of [10, 90, 150, 400, 899, 900, 1200]) {
            const total = distributePreferredWidths(columns, budget, 50).reduce((sum, width) => sum + width, 0);
            assert.ok(total <= Math.max(budget, 0), `budget ${budget} produced ${total}`);
        }
    });
});

describe('computeColumnLayout', () => {
    it('spans the band with the repository column when no optional column is visible', () => {
        const layout = computeColumnLayout(parseOptions({ show_pr: 'false', show_date: 'false' }));
        assert.ok(layout.columns.repo.width > 500);
        assert.equal(layout.columns.stars.x, OPTIONS.badgeWidth - 20 - OPTIONS.starsWidth);
    });

    it('places optional columns between the repository and stars columns', () => {
        const layout = computeColumnLayout(parseOptions({ show_lang: 'true', show_changes: 'true' }));
        const [pr, date, lang, changes] = layout.ordered;
        assert.deepEqual(
            layout.ordered.map((column) => column.key),
            ['pr', 'date', 'lang', 'changes']
        );
        assert.ok(pr.x > layout.columns.repo.x);
        assert.ok(date.x > pr.x);
        assert.ok(lang.x > date.x);
        assert.ok(changes.x > lang.x);
        assert.ok(changes.x + changes.width <= layout.columns.stars.x);
    });

    it('respects a custom column order', () => {
        const layout = computeColumnLayout(parseOptions({ col_order: 'changes,pr', show_changes: 'true' }));
        assert.deepEqual(
            layout.ordered.map((column) => column.key),
            ['changes', 'pr']
        );
    });

    it('offsets the status icon when rank numbers are enabled', () => {
        const layout = computeColumnLayout(parseOptions({ show_rank: 'true' }));
        assert.equal(layout.xRank, 20);
        assert.equal(layout.xIcon, 46);
    });
});

describe('renderBadge', () => {
    it('produces a well-formed SVG document with the expected dimensions', () => {
        const svg = renderBadge([row(), row({ state: 'open' })], OPTIONS);
        assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
        assert.match(svg, /viewBox="0 0 830 \d+"/);
        assert.match(svg, /acme\/widget/);
        assert.match(svg, /REPOSITORY/);
        assert.match(svg, /1\.2k/);
        assert.equal(computeBadgeHeight(2, OPTIONS), 110 + 2 * 40 - 40 + 14);
    });

    it('escapes hostile PR titles instead of emitting markup', () => {
        const svg = renderBadge([row({ title: '</text><script>alert(1)</script>' })], OPTIONS);
        assert.doesNotMatch(svg, /<script>/);
        assert.match(svg, /&lt;\/text&gt;/);
    });

    it('renders an em dash when diff statistics are unavailable', () => {
        const svg = renderBadge([row({ additions: null, deletions: null })], parseOptions({ show_changes: 'true' }));
        assert.match(svg, /—/);
    });

    it('shows the aggregated PR count for unique-repository rows', () => {
        const svg = renderBadge([row({ pullRequestCount: 3 })], OPTIONS);
        assert.match(svg, /\(\+2\)/);
    });

    it('omits the background and adds a text shadow in transparent mode', () => {
        const svg = renderBadge([row()], parseOptions({ transparent: 'true' }));
        assert.match(svg, /feDropShadow/);
        assert.doesNotMatch(svg, /<rect width="828"/);
    });

    it('renders an empty state instead of an empty table', () => {
        const svg = renderBadge([], OPTIONS);
        assert.match(svg, /No pull requests match the selected filters\./);
        assert.doesNotMatch(svg, /REPOSITORY/);
    });

    it('uses the custom title when one is supplied', () => {
        const svg = renderBadge([row()], parseOptions({ custom_title: 'My contributions' }));
        assert.match(svg, />My contributions</);
    });

    it('maps repository names to the requested format', () => {
        assert.equal(formatRepoName('https://github.com/acme/widget', 'full'), 'acme/widget');
        assert.equal(formatRepoName('https://github.com/acme/widget', 'short'), 'widget');
    });
});

describe('renderNotice', () => {
    it('escapes the message and stays a valid SVG', () => {
        const svg = renderNotice('User "<x>" not found.', OPTIONS);
        assert.match(svg, /^<svg xmlns=/);
        assert.match(svg, /User &quot;&lt;x&gt;&quot; not found\./);
    });
});

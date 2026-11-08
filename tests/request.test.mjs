import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    parseBoolean,
    parseColumnOrder,
    parseIsoDate,
    parseOptions,
    queryParam,
    sanitizeCaption,
    sanitizeHexColor,
    sanitizeUsername,
    serializeOptions
} from '../lib/request.js';
import { BadgeRequestError } from '../lib/errors.js';

describe('queryParam', () => {
    it('collapses arrays, objects and nulls to a scalar or undefined', () => {
        assert.equal(queryParam({ a: 'x' }, 'a'), 'x');
        assert.equal(queryParam({ a: ['first', 'second'] }, 'a'), 'first');
        assert.equal(queryParam({ a: [null, 'second'] }, 'a'), 'second');
        assert.equal(queryParam({ a: null }, 'a'), undefined);
        assert.equal(queryParam({ a: { nested: true } }, 'a'), undefined);
        assert.equal(queryParam({}, 'a'), undefined);
        assert.equal(queryParam(undefined, 'a'), undefined);
    });
});

describe('parseBoolean', () => {
    it('accepts the documented aliases and ignores everything else', () => {
        assert.equal(parseBoolean({ flag: 'true' }, 'flag', false), true);
        assert.equal(parseBoolean({ flag: '1' }, 'flag', false), true);
        assert.equal(parseBoolean({ flag: 'yes' }, 'flag', false), true);
        assert.equal(parseBoolean({ flag: 'FALSE' }, 'flag', true), false);
        assert.equal(parseBoolean({ flag: '0' }, 'flag', true), false);
        assert.equal(parseBoolean({ flag: 'maybe' }, 'flag', true), true);
        assert.equal(parseBoolean({}, 'flag', false), false);
    });
});

describe('sanitization', () => {
    it('restricts usernames to the GitHub login alphabet and 39 characters', () => {
        assert.equal(sanitizeUsername('ostin/<script>'), 'ostinscript');
        assert.equal(sanitizeUsername('a'.repeat(60)).length, 39);
        assert.equal(sanitizeUsername(undefined), '');
    });

    it('strips markup characters from captions and collapses whitespace', () => {
        assert.equal(sanitizeCaption('<b>Top</b>   PRs & more'), 'bTop/b PRs & more');
        assert.equal(sanitizeCaption('x'.repeat(200)).length, 80);
    });

    it('validates hex colours and normalizes their case', () => {
        assert.equal(sanitizeHexColor('#FFF', 'fallback'), 'fff');
        assert.equal(sanitizeHexColor('AABBCC', 'fallback'), 'aabbcc');
        assert.equal(sanitizeHexColor('11223344', 'fallback'), '11223344');
        assert.equal(sanitizeHexColor('javascript:alert(1)', 'fallback'), 'fallback');
        assert.equal(sanitizeHexColor(42, 'fallback'), 'fallback');
    });
});

describe('parseColumnOrder', () => {
    it('deduplicates known keys and keeps the requested order', () => {
        assert.deepEqual(parseColumnOrder('changes,pr,changes,lang'), ['changes', 'pr', 'lang']);
    });

    it('falls back to the default order when nothing valid remains', () => {
        assert.deepEqual(parseColumnOrder('unknown'), ['pr', 'date', 'lang', 'changes']);
        assert.deepEqual(parseColumnOrder(undefined), ['pr', 'date', 'lang', 'changes']);
    });
});

describe('parseIsoDate', () => {
    it('treats an empty value as unset', () => {
        assert.equal(parseIsoDate('', 'since'), null);
        assert.equal(parseIsoDate(undefined, 'since'), null);
    });

    it('parses date-only values as UTC midnight', () => {
        assert.equal(parseIsoDate('2026-03-01', 'since'), Date.parse('2026-03-01T00:00:00Z'));
    });

    it('rejects unparseable values with a request error', () => {
        assert.throws(() => parseIsoDate('yesterday', 'since'), BadgeRequestError);
    });
});

describe('parseOptions', () => {
    it('returns documented defaults for an empty query', () => {
        const opts = parseOptions({});
        assert.equal(opts.username, 'OstinUA');
        assert.equal(opts.limit, 7);
        assert.equal(opts.sort, 'stars');
        assert.equal(opts.order, 'desc');
        assert.equal(opts.format, 'svg');
        assert.equal(opts.theme, 'dark');
        assert.equal(opts.showPr, true);
        assert.equal(opts.showLang, false);
        assert.equal(opts.transparent, false);
        assert.deepEqual(opts.colOrder, ['pr', 'date', 'lang', 'changes']);
        assert.equal(opts.colors.bg, '0d1117');
    });

    it('clamps numeric parameters into their documented ranges', () => {
        assert.equal(parseOptions({ limit: '999' }).limit, 15);
        assert.equal(parseOptions({ limit: '0' }).limit, 1);
        assert.equal(parseOptions({ badge_width: '10' }).badgeWidth, 700);
        assert.equal(parseOptions({ badge_width: 'nonsense' }).badgeWidth, 830);
    });

    it('accepts a theme preset and lets explicit colours override it', () => {
        const opts = parseOptions({ theme: 'light', title_color: 'ABC' });
        assert.equal(opts.theme, 'light');
        assert.equal(opts.colors.bg, 'ffffff');
        assert.equal(opts.colors.title, 'abc');
    });

    it('rejects an inverted date range', () => {
        assert.throws(() => parseOptions({ since: '2026-05-01', until: '2026-01-01' }), (error) => {
            assert.ok(error instanceof BadgeRequestError);
            assert.equal(error.code, 'invalid_range');
            return true;
        });
    });

    it('rejects a username that sanitizes to nothing', () => {
        assert.throws(() => parseOptions({ username: '<>' }), BadgeRequestError);
    });

    it('produces a frozen options object', () => {
        assert.ok(Object.isFrozen(parseOptions({})));
    });
});

describe('serializeOptions', () => {
    it('omits every value equal to its server-side default', () => {
        assert.equal(serializeOptions(parseOptions({})), 'username=OstinUA');
    });

    it('round-trips a customized configuration', () => {
        const query = {
            username: 'octocat',
            limit: '3',
            sort: 'changes',
            order: 'asc',
            show_lang: 'true',
            show_rank: 'true',
            unique_repos: 'true',
            since: '2025-01-01',
            custom_title: 'My PRs',
            badge_width: '900',
            theme: 'light'
        };
        const serialized = serializeOptions(parseOptions(query));
        const roundTripped = parseOptions(Object.fromEntries(new URLSearchParams(serialized)));

        assert.equal(roundTripped.username, 'octocat');
        assert.equal(roundTripped.limit, 3);
        assert.equal(roundTripped.sort, 'changes');
        assert.equal(roundTripped.order, 'asc');
        assert.equal(roundTripped.showLang, true);
        assert.equal(roundTripped.showRank, true);
        assert.equal(roundTripped.uniqueRepos, true);
        assert.equal(roundTripped.customTitle, 'My PRs');
        assert.equal(roundTripped.badgeWidth, 900);
        assert.equal(roundTripped.theme, 'light');
        assert.equal(roundTripped.since, Date.parse('2025-01-01T00:00:00Z'));
    });
});

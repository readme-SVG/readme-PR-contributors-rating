import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TtlCache } from '../lib/cache.js';

/** Deterministic clock so TTL behaviour is testable without sleeps. */
function createClock(start = 0) {
    let now = start;
    return {
        now: () => now,
        advance: (ms) => {
            now += ms;
        }
    };
}

describe('TtlCache', () => {
    it('requires positive bounds', () => {
        assert.throws(() => new TtlCache({ ttlMs: 0, maxEntries: 1 }), RangeError);
        assert.throws(() => new TtlCache({ ttlMs: 1, maxEntries: 0 }), RangeError);
    });

    it('stores and returns values within the TTL', () => {
        const clock = createClock();
        const cache = new TtlCache({ ttlMs: 100, maxEntries: 2, now: clock.now });
        cache.set('a', 1);
        assert.equal(cache.get('a'), 1);
        clock.advance(99);
        assert.equal(cache.get('a'), 1);
    });

    it('evicts entries once they expire', () => {
        const clock = createClock();
        const cache = new TtlCache({ ttlMs: 100, maxEntries: 2, now: clock.now });
        cache.set('a', 1);
        clock.advance(100);
        assert.equal(cache.get('a'), undefined);
        assert.equal(cache.size, 0);
    });

    it('evicts the least recently used entry when full', () => {
        const clock = createClock();
        const cache = new TtlCache({ ttlMs: 1000, maxEntries: 2, now: clock.now });
        cache.set('a', 1);
        cache.set('b', 2);
        // Touch `a` so `b` becomes the least recently used key.
        assert.equal(cache.get('a'), 1);
        cache.set('c', 3);

        assert.equal(cache.get('b'), undefined);
        assert.equal(cache.get('a'), 1);
        assert.equal(cache.get('c'), 3);
    });

    it('can be cleared', () => {
        const cache = new TtlCache({ ttlMs: 100, maxEntries: 2 });
        cache.set('a', 1);
        cache.clear();
        assert.equal(cache.size, 0);
    });
});

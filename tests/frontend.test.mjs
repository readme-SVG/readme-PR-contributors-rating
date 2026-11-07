/**
 * Static integration checks for the browser configurator.
 *
 * These tests guard the contract between the three hand-written frontend
 * artifacts — `index.html`, `assets/app.js` and the locale bundles — which no
 * bundler or type checker validates. Every failure mode here is one that would
 * only surface as a runtime `TypeError` in the browser.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
const appSource = readFileSync(path.join(repoRoot, 'assets', 'app.js'), 'utf8');

/** Elements the controller creates at runtime, so they are absent in markup. */
const DYNAMIC_IDS = new Set(['previewError']);

/** Every `id` attribute declared in the markup. */
const markupIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));

/** Every id the controller looks up, whether literally or via a template. */
function referencedIds() {
    const literal = [...appSource.matchAll(/\$\('([A-Za-z0-9_]+)'\)/g)].map((match) => match[1]);
    const viaGetElementById = [...appSource.matchAll(/getElementById\('([A-Za-z0-9_]+)'\)/g)].map((match) => match[1]);
    // Template lookups such as `$(`${name}Color`)` resolve over a known list.
    const templated = [...appSource.matchAll(/\$\(`\$\{(\w+)\}(\w+)`\)/g)].flatMap((match) => {
        const suffix = match[2];
        return ['bg', 'text', 'title', 'muted', 'star', 'border', 'shadow'].map((name) => `${name}${suffix}`);
    });
    return [...new Set([...literal, ...viaGetElementById, ...templated])];
}

describe('configurator markup', () => {
    it('declares every element the controller queries', () => {
        const missing = referencedIds().filter((id) => !markupIds.has(id) && !DYNAMIC_IDS.has(id));
        assert.deepEqual(missing, [], `index.html is missing elements: ${missing.join(', ')}`);
    });

    it('contains no duplicate ids', () => {
        const all = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
        const duplicates = all.filter((id, index) => all.indexOf(id) !== index);
        assert.deepEqual([...new Set(duplicates)], []);
    });

    it('loads the controller as an external script and keeps no inline logic', () => {
        assert.match(html, /<script src="\.\/assets\/app\.js"><\/script>/);
        assert.doesNotMatch(html, /<script>\s*\(\(\)\s*=>/);
    });

    it('labels every translatable element with a schema key', () => {
        const keys = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1]);
        assert.ok(keys.length > 40, `expected a rich set of translated labels, found ${keys.length}`);
    });

    it('keeps each locale bundle loaded in the markup available to the switcher', () => {
        const scriptSources = [...html.matchAll(/<script src="\.\/i18n\/([^"]+)\.js"><\/script>/g)].map(
            (match) => match[1]
        );
        const options = [...html.matchAll(/<option value="([^"]+)">/g)].map((match) => match[1]);

        assert.ok(scriptSources.includes('en'));
        for (const locale of scriptSources.filter((name) => name !== 'validate')) {
            assert.ok(options.includes(locale), `locale "${locale}" is loaded but not selectable`);
        }
    });
});

describe('controller source', () => {
    it('does not rely on inline event handler attributes', () => {
        assert.doesNotMatch(html, /\son(?:click|change|input|load)="/);
    });

    it('never interpolates untrusted values into innerHTML', () => {
        assert.doesNotMatch(appSource, /\.innerHTML\s*=/);
    });

    it('guards localStorage access behind try/catch for private-mode browsers', () => {
        assert.match(appSource, /try\s*\{[^}]*localStorage\.setItem/s);
    });

    it('declares the same theme presets as the server-side renderer', () => {
        const serverSource = readFileSync(path.join(repoRoot, 'lib', 'constants.js'), 'utf8');
        for (const color of ['0d1117', 'ffffff', '22272e', '0b1320']) {
            assert.ok(serverSource.includes(color), `lib/constants.js lost palette ${color}`);
            assert.ok(appSource.includes(color), `assets/app.js lost palette ${color}`);
        }
    });
});

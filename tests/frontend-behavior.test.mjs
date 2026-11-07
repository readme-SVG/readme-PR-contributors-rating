/**
 * Behavioural tests for the browser configurator.
 *
 * The form state is derived from the real `index.html` markup, so these tests
 * fail when markup and controller drift apart — not just when a unit of logic
 * breaks. Each test boots the controller in the headless harness and drives it
 * through the same interactions a user would perform.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runController } from './helpers/dom-harness.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
const appSource = readFileSync(path.join(repoRoot, 'assets', 'app.js'), 'utf8');

/** Load every locale bundle the page ships, exactly as the browser would. */
function loadLocales() {
    const sandbox = { window: {} };
    const i18nDir = path.join(repoRoot, 'i18n');
    const files = readdirSync(i18nDir).filter((file) => file.endsWith('.js'));
    const loader = new Function('window', files.map((file) => readFileSync(path.join(i18nDir, file), 'utf8')).join('\n'));
    loader(sandbox.window);
    return sandbox.window.__I18N;
}

const locales = loadLocales();

/** Extract the declarative form state from the shipped markup. */
function parseFormState() {
    const state = [];

    for (const match of html.matchAll(/<(input|select|button|textarea)\b([^>]*)>/g)) {
        const [, tagName, attributes] = match;
        const id = /\bid="([^"]+)"/.exec(attributes)?.[1];
        if (!id) continue;
        const type = /\btype="([^"]+)"/.exec(attributes)?.[1] ?? (tagName === 'select' ? 'select' : 'text');
        const value = /\bvalue="([^"]*)"/.exec(attributes)?.[1] ?? '';
        state.push({
            tagName: tagName === 'select' ? 'select' : tagName === 'button' ? 'button' : 'input',
            id,
            type,
            value,
            defaultValue: value,
            min: /\bmin="([^"]*)"/.exec(attributes)?.[1] ?? '',
            max: /\bmax="([^"]*)"/.exec(attributes)?.[1] ?? '',
            checked: /\bchecked\b/.test(attributes)
        });
    }

    // Radio/checkbox inputs are not self-closing; capture their checked state.
    for (const match of html.matchAll(/<input\b([^>]*)>/g)) {
        const id = /\bid="([^"]+)"/.exec(match[1])?.[1];
        const definition = state.find((entry) => entry.id === id);
        if (definition) {
            definition.defaultChecked = /\bchecked\b/.test(match[1]);
            definition.checked = definition.defaultChecked;
        }
    }

    // Selects default to their first option; `applyThemePreset` then normalises.
    for (const selectMatch of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
        const id = /\bid="([^"]+)"/.exec(selectMatch[1])?.[1];
        const options = [...selectMatch[2].matchAll(/<option value="([^"]*)"/g)].map((entry) => entry[1]);
        const definition = state.find((entry) => entry.id === id);
        if (!definition || options.length === 0) continue;
        const selected = /<option value="([^"]*)"[^>]*selected/.exec(selectMatch[2])?.[1];
        definition.value = selected ?? options[0];
        definition.defaultValue = definition.value;
    }

    return state;
}

const formState = parseFormState();

function boot({ hash = '' } = {}) {
    return runController({ source: appSource, locales, formState: parseFormState(), hash });
}

/** Click the primary action and return the badge URL the controller requested. */
function generate(sandbox) {
    sandbox.elements.get('generateBtn').dispatch('click');
    const last = sandbox.fetchCalls.at(-1);
    assert.ok(last, 'the controller did not request a badge');
    return new URL(last.replace(/&_=\d+$/, ''));
}

describe('configurator defaults', () => {
    it('boots and requests nothing until the user acts', () => {
        const sandbox = boot();
        assert.equal(sandbox.fetchCalls.length, 0);
        assert.equal(sandbox.document.documentElement.getAttribute('data-theme'), 'light');
    });

    it('builds a minimal URL for the default configuration', () => {
        const sandbox = boot();
        const url = generate(sandbox);
        assert.equal(url.origin, 'https://badge.test');
        assert.equal(url.pathname, '/api/badge');
        assert.equal(url.searchParams.get('username'), 'OstinUA');
        // Defaults are omitted from the URL to keep the snippet readable.
        assert.equal(url.searchParams.get('limit'), null);
        assert.equal(url.searchParams.get('badge_width'), null);
        assert.equal(url.searchParams.get('show_pr'), 'false'.replace('false', 'true') === '' ? '' : null);
    });
});

describe('configurator interactions', () => {
    it('serializes every deviation from the defaults', () => {
        const sandbox = boot();
        const { elements } = sandbox;

        elements.get('username').value = 'octocat';
        elements.get('limit').value = '3';
        elements.get('sort').value = 'changes';
        elements.get('order').value = 'asc';
        elements.get('showRank').checked = true;
        elements.get('uniqueRepos').checked = true;
        elements.get('customTitle').value = 'My PRs';
        elements.get('bgColor').value = '123456';
        elements.get('since').value = '2025-01-01';
        elements.get('themePreset').value = 'custom';

        // Column visibility is owned by the column list, which is rebuilt on
        // every language switch, so it is toggled through its checkboxes.
        const columnList = elements.get('columnOrderList');
        columnList.children[2].children[0].children[0].checked = true;
        columnList.children[2].children[0].children[0].dispatch('change');

        const params = generate(sandbox).searchParams;
        assert.equal(params.get('username'), 'octocat');
        assert.equal(params.get('limit'), '3');
        assert.equal(params.get('sort'), 'changes');
        assert.equal(params.get('order'), 'asc');
        assert.equal(params.get('show_lang'), 'true');
        assert.equal(params.get('show_rank'), 'true');
        assert.equal(params.get('unique_repos'), 'true');
        assert.equal(params.get('custom_title'), 'My PRs');
        assert.equal(params.get('bg_color'), '123456');
        assert.equal(params.get('since'), '2025-01-01');
    });

    it('clamps numeric inputs into their declared bounds', () => {
        const sandbox = boot();
        sandbox.elements.get('limit').value = '999';
        sandbox.elements.get('badgeWidth').value = '10';
        const params = generate(sandbox).searchParams;
        assert.equal(params.get('limit'), '15');
        assert.equal(params.get('badge_width'), '700');
    });

    it('rejects an inverted date range without touching the network', () => {
        const sandbox = boot();
        sandbox.elements.get('since').value = '2025-06-01';
        sandbox.elements.get('until').value = '2025-01-01';
        sandbox.elements.get('generateBtn').dispatch('click');

        assert.equal(sandbox.fetchCalls.length, 0);
        const error = sandbox.elements
            .get('previewArea')
            .children.find((child) => child.id === 'previewError');
        assert.ok(error, 'an inline validation error was expected');
        assert.match(error.textContent, /earlier/i);
    });

    it('writes a themed snippet and mirrors the configuration into the hash', () => {
        const sandbox = boot();
        sandbox.elements.get('username').value = 'octocat';
        generate(sandbox);

        const snippet = sandbox.elements.get('markdownCode').textContent;
        assert.match(snippet, /^\[!\[Top PRs by octocat\]\(https:\/\/badge\.test\/api\/badge\?username=octocat\)\]/);
        assert.match(sandbox.window.location.hash, /username=octocat/);
    });

    it('switches the snippet format between Markdown, HTML and URL', () => {
        const sandbox = boot();
        generate(sandbox);

        sandbox.elements.get('snippetFormat').value = 'html';
        sandbox.elements.get('snippetFormat').dispatch('change');
        assert.match(sandbox.elements.get('markdownCode').textContent, /^<a href="https:\/\/github\.com\/readme-SVG/);

        sandbox.elements.get('snippetFormat').value = 'url';
        sandbox.elements.get('snippetFormat').dispatch('change');
        assert.match(sandbox.elements.get('markdownCode').textContent, /^https:\/\/badge\.test\/api\/badge\?/);
    });

    it('persists the configuration for the next visit', () => {
        const sandbox = boot();
        sandbox.elements.get('username').value = 'octocat';
        sandbox.elements.get('username').dispatch('change');

        const stored = JSON.parse(sandbox.storage.get('badge-generator:config:v2'));
        assert.equal(stored.username, 'octocat');
    });

    it('restores a configuration shared through the URL hash', () => {
        const sandbox = boot({ hash: '#username=octocat&limit=2&show_lang=true&theme=light' });
        const params = generate(sandbox).searchParams;

        assert.equal(sandbox.elements.get('username').value, 'octocat');
        assert.equal(sandbox.elements.get('limit').value, '2');

        assert.equal(params.get('username'), 'octocat');
        assert.equal(params.get('limit'), '2');
    });

    it('restores the configuration and clears the preview when reset', () => {
        const sandbox = boot();
        sandbox.elements.get('username').value = 'octocat';
        generate(sandbox);
        sandbox.elements.get('resetBtn').dispatch('click');

        assert.equal(sandbox.elements.get('username').value, 'OstinUA');
        assert.equal(sandbox.elements.get('markdownCode').textContent, '-');
        assert.equal(sandbox.elements.get('copyBtn').disabled, true);
    });

    it('reorders columns with the keyboard-accessible order buttons', () => {
        const sandbox = boot();
        const list = sandbox.elements.get('columnOrderList');
        generate(sandbox);

        // The rendered list is rebuilt after every move; the second row's "up"
        // button moves the `date` column ahead of `pr`.
        const upButton = list.children[1].children[1].children[0];
        upButton.dispatch('click');

        const params = generate(sandbox).searchParams;
        assert.equal(params.get('col_order'), 'date,pr,lang,changes');
    });
});

describe('localisation wiring', () => {
    it('translates every data-i18n element for every locale', () => {
        const keys = [...new Set([...html.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1]))];
        for (const [code, dictionary] of Object.entries(locales)) {
            for (const key of keys) {
                assert.ok(dictionary[key], `locale "${code}" lacks "${key}"`);
            }
        }
    });
});

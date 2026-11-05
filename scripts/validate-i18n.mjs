/**
 * Node.js counterpart of the browser-side i18n integrity check.
 *
 * The locale files are plain browser scripts that populate `window.__I18N`,
 * so this validator evaluates them against a minimal `window` stub and then
 * reuses `i18n/validate.js` as the single source of truth for the schema.
 *
 * On top of the browser check it verifies that every `data-i18n` key
 * referenced from `index.html` is part of the required key set, catching
 * markup/translation drift before it ships.
 *
 * Usage: node scripts/validate-i18n.mjs
 * Exits non-zero on the first integrity violation.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const i18nDir = path.join(repoRoot, 'i18n');

// Minimal browser environment for the locale scripts.
globalThis.window = {};

function evaluate(filePath) {
    const source = readFileSync(filePath, 'utf8');
    // The locale files are trusted, first-party code shipped with the repo.
    new Function(source)();
}

// Load the schema and validator first, then every locale except the validator.
evaluate(path.join(i18nDir, 'validate.js'));

const localeFiles = readdirSync(i18nDir)
    .filter((file) => file.endsWith('.js') && file !== 'validate.js')
    .sort();

if (localeFiles.length === 0) {
    console.error('No locale files found in i18n/.');
    process.exit(1);
}

for (const file of localeFiles) {
    evaluate(path.join(i18nDir, file));
}

window.validateI18nIntegrity();

const loadedLocales = Object.keys(window.__I18N);
const requiredKeys = window.__I18N_REQUIRED_KEYS;

// Cross-check the markup: every data-i18n key must be part of the schema.
const html = readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
const markupKeys = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1]);
const unknownMarkupKeys = [...new Set(markupKeys)].filter((key) => !requiredKeys.includes(key));
if (unknownMarkupKeys.length > 0) {
    console.error(`index.html references keys missing from the i18n schema: ${unknownMarkupKeys.join(', ')}`);
    process.exit(1);
}

const unusedKeys = requiredKeys.filter(
    (key) =>
        !markupKeys.includes(key) &&
        !html.includes(`'${key}'`) &&
        !html.includes(`"${key}"`) &&
        !html.includes(`.${key}`)
);
if (unusedKeys.length > 0) {
    console.error(`i18n keys not referenced anywhere in index.html: ${unusedKeys.join(', ')}`);
    process.exit(1);
}

console.log(`i18n OK: ${loadedLocales.length} locales (${loadedLocales.join(', ')}), ${requiredKeys.length} keys each.`);

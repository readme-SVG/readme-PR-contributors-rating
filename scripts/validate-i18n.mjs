/**
 * Node.js counterpart of the browser-side i18n integrity check.
 *
 * The locale bundles are plain browser scripts that populate `window.__I18N`,
 * so this validator evaluates them against a minimal `window` stub and then
 * reuses `i18n/validate.js` as the single source of truth for the schema.
 *
 * On top of the schema check it cross-references the frontend sources
 * (`index.html` plus everything under `assets/`) to catch both directions of
 * drift:
 *   * a `data-i18n` attribute or `t('…')` lookup that has no schema entry;
 *   * a schema entry that no template or script ever references.
 *
 * Usage: node scripts/validate-i18n.mjs
 * Exits non-zero on the first integrity violation.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const i18nDir = path.join(repoRoot, 'i18n');

// Minimal browser environment required by the locale bundles.
globalThis.window = {};

function evaluate(filePath) {
    const source = readFileSync(filePath, 'utf8');
    // First-party, trusted code shipped with the repository.
    new Function(source)();
}

function fail(message) {
    console.error(message);
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Load the schema, then every locale bundle.
// ---------------------------------------------------------------------------

evaluate(path.join(i18nDir, 'validate.js'));

const localeFiles = readdirSync(i18nDir)
    .filter((file) => file.endsWith('.js') && file !== 'validate.js')
    .sort();
if (localeFiles.length === 0) fail('No locale files found in i18n/.');

for (const file of localeFiles) {
    evaluate(path.join(i18nDir, file));
}

try {
    window.validateI18nIntegrity();
} catch (error) {
    fail(error.message);
}

const loadedLocales = Object.keys(window.__I18N);
const requiredKeys = window.__I18N_REQUIRED_KEYS;

// ---------------------------------------------------------------------------
// Cross-check the frontend sources.
// ---------------------------------------------------------------------------

/** Recursively collect every file under `directory`. */
function listFiles(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const fullPath = path.join(directory, entry.name);
        return entry.isDirectory() ? listFiles(fullPath) : [fullPath];
    });
}

const frontendFiles = [
    path.join(repoRoot, 'index.html'),
    ...listFiles(path.join(repoRoot, 'assets')).filter((file) => /\.(?:js|html)$/.test(file))
];
const frontendSource = frontendFiles
    .filter((file) => {
        try {
            return statSync(file).isFile();
        } catch {
            return false;
        }
    })
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');

const markupKeys = [...frontendSource.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1]);
const lookupKeys = [...frontendSource.matchAll(/\bt\(\s*'([^']+)'\s*\)/g)].map((match) => match[1]);
const referenced = new Set([...markupKeys, ...lookupKeys]);

const unknownKeys = [...referenced].filter((key) => !requiredKeys.includes(key));
if (unknownKeys.length > 0) {
    fail(`Frontend references i18n keys missing from the schema: ${unknownKeys.join(', ')}`);
}

// Keys that are only ever produced indirectly, e.g. resolved through a
// lookup table or passed as a string argument to a helper.
const indirectlyResolved = (key) =>
    frontendSource.includes(`'${key}'`) ||
    frontendSource.includes(`"${key}"`) ||
    frontendSource.includes(`.${key}`);

const unusedKeys = requiredKeys.filter((key) => !referenced.has(key) && !indirectlyResolved(key));
if (unusedKeys.length > 0) {
    fail(`i18n keys not referenced by the frontend: ${unusedKeys.join(', ')}`);
}

console.log(
    `i18n OK: ${loadedLocales.length} locales (${loadedLocales.join(', ')}), ${requiredKeys.length} keys each.`
);

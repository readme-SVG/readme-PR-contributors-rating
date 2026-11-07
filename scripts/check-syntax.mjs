/**
 * Syntax gate for every first-party JavaScript file.
 *
 * `node --check <file>` always parses `.js` files as CommonJS, which is wrong
 * for this repository: the API and library modules are ES modules, while the
 * browser assets are classic scripts. This helper therefore selects the right
 * dialect per file — parsing module sources from stdin with
 * `--input-type=module` — and replaces the shell `find` loop that used to live
 * inside the lint workflow, so the check behaves identically on Windows and on
 * CI runners.
 *
 * Usage: node scripts/check-syntax.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET_DIRECTORIES = ['api', 'lib', 'scripts', 'i18n', 'assets', 'tests'];

/** Directories whose scripts are ES modules rather than classic scripts. */
const MODULE_DIRECTORIES = ['api', 'lib', 'scripts', 'tests'];

/** Recursively collect every `.js` / `.mjs` file below `directory`. */
function collectScripts(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) return collectScripts(fullPath);
        return /\.(?:js|mjs)$/.test(entry.name) ? [fullPath] : [];
    });
}

const files = TARGET_DIRECTORIES.flatMap((directory) => {
    try {
        return collectScripts(path.join(repoRoot, directory));
    } catch {
        return [];
    }
}).sort();

/**
 * Decide whether a file must be parsed as an ES module.
 *
 * @param {string} file Absolute path.
 * @returns {boolean} `true` for ES module sources.
 */
function isModule(file) {
    if (file.endsWith('.mjs')) return true;
    const relative = path.relative(repoRoot, file);
    return MODULE_DIRECTORIES.some((directory) => relative.startsWith(`${directory}${path.sep}`));
}

const failures = [];
for (const file of files) {
    const result = isModule(file)
        ? spawnSync(process.execPath, ['--input-type=module', '--check'], { input: readFileSync(file, 'utf8') })
        : spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });

    if (result.status !== 0) {
        failures.push({ file: path.relative(repoRoot, file), stderr: String(result.stderr ?? '') });
    }
}

if (failures.length > 0) {
    for (const failure of failures) {
        console.error(`Syntax error in ${failure.file}:\n${failure.stderr}`);
    }
    console.error(`${failures.length} file(s) failed the syntax check.`);
    process.exit(1);
}

console.log(`Syntax OK: ${files.length} files checked.`);

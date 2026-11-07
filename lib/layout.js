/**
 * Column layout engine.
 *
 * The badge is a single horizontal band of fixed-width columns. The repository
 * column is elastic: it absorbs slack when there is room and shrinks (never
 * below its minimum) when the optional columns would otherwise overflow the
 * requested badge width. Optional columns then share the remaining pixels
 * proportionally to their preferred widths, so any `badge_width` produces a
 * visually balanced result with no rounding drift.
 */

import { COLUMN_LABELS, LAYOUT } from './constants.js';

/** Human-readable captions for each optional column. */
function columnDefinitions(opts) {
    return {
        pr: { key: 'pr', label: COLUMN_LABELS.pr, preferredWidth: opts.prWidth, enabled: opts.showPr },
        date: { key: 'date', label: COLUMN_LABELS.date, preferredWidth: opts.dateWidth, enabled: opts.showDate },
        lang: { key: 'lang', label: COLUMN_LABELS.lang, preferredWidth: opts.langWidth, enabled: opts.showLang },
        changes: {
            key: 'changes',
            label: COLUMN_LABELS.changes,
            preferredWidth: opts.changesWidth,
            enabled: opts.showChanges
        }
    };
}

/**
 * Distribute `remainingWidth` across columns proportionally to their preferred
 * widths, guaranteeing `minWidth` per column whenever possible and consuming
 * every pixel exactly.
 */
export function distributePreferredWidths(columns, remainingWidth, minWidth) {
    if (columns.length === 0) return [];
    if (remainingWidth <= 0) return columns.map(() => 0);

    const sumPreferred = columns.reduce((sum, column) => sum + column.preferredWidth, 0);

    // Everything fits: hand out the preferred widths and give the slack to the
    // widest column so the row still spans the full badge.
    if (sumPreferred <= remainingWidth) {
        const widths = columns.map((column) => column.preferredWidth);
        let widest = 0;
        for (let index = 1; index < columns.length; index += 1) {
            if (columns[index].preferredWidth > columns[widest].preferredWidth) widest = index;
        }
        widths[widest] += remainingWidth - sumPreferred;
        return widths;
    }

    // Not even the minimums fit: split whatever is left as evenly as possible.
    if (remainingWidth <= minWidth * columns.length) {
        const even = Math.floor(remainingWidth / columns.length);
        const widths = columns.map(() => even);
        widths[widths.length - 1] += remainingWidth - even * columns.length;
        return widths;
    }

    // Proportional distribution with a hard per-column minimum, then repair
    // rounding overshoot from the right so the total matches exactly.
    const widths = columns.map((column) =>
        Math.max(minWidth, Math.floor((column.preferredWidth * remainingWidth) / sumPreferred))
    );
    let used = widths.reduce((sum, width) => sum + width, 0);

    while (used > remainingWidth) {
        let shrunk = false;
        for (let index = widths.length - 1; index >= 0 && used > remainingWidth; index -= 1) {
            if (widths[index] > minWidth) {
                widths[index] -= 1;
                used -= 1;
                shrunk = true;
            }
        }
        if (!shrunk) break;
    }
    if (used < remainingWidth) widths[widths.length - 1] += remainingWidth - used;
    return widths;
}

/**
 * Compute the horizontal position and final width of every visible column.
 *
 * @param {object} opts Validated options.
 * @returns {{
 *   columns: Record<string, { key: string, label: string, x: number, width: number }>,
 *   ordered: Array<{ key: string, label: string, x: number, width: number }>,
 *   xIcon: number,
 *   xRank: number|null
 * }}
 */
export function computeColumnLayout(opts) {
    const { badgeWidth, repoWidth, starsWidth, colOrder, showRank } = opts;
    const { leftPad, rightPad, iconWidth, iconGap, colGap, repoMinWidth, columnMinWidth, rankWidth } = LAYOUT;

    const definitions = columnDefinitions(opts);
    const optionalColumns = colOrder.map((key) => definitions[key]).filter((column) => column?.enabled);

    const xRank = showRank ? leftPad : null;
    const xIcon = showRank ? leftPad + rankWidth : leftPad;
    const xRepo = xIcon + iconWidth + iconGap;
    const xStars = badgeWidth - rightPad - starsWidth;

    let repoActualWidth = repoWidth;

    if (optionalColumns.length === 0) {
        // The repository column is the only flexible one; let it span the band.
        repoActualWidth = Math.max(0, xStars - xRepo - colGap);
    } else {
        // One gap after the repository, one between each pair of optional
        // columns, and one before the stars column.
        const totalGaps = (optionalColumns.length + 1) * colGap;
        const fixedWidth = xRepo + repoActualWidth + starsWidth + rightPad + totalGaps;
        let availableForOptional = badgeWidth - fixedWidth;

        if (availableForOptional < 0) {
            // Shrink the repository column first, but never below its minimum.
            const shrink = Math.min(-availableForOptional, Math.max(0, repoActualWidth - repoMinWidth));
            repoActualWidth -= shrink;
            availableForOptional += shrink;
        }

        const widths = distributePreferredWidths(optionalColumns, Math.max(0, availableForOptional), columnMinWidth);
        optionalColumns.forEach((column, index) => {
            column.width = widths[index];
        });
    }

    const columns = {
        repo: { key: 'repo', label: COLUMN_LABELS.repo, x: xRepo, width: repoActualWidth },
        stars: { key: 'stars', label: COLUMN_LABELS.stars, x: xStars, width: starsWidth }
    };

    let cursor = xRepo + repoActualWidth + colGap;
    for (const column of optionalColumns) {
        columns[column.key] = { key: column.key, label: column.label, x: cursor, width: column.width };
        cursor += column.width + colGap;
    }

    return { columns, ordered: optionalColumns.map((column) => columns[column.key]), xIcon, xRank };
}

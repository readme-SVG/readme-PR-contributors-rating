/**
 * SVG rendering.
 *
 * The renderer is a pure function of `(rows, options)`: it performs no I/O and
 * returns a complete, standalone SVG document. Every value that originates
 * from GitHub or from the query string is escaped here — colours and numeric
 * dimensions are already validated upstream — so the produced markup is safe
 * to embed anywhere an image is allowed.
 */

import { DEFAULT_LANGUAGE_COLOR, FONT_STACK, ICONS, LANGUAGE_COLORS, LAYOUT, THEME_PRESETS } from './constants.js';
import { escapeXml, formatCompactNumber, formatDate, truncateToWidth } from './format.js';
import { computeColumnLayout } from './layout.js';
import { rowChurn } from './ranking.js';

const CHANGES_COLOR = { added: '#3fb950', removed: '#f85149' };

/** Resolve the status glyph for a pull request row. */
function getStatusIcon(pr) {
    if (pr.state === 'merged') return ICONS.merged;
    if (pr.state === 'open') return ICONS.open;
    return ICONS.closed;
}

/** Derive the display name of a repository from its HTML URL. */
export function formatRepoName(repositoryUrl, format) {
    const parts = String(repositoryUrl ?? '')
        .split('/')
        .filter(Boolean)
        .slice(-2);
    if (format === 'short') return parts[parts.length - 1] ?? '';
    return parts.join('/');
}

/** Render the badge title. */
function renderTitle(opts, shadowAttr) {
    const text = opts.customTitle ? opts.customTitle : `Top Contributions by ${opts.username}`;
    return `<text x="${LAYOUT.leftPad}" y="${LAYOUT.titleY}" font-family="${FONT_STACK}" font-size="18" font-weight="bold" fill="#${opts.colors.title}"${shadowAttr}>${escapeXml(text)}</text>`;
}

/** Render the uppercase header row and, for solid badges, its divider line. */
function renderHeader(layout, opts, shadowAttr) {
    const headerColumns = [layout.columns.repo, ...layout.ordered, layout.columns.stars];
    const labels = headerColumns
        .filter((column) => column && column.width > 0)
        .map(
            (column) =>
                `<text x="${column.x}" y="${LAYOUT.headerY}" font-family="${FONT_STACK}" font-size="12" font-weight="bold" fill="#${opts.colors.muted}"${shadowAttr}>${escapeXml(column.label)}</text>`
        )
        .join('');

    const line = opts.transparent
        ? ''
        : `<line x1="${LAYOUT.leftPad}" y1="${LAYOUT.headerLineY}" x2="${opts.badgeWidth - LAYOUT.rightPad}" y2="${LAYOUT.headerLineY}" stroke="#${opts.colors.border}" stroke-width="1"/>`;

    return labels + line;
}

/** Render the optional rank cell (1-based). */
function renderRank(rank, layout, opts, shadowAttr) {
    if (layout.xRank === null) return '';
    return `<text x="${layout.xRank}" y="0" font-family="${FONT_STACK}" font-size="13" font-weight="600" fill="#${opts.colors.muted}"${shadowAttr}>#${rank}</text>`;
}

/** Render the star cell; `compact` keeps the column readable when narrow. */
function renderStars(pr, layout, opts, shadowAttr) {
    const column = layout.columns.stars;
    if (column.width <= 0) return '';
    const text = truncateToWidth(
        formatCompactNumber(pr.repoStars),
        Math.max(10, column.width - 20),
        7,
        2
    );
    return (
        `<svg x="${column.x}" y="-12" width="16" height="16" viewBox="0 0 16 16" fill="#${opts.colors.star}"><path fill-rule="evenodd" d="${ICONS.star.path}"></path></svg>` +
        `<text x="${column.x + 20}" y="0" font-family="${FONT_STACK}" font-size="13" font-weight="bold" fill="#${opts.colors.star}"${shadowAttr}>${text}</text>`
    );
}

/** Render the language cell with its Linguist colour dot. */
function renderLanguage(pr, layout, opts, shadowAttr) {
    const column = layout.columns.lang;
    if (!column || column.width <= 0) return '';
    const language = pr.repoLanguage || 'Unknown';
    const dotColor = LANGUAGE_COLORS[pr.repoLanguage] ?? DEFAULT_LANGUAGE_COLOR;
    const text = truncateToWidth(language, Math.max(12, column.width - 16), 7, 4);
    return (
        `<circle cx="${column.x + 5}" cy="-4" r="5" fill="${dotColor}"/>` +
        `<text x="${column.x + 14}" y="0" font-family="${FONT_STACK}" font-size="13" fill="#${opts.colors.text}"${shadowAttr}>${text}</text>`
    );
}

/**
 * Render the change-volume cell as `+added / -removed`.
 *
 * When the diff statistics could not be retrieved the cell shows an em dash
 * instead of a misleading `+0 / -0`.
 */
function renderChanges(pr, layout, opts, shadowAttr) {
    const column = layout.columns.changes;
    if (!column || column.width <= 0) return '';

    const known = Number.isFinite(pr.additions) && Number.isFinite(pr.deletions);
    if (!known) {
        return `<text x="${column.x}" y="0" font-family="${FONT_STACK}" font-size="13" fill="#${opts.colors.muted}"${shadowAttr}>—</text>`;
    }

    const added = `+${pr.additions}`;
    const removed = `-${pr.deletions}`;
    const compact = (added.length + removed.length + 3) * 7.2 > Math.max(0, column.width - 2);
    const separator = compact ? '/' : ' / ';
    return (
        `<text x="${column.x}" y="0" font-family="${FONT_STACK}" font-size="13"${shadowAttr}>` +
        `<title>${escapeXml(`${rowChurn(pr)} lines changed`)}</title>` +
        `<tspan fill="${CHANGES_COLOR.added}">${escapeXml(added)}</tspan>` +
        `<tspan fill="#${opts.colors.muted}">${escapeXml(separator)}</tspan>` +
        `<tspan fill="${CHANGES_COLOR.removed}">${escapeXml(removed)}</tspan></text>`
    );
}

/** Render a single pull request row. */
function renderRow(pr, index, layout, opts, shadowAttr) {
    const { columns, xIcon } = layout;
    const mutedColor = `#${opts.colors.muted}`;
    const yOffset = LAYOUT.firstRowY + index * opts.rowHeight;
    const icon = getStatusIcon(pr);
    const parts = [`<g transform="translate(0, ${yOffset})">`];

    parts.push(renderRank(index + 1, layout, opts, shadowAttr));
    parts.push(
        `<svg x="${xIcon}" y="-12" width="16" height="16" viewBox="0 0 16 16" fill="${icon.color}"><path fill-rule="evenodd" d="${icon.path}"></path></svg>`
    );

    if (columns.repo.width > 0) {
        const repoName = formatRepoName(pr.repositoryUrl, opts.repoNameFormat);
        const repoText = truncateToWidth(repoName, columns.repo.width - 6, 7.2, 6);
        parts.push(
            `<text x="${columns.repo.x}" y="0" font-family="${FONT_STACK}" font-size="14" font-weight="600" fill="#${opts.colors.text}"${shadowAttr}>${repoText}</text>`
        );
    }

    if (columns.pr && columns.pr.width > 0) {
        // Aggregated rows advertise how many PRs they stand for.
        const extra = pr.pullRequestCount > 1 ? `  (+${pr.pullRequestCount - 1})` : '';
        const titleText = truncateToWidth(`${pr.title}${extra}`, columns.pr.width - 6, 7.2, 8);
        parts.push(
            `<text x="${columns.pr.x}" y="0" font-family="${FONT_STACK}" font-size="14" fill="${mutedColor}"${shadowAttr}>${titleText}</text>`
        );
    }

    if (columns.date && columns.date.width > 0) {
        const dateText = truncateToWidth(formatDate(pr.createdAt), columns.date.width - 4, 7, 10);
        parts.push(
            `<text x="${columns.date.x}" y="0" font-family="${FONT_STACK}" font-size="13" fill="${mutedColor}"${shadowAttr}>${dateText}</text>`
        );
    }

    parts.push(renderLanguage(pr, layout, opts, shadowAttr));
    parts.push(renderChanges(pr, layout, opts, shadowAttr));
    parts.push(renderStars(pr, layout, opts, shadowAttr));
    parts.push('</g>');
    return parts.join('');
}

/** Vertical size of a badge with `rowCount` rows. */
export function computeBadgeHeight(rowCount, opts) {
    const body = Math.max(rowCount, 1) * opts.rowHeight;
    return LAYOUT.firstRowY + body - opts.rowHeight + 14;
}

/**
 * Assemble the complete SVG document.
 *
 * @param {Array<object>} rows Rows to render (already filtered, ranked, capped).
 * @param {object} opts Validated request options.
 * @returns {string} A standalone SVG document.
 */
export function renderBadge(rows, opts) {
    const layout = computeColumnLayout(opts);
    const svgHeight = computeBadgeHeight(rows.length, opts);
    const shadowAttr = opts.transparent ? ' filter="url(#textShadow)"' : '';

    const defs = opts.transparent
        ? `<defs><filter id="textShadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="0" stdDeviation="1" flood-color="#${opts.colors.shadow}" flood-opacity="1"/></filter></defs>`
        : '';
    const background = opts.transparent
        ? ''
        : `<rect width="${opts.badgeWidth - 2}" height="${svgHeight - 2}" x="1" y="1" rx="8" fill="#${opts.colors.bg}" stroke="#${opts.colors.border}" stroke-width="1"/>`;

    const body =
        rows.length > 0
            ? rows.map((pr, index) => renderRow(pr, index, layout, opts, shadowAttr)).join('')
            : renderEmptyState(opts, shadowAttr);

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${opts.badgeWidth}" height="${svgHeight}" viewBox="0 0 ${opts.badgeWidth} ${svgHeight}" role="img" aria-label="${escapeXml(describeBadge(rows, opts))}">
  ${defs}
  ${background}
  ${renderTitle(opts, shadowAttr)}
  ${rows.length > 0 ? renderHeader(layout, opts, shadowAttr) : ''}
  ${body}
</svg>`;
}

/** Accessible description of the rendered badge. */
function describeBadge(rows, opts) {
    return opts.customTitle || `Top ${rows.length} pull requests by ${opts.username}`;
}

/** Friendly notice rendered when no pull request matches the filters. */
function renderEmptyState(opts, shadowAttr) {
    return `<text x="${LAYOUT.leftPad}" y="${LAYOUT.firstRowY}" font-family="${FONT_STACK}" font-size="14" fill="#${opts.colors.muted}"${shadowAttr}>No pull requests match the selected filters.</text>`;
}

/**
 * Render a compact notice badge (error, informational). Errors are still
 * served as `image/svg+xml` so README embeds degrade gracefully instead of
 * showing a broken-image placeholder.
 */
export function renderNotice(message, opts) {
    const height = 60;
    const background = opts.transparent
        ? ''
        : `<rect width="498" height="${height - 2}" x="1" y="1" rx="8" fill="#${opts.colors.bg}" stroke="#${opts.colors.border}" stroke-width="1"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="${height}" viewBox="0 0 500 ${height}" role="img">
  ${background}
  <text x="20" y="35" font-family="${FONT_STACK}" font-size="14" fill="#f85149">${escapeXml(message)}</text>
</svg>`;
}

/** Exported for tests: exposes the theme palette resolution used by SVG. */
export function paletteFor(theme) {
    return THEME_PRESETS[theme]?.colors ?? THEME_PRESETS.dark.colors;
}

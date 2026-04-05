export default async function handler(req, res) {
    const username = sanitizeUsername(req.query.username || 'OstinUA');
    const limit = clamp(parseInt(req.query.limit, 10) || 7, 1, 15);
    const showPr = req.query.show_pr !== 'false';
    const showDate = req.query.show_date !== 'false';
    const showRepo = req.query.show_repo !== 'false';
    const showLang = req.query.show_lang === 'true';
    const showChanges = req.query.show_changes === 'true';
    const showStars = req.query.show_stars !== 'false';

    const badgeWidth = clamp(parseInt(req.query.badge_width, 10) || 830, 700, 1400);
    const rowHeight = clamp(parseInt(req.query.row_height, 10) || 40, 30, 60);
    const repoWidth = clamp(parseInt(req.query.repo_width, 10) || 180, 60, 500);
    const langWidth = clamp(parseInt(req.query.lang_width, 10) || 80, 60, 300);
    const prWidth = clamp(parseInt(req.query.pr_width, 10) || 320, 100, 900);
    const dateWidth = clamp(parseInt(req.query.date_width, 10) || 90, 60, 300);
    const changesWidth = clamp(parseInt(req.query.changes_width, 10) || 100, 70, 300);
    const starsWidth = clamp(parseInt(req.query.stars_width, 10) || 60, 50, 240);

    const customTitle = req.query.custom_title ? sanitizeText(req.query.custom_title, 80) : '';

    const bgColor = sanitizeHex(req.query.bg_color, '0d1117');
    const textColor = sanitizeHex(req.query.text_color, 'c9d1d9');
    const titleColor = sanitizeHex(req.query.title_color, '58a6ff');
    const mutedColor = sanitizeHex(req.query.muted_color, '8b949e');
    const starColor = sanitizeHex(req.query.star_color, 'e3b341');
    const borderColor = sanitizeHex(req.query.border_color, '30363d');
    const shadowColor = sanitizeHex(req.query.shadow_color, '000000');
    const transparent = req.query.transparent === 'true';

    const token = process.env.GITHUB_TOKEN;
    const headers = token
        ? { Authorization: `token ${token}`, 'User-Agent': 'readme-pr-badge' }
        : { 'User-Agent': 'readme-pr-badge' };

    try {
        const prsResponse = await fetch(
            `https://api.github.com/search/issues?q=is:pr+author:${username}&sort=created&order=desc&per_page=30`,
            { headers }
        );

        if (prsResponse.status === 403 || prsResponse.status === 429) {
            return sendErrorSvg(res, 'API rate limit exceeded. Please try again later.', bgColor, borderColor);
        }

        if (prsResponse.status === 422) {
            return sendErrorSvg(res, `User "${escapeXml(username)}" not found.`, bgColor, borderColor);
        }

        if (!prsResponse.ok) {
            return sendErrorSvg(res, `GitHub API error (${prsResponse.status}).`, bgColor, borderColor);
        }

        const prsData = await prsResponse.json();
        let prs = prsData.items || [];

        if (prs.length === 0) {
            return sendErrorSvg(res, `No Pull Requests found for "${escapeXml(username)}".`, bgColor, borderColor);
        }

        const uniqueRepoUrls = [...new Set(prs.map(pr => pr.repository_url))].slice(0, 20);
        const repoStats = {};

        const repoResults = await Promise.allSettled(
            uniqueRepoUrls.map(async (url) => {
                const repoRes = await fetch(url, { headers });
                if (!repoRes.ok) return { url, stars: 0, language: null };
                const repoData = await repoRes.json();
                return { url, stars: repoData.stargazers_count || 0, language: repoData.language || null };
            })
        );

        for (const result of repoResults) {
            if (result.status === 'fulfilled') {
                repoStats[result.value.url] = {
                    stars: result.value.stars,
                    language: result.value.language
                };
            }
        }

        let enrichedPrs = prs.map(pr => ({
            ...pr,
            repoStars: (repoStats[pr.repository_url] || {}).stars || 0,
            repoLanguage: (repoStats[pr.repository_url] || {}).language || null
        }));

        enrichedPrs.sort((a, b) => b.repoStars - a.repoStars);

        const sortedPrs = enrichedPrs.slice(0, limit);

        if (showChanges) {
            const prDetailResults = await Promise.allSettled(
                sortedPrs.map(async (pr) => {
                    const prApiUrl = pr.pull_request && pr.pull_request.url;
                    if (!prApiUrl) return { id: pr.id, additions: 0, deletions: 0 };
                    try {
                        const prRes = await fetch(prApiUrl, { headers });
                        if (!prRes.ok) return { id: pr.id, additions: 0, deletions: 0 };
                        const prData = await prRes.json();
                        return { id: pr.id, additions: prData.additions || 0, deletions: prData.deletions || 0 };
                    } catch {
                        return { id: pr.id, additions: 0, deletions: 0 };
                    }
                })
            );

            const detailMap = {};
            for (const result of prDetailResults) {
                if (result.status === 'fulfilled') {
                    detailMap[result.value.id] = result.value;
                }
            }

            for (const pr of sortedPrs) {
                const detail = detailMap[pr.id] || {};
                pr.additions = detail.additions || 0;
                pr.deletions = detail.deletions || 0;
            }
        }

        const svg = buildSvg(sortedPrs, username, {
            showPr,
            showDate,
            showRepo,
            showLang,
            showChanges,
            showStars,
            badgeWidth,
            rowHeight,
            repoWidth,
            langWidth,
            prWidth,
            dateWidth,
            changesWidth,
            starsWidth,
            bgColor,
            textColor,
            titleColor,
            mutedColor,
            starColor,
            borderColor,
            shadowColor,
            transparent,
            customTitle
        });

        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 's-maxage=43200, stale-while-revalidate');
        res.status(200).send(svg);
    } catch (error) {
        console.error(error);
        sendErrorSvg(res, 'Error generating badge. Please try again.', bgColor, borderColor);
    }
}

const LANG_COLORS = {
    'JavaScript': '#f1e05a',
    'TypeScript': '#3178c6',
    'Python': '#3572A5',
    'Java': '#b07219',
    'Go': '#00ADD8',
    'Rust': '#dea584',
    'C': '#555555',
    'C++': '#f34b7d',
    'C#': '#178600',
    'Ruby': '#701516',
    'PHP': '#4F5D95',
    'Swift': '#F05138',
    'Kotlin': '#A97BFF',
    'Dart': '#00B4AB',
    'Scala': '#c22d40',
    'Shell': '#89e051',
    'Lua': '#000080',
    'HTML': '#e34c26',
    'CSS': '#563d7c',
    'Vue': '#41b883',
    'Svelte': '#ff3e00',
    'Elixir': '#6e4a7e',
    'Haskell': '#5e5086',
    'R': '#198CE7',
    'Objective-C': '#438eff',
    'Perl': '#0298c3',
    'Zig': '#ec915c'
};

function sanitizeUsername(input) {
    return input.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 39);
}

function sanitizeText(input, maxLen) {
    return String(input).replace(/[^\w\s\-.,!?()@#&:;'/]/g, '').slice(0, maxLen);
}

function sanitizeHex(input, fallback) {
    if (!input) return fallback;
    const cleaned = input.replace(/^#/, '').replace(/[^a-fA-F0-9]/g, '');
    return /^[a-fA-F0-9]{3,8}$/.test(cleaned) ? cleaned : fallback;
}

function clamp(value, min, max) {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
}

function escapeXml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function truncate(str, length) {
    const safe = escapeXml(str);
    return safe.length > length ? safe.substring(0, length - 3) + '...' : safe;
}

function truncateToWidth(str, widthPx, pxPerChar = 7.2, minLen = 4) {
    const maxLen = Math.max(minLen, Math.floor(widthPx / pxPerChar));
    return truncate(str, maxLen);
}

function formatStars(stars) {
    return stars >= 1000 ? (stars / 1000).toFixed(1) + 'k' : String(stars);
}

function getStatusIcon(pr) {
    if (pr.pull_request && pr.pull_request.merged_at) {
        return {
            color: '#a371f7',
            path: 'M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z'
        };
    }
    if (pr.state === 'open') {
        return {
            color: '#3fb950',
            path: 'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.25 2.25 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854v4.792a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm.75-2.25a2.25 2.25 0 1 1 0 4.5 2.25 2.25 0 0 1 0-4.5Z'
        };
    }
    return {
        color: '#f85149',
        path: 'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.25 2.25 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854v4.792a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z'
    };
}

function buildSvg(prs, username, opts) {
    const {
        showPr,
        showDate,
        showRepo,
        showLang,
        showChanges,
        showStars,
        badgeWidth,
        rowHeight,
        repoWidth,
        langWidth,
        prWidth,
        dateWidth,
        changesWidth,
        starsWidth,
        bgColor,
        textColor,
        titleColor,
        mutedColor,
        starColor,
        borderColor,
        shadowColor,
        transparent,
        customTitle
    } = opts;

    const font = 'Segoe UI, Helvetica, Arial, sans-serif';
    const safeUser = escapeXml(username);
    const headerText = customTitle ? escapeXml(customTitle) : `Top Contributions by ${safeUser}`;
    const innerLeft = 20;
    const innerRight = badgeWidth - 20;
    const colGap = 16;
    const textShadowStyle = transparent ? `filter="url(#textShadow)"` : '';

    const columns = [];
    if (showRepo) columns.push({ key: 'repo', label: 'REPOSITORY', width: repoWidth });
    if (showLang) columns.push({ key: 'lang', label: 'LANGUAGE', width: langWidth });
    if (showPr) columns.push({ key: 'pr', label: 'PULL REQUEST', width: prWidth });
    if (showDate) columns.push({ key: 'date', label: 'DATE', width: dateWidth });
    if (showChanges) columns.push({ key: 'changes', label: 'CHANGES', width: changesWidth });
    if (showStars) columns.push({ key: 'stars', label: 'STARS', width: starsWidth });

    const iconX = innerLeft;
    let currentX = iconX + 24;
    const columnMap = {};

    for (const col of columns) {
        const remaining = innerRight - currentX;
        if (remaining <= 12) break;
        const allocated = Math.max(12, Math.min(col.width, remaining));
        columnMap[col.key] = {
            x: currentX,
            width: allocated,
            label: col.label
        };
        currentX += allocated + colGap;
    }

    let headerHtml = '';
    for (const col of columns) {
        const cfg = columnMap[col.key];
        if (!cfg) continue;
        headerHtml += `<text x="${cfg.x}" y="75" font-family="${font}" font-size="12" font-weight="bold" fill="#${mutedColor}" ${textShadowStyle}>${cfg.label}</text>`;
    }

    let rowsHtml = '';
    prs.forEach((pr, index) => {
        const yOffset = 110 + index * rowHeight;
        const icon = getStatusIcon(pr);
        const repoName = pr.repository_url.split('/').slice(-2).join('/');
        const date = new Date(pr.created_at).toISOString().split('T')[0];
        const starsText = formatStars(pr.repoStars);
        const langText = pr.repoLanguage || 'Unknown';

        rowsHtml += `<g transform="translate(0, ${yOffset})">`;
        rowsHtml += `<svg x="${iconX}" y="-12" width="16" height="16" viewBox="0 0 16 16" fill="${icon.color}"><path fill-rule="evenodd" d="${icon.path}"></path></svg>`;

        const repoCol = columnMap.repo;
        if (repoCol) {
            const repoText = truncateToWidth(repoName, repoCol.width - 6, 7.2, 6);
            rowsHtml += `<text x="${repoCol.x}" y="0" font-family="${font}" font-size="14" font-weight="600" fill="#${textColor}" ${textShadowStyle}>${repoText}</text>`;
        }

        const langCol = columnMap.lang;
        if (langCol) {
            const langColor = LANG_COLORS[pr.repoLanguage] || '#8b949e';
            const langTextX = langCol.x + 14;
            const langMaxTextWidth = Math.max(12, langCol.width - 16);
            const langDisplay = truncateToWidth(langText, langMaxTextWidth, 7, 4);
            rowsHtml += `<circle cx="${langCol.x + 5}" cy="-4" r="5" fill="${langColor}"/>`;
            rowsHtml += `<text x="${langTextX}" y="0" font-family="${font}" font-size="13" fill="#${textColor}" ${textShadowStyle}>${langDisplay}</text>`;
        }

        const prCol = columnMap.pr;
        if (prCol) {
            const prTitle = truncateToWidth(pr.title, prCol.width - 6, 7.2, 8);
            rowsHtml += `<text x="${prCol.x}" y="0" font-family="${font}" font-size="14" fill="#${mutedColor}" ${textShadowStyle}>${prTitle}</text>`;
        }

        const dateCol = columnMap.date;
        if (dateCol) {
            const dateText = truncateToWidth(date, dateCol.width - 6, 7, 8);
            rowsHtml += `<text x="${dateCol.x}" y="0" font-family="${font}" font-size="13" fill="#${mutedColor}" ${textShadowStyle}>${dateText}</text>`;
        }

        const changesCol = columnMap.changes;
        if (changesCol) {
            const additions = pr.additions || 0;
            const deletions = pr.deletions || 0;
            const pairText = `+${additions} / -${deletions}`;
            const changesText = truncateToWidth(pairText, changesCol.width - 6, 7, 7);
            rowsHtml += `<text x="${changesCol.x}" y="0" font-family="${font}" font-size="13" fill="#3fb950" ${textShadowStyle}>${changesText}</text>`;
        }

        const starsCol = columnMap.stars;
        if (starsCol) {
            const starTextX = starsCol.x + 20;
            const starTextWidth = Math.max(10, starsCol.width - 20);
            const starValue = truncateToWidth(starsText, starTextWidth, 7, 2);
            rowsHtml += `<svg x="${starsCol.x}" y="-12" width="16" height="16" viewBox="0 0 16 16" fill="#${starColor}"><path fill-rule="evenodd" d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z"></path></svg>`;
            rowsHtml += `<text x="${starTextX}" y="0" font-family="${font}" font-size="13" font-weight="bold" fill="#${starColor}" ${textShadowStyle}>${starValue}</text>`;
        }

        rowsHtml += `</g>`;
    });

    const svgHeight = 95 + prs.length * rowHeight;

    const backgroundRect = transparent
        ? ''
        : `<rect width="${badgeWidth - 2}" height="${svgHeight - 2}" x="1" y="1" rx="8" fill="#${bgColor}" stroke="#${borderColor}" stroke-width="1"/>`;
    const headerLine = transparent
        ? ''
        : `<line x1="20" y1="85" x2="${badgeWidth - 20}" y2="85" stroke="#${borderColor}" stroke-width="1"/>`;
    const shadowDefs = transparent
        ? `<defs><filter id="textShadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="0" stdDeviation="1" flood-color="#${shadowColor}" flood-opacity="1"/></filter></defs>`
        : '';

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${badgeWidth}" height="${svgHeight}" viewBox="0 0 ${badgeWidth} ${svgHeight}">
  ${shadowDefs}
  ${backgroundRect}
  <text x="20" y="35" font-family="${font}" font-size="18" font-weight="bold" fill="#${titleColor}" ${textShadowStyle}>${headerText}</text>
  ${headerHtml}
  ${headerLine}
  ${rowsHtml}
</svg>`;
}

function sendErrorSvg(res, message, bgColor, borderColor) {
    const font = 'Segoe UI, Helvetica, Arial, sans-serif';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="60" viewBox="0 0 500 60">
  <rect width="498" height="58" x="1" y="1" rx="8" fill="#${bgColor}" stroke="#${borderColor}" stroke-width="1"/>
  <text x="20" y="35" font-family="${font}" font-size="14" fill="#f85149">${escapeXml(message)}</text>
</svg>`;
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    res.status(200).send(svg);
}

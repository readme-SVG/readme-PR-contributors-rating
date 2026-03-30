export default async function handler(req, res) {
    const username = sanitizeUsername(req.query.username || 'OstinUA');
    const limit = clamp(parseInt(req.query.limit, 10) || 7, 1, 15);
    const showPr = req.query.show_pr !== 'false';
    const showDate = req.query.show_date !== 'false';
    const showRepo = req.query.show_repo !== 'false';
    const badgeWidth = clamp(parseInt(req.query.badge_width, 10) || 830, 700, 1400);
    const rowHeight = clamp(parseInt(req.query.row_height, 10) || 40, 30, 60);

    const bgColor = sanitizeHex(req.query.bg_color, '0d1117');
    const textColor = sanitizeHex(req.query.text_color, 'c9d1d9');
    const titleColor = sanitizeHex(req.query.title_color, '58a6ff');
    const mutedColor = sanitizeHex(req.query.muted_color, '8b949e');
    const starColor = sanitizeHex(req.query.star_color, 'e3b341');
    const borderColor = sanitizeHex(req.query.border_color, '30363d');

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
        const prs = prsData.items || [];

        if (prs.length === 0) {
            return sendErrorSvg(res, `No Pull Requests found for "${escapeXml(username)}".`, bgColor, borderColor);
        }

        const uniqueRepoUrls = [...new Set(prs.map(pr => pr.repository_url))].slice(0, 20);
        const repoStats = {};

        const repoResults = await Promise.allSettled(
            uniqueRepoUrls.map(async (url) => {
                const repoRes = await fetch(url, { headers });
                if (!repoRes.ok) return { url, stars: 0 };
                const repoData = await repoRes.json();
                return { url, stars: repoData.stargazers_count || 0 };
            })
        );

        for (const result of repoResults) {
            if (result.status === 'fulfilled') {
                repoStats[result.value.url] = result.value.stars;
            }
        }

        const sortedPrs = prs
            .map(pr => ({ ...pr, repoStars: repoStats[pr.repository_url] || 0 }))
            .sort((a, b) => b.repoStars - a.repoStars)
            .slice(0, limit);

        const svg = buildSvg(sortedPrs, username, {
            showPr,
            showDate,
            showRepo,
            badgeWidth,
            rowHeight,
            bgColor,
            textColor,
            titleColor,
            mutedColor,
            starColor,
            borderColor
        });

        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 's-maxage=43200, stale-while-revalidate');
        res.status(200).send(svg);
    } catch (error) {
        console.error(error);
        sendErrorSvg(res, 'Error generating badge. Please try again.', bgColor, borderColor);
    }
}

function sanitizeUsername(input) {
    return input.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 39);
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
        badgeWidth,
        rowHeight,
        bgColor,
        textColor,
        titleColor,
        mutedColor,
        starColor,
        borderColor
    } = opts;

    const font = 'Segoe UI, Helvetica, Arial, sans-serif';
    const safeUser = escapeXml(username);
    const innerLeft = 20;
    const innerRight = badgeWidth - 20;

    const iconX = innerLeft;
    let cursorX = innerLeft + 24;

    const repoX = showRepo ? cursorX : -1;
    if (showRepo) cursorX += 180;

    const prX = showPr ? cursorX : -1;
    if (showPr) cursorX += showDate ? 360 : 460;

    const dateX = showDate ? cursorX : -1;
    if (showDate) cursorX += 110;

    const starX = Math.min(innerRight - 80, Math.max(cursorX, innerLeft + 520));

    const titleMaxLen = showPr
        ? (showRepo ? (showDate ? 38 : 50) : (showDate ? 50 : 65))
        : 0;

    let headerHtml = '';
    if (showRepo) {
        headerHtml += `<text x="${repoX}" y="75" font-family="${font}" font-size="12" font-weight="bold" fill="#${mutedColor}">REPOSITORY</text>`;
    }
    if (showPr) {
        headerHtml += `<text x="${prX}" y="75" font-family="${font}" font-size="12" font-weight="bold" fill="#${mutedColor}">PULL REQUEST</text>`;
    }
    if (showDate) {
        headerHtml += `<text x="${dateX}" y="75" font-family="${font}" font-size="12" font-weight="bold" fill="#${mutedColor}">DATE</text>`;
    }
    headerHtml += `<text x="${starX}" y="75" font-family="${font}" font-size="12" font-weight="bold" fill="#${mutedColor}">STARS</text>`;

    let rowsHtml = '';
    prs.forEach((pr, index) => {
        const yOffset = 110 + index * rowHeight;
        const icon = getStatusIcon(pr);
        const repoName = pr.repository_url.split('/').slice(-2).join('/');
        const date = new Date(pr.created_at).toISOString().split('T')[0];
        const title = truncate(pr.title, titleMaxLen);
        const repoText = truncate(repoName, 24);
        const starsText = formatStars(pr.repoStars);

        rowsHtml += `<g transform="translate(0, ${yOffset})">`;
        rowsHtml += `<svg x="${iconX}" y="-12" width="16" height="16" viewBox="0 0 16 16" fill="${icon.color}"><path fill-rule="evenodd" d="${icon.path}"></path></svg>`;

        if (showRepo) {
            rowsHtml += `<text x="${repoX}" y="0" font-family="${font}" font-size="14" font-weight="600" fill="#${textColor}">${repoText}</text>`;
        }
        if (showPr) {
            rowsHtml += `<text x="${prX}" y="0" font-family="${font}" font-size="14" fill="#${mutedColor}">${title}</text>`;
        }
        if (showDate) {
            rowsHtml += `<text x="${dateX}" y="0" font-family="${font}" font-size="13" fill="#${mutedColor}">${date}</text>`;
        }

        rowsHtml += `<svg x="${starX}" y="-12" width="16" height="16" viewBox="0 0 16 16" fill="#${starColor}"><path fill-rule="evenodd" d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z"></path></svg>`;
        rowsHtml += `<text x="${starX + 20}" y="0" font-family="${font}" font-size="13" font-weight="bold" fill="#${starColor}">${starsText}</text>`;
        rowsHtml += `</g>`;
    });

    const svgHeight = 130 + prs.length * rowHeight;

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${badgeWidth}" height="${svgHeight}" viewBox="0 0 ${badgeWidth} ${svgHeight}">
  <rect width="${badgeWidth - 2}" height="${svgHeight - 2}" x="1" y="1" rx="8" fill="#${bgColor}" stroke="#${borderColor}" stroke-width="1"/>
  <text x="20" y="35" font-family="${font}" font-size="18" font-weight="bold" fill="#${titleColor}">Top Contributions by ${safeUser}</text>
  ${headerHtml}
  <line x1="20" y1="85" x2="${badgeWidth - 20}" y2="85" stroke="#${borderColor}" stroke-width="1"/>
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

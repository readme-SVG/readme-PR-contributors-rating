export default async function handler(req, res) {
    const username = sanitizeUsername(req.query.username || 'OstinUA');
    const limit = clamp(parseInt(req.query.limit, 10) || 7, 1, 15);
    const showDate = req.query.show_date !== 'false';
    const showRepo = req.query.show_repo !== 'false';
    const bgColor = sanitizeHex(req.query.bg_color, '0d1117');
    const textColor = sanitizeHex(req.query.text_color, 'c9d1d9');
    const titleColor = sanitizeHex(req.query.title_color, '58a6ff');

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
            return sendErrorSvg(res, 'API rate limit exceeded. Please try again later.', bgColor);
        }

        if (prsResponse.status === 422) {
            return sendErrorSvg(res, `User "${escapeXml(username)}" not found.`, bgColor);
        }

        if (!prsResponse.ok) {
            return sendErrorSvg(res, `GitHub API error (${prsResponse.status}).`, bgColor);
        }

        const prsData = await prsResponse.json();
        const prs = prsData.items || [];

        if (prs.length === 0) {
            return sendErrorSvg(res, `No Pull Requests found for "${escapeXml(username)}".`, bgColor);
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

        const svg = buildSvg(sortedPrs, username, { showDate, showRepo, bgColor, textColor, titleColor });

        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 's-maxage=43200, stale-while-revalidate');
        res.status(200).send(svg);
    } catch (error) {
        console.error(error);
        sendErrorSvg(res, 'Error generating badge. Please try again.', bgColor);
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
    const { showDate, showRepo, bgColor, textColor, titleColor } = opts;
    const font = 'Segoe UI, Helvetica, Arial, sans-serif';
    const headerColor = '#8b949e';
    const starColor = '#e3b341';
    const safeUser = escapeXml(username);

    // Column layout
    const colIcon = 20;
    let colRepo = 45;
    let colTitle = showRepo ? 240 : 45;
    let colDate = showDate ? 620 : -1;
    let colStar = showDate ? 735 : 700;
    const svgWidth = 830;

    if (!showRepo && !showDate) {
        colTitle = 45;
        colStar = 750;
    } else if (!showRepo && showDate) {
        colTitle = 45;
        colDate = 580;
        colStar = 700;
    } else if (showRepo && !showDate) {
        colTitle = 240;
        colStar = 750;
    }

    const titleMaxLen = showRepo ? (showDate ? 40 : 50) : (showDate ? 55 : 65);

    let headerHtml = '';
    if (showRepo) {
        headerHtml += `<text x="${colRepo}" y="75" font-family="${font}" font-size="12" font-weight="bold" fill="${headerColor}">REPOSITORY</text>`;
    }
    headerHtml += `<text x="${colTitle}" y="75" font-family="${font}" font-size="12" font-weight="bold" fill="${headerColor}">PULL REQUEST</text>`;
    if (showDate) {
        headerHtml += `<text x="${colDate}" y="75" font-family="${font}" font-size="12" font-weight="bold" fill="${headerColor}">DATE</text>`;
    }
    headerHtml += `<text x="${colStar}" y="75" font-family="${font}" font-size="12" font-weight="bold" fill="${headerColor}">STARS</text>`;

    let rowsHtml = '';
    prs.forEach((pr, index) => {
        const yOffset = 110 + index * 40;
        const icon = getStatusIcon(pr);
        const repoName = pr.repository_url.split('/').slice(-2).join('/');
        const date = new Date(pr.created_at).toISOString().split('T')[0];
        const title = truncate(pr.title, titleMaxLen);
        const repoText = truncate(repoName, 22);
        const starsText = formatStars(pr.repoStars);

        rowsHtml += `<g transform="translate(0, ${yOffset})">`;
        rowsHtml += `<svg x="${colIcon}" y="-12" width="16" height="16" viewBox="0 0 16 16" fill="${icon.color}"><path fill-rule="evenodd" d="${icon.path}"></path></svg>`;

        if (showRepo) {
            rowsHtml += `<text x="${colRepo}" y="0" font-family="${font}" font-size="14" font-weight="600" fill="#${textColor}">${repoText}</text>`;
        }
        rowsHtml += `<text x="${colTitle}" y="0" font-family="${font}" font-size="14" fill="${headerColor}">${title}</text>`;

        if (showDate) {
            rowsHtml += `<text x="${colDate}" y="0" font-family="${font}" font-size="13" fill="${headerColor}">${date}</text>`;
        }

        rowsHtml += `<svg x="${colStar}" y="-12" width="16" height="16" viewBox="0 0 16 16" fill="${starColor}"><path fill-rule="evenodd" d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z"></path></svg>`;
        rowsHtml += `<text x="${colStar + 20}" y="0" font-family="${font}" font-size="13" font-weight="bold" fill="${starColor}">${starsText}</text>`;
        rowsHtml += `</g>`;
    });

    const svgHeight = 130 + prs.length * 40;

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">
  <rect width="${svgWidth - 2}" height="${svgHeight - 2}" x="1" y="1" rx="8" fill="#${bgColor}" stroke="#30363d" stroke-width="1"/>
  <text x="20" y="35" font-family="${font}" font-size="18" font-weight="bold" fill="#${titleColor}">Top Contributions by ${safeUser}</text>
  ${headerHtml}
  <line x1="20" y1="85" x2="${svgWidth - 20}" y2="85" stroke="#21262d" stroke-width="1"/>
  ${rowsHtml}
</svg>`;
}

function sendErrorSvg(res, message, bgColor) {
    const font = 'Segoe UI, Helvetica, Arial, sans-serif';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="60" viewBox="0 0 500 60">
  <rect width="498" height="58" x="1" y="1" rx="8" fill="#${bgColor}" stroke="#30363d" stroke-width="1"/>
  <text x="20" y="35" font-family="${font}" font-size="14" fill="#f85149">${escapeXml(message)}</text>
</svg>`;
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    res.status(200).send(svg);
}

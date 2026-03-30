export default async function handler(req, res) {
    const { username = 'OstinUA' } = req.query;

    const token = process.env.GITHUB_TOKEN;
    const headers = token ? { Authorization: `token ${token}` } : {};

    try {
        const prsResponse = await fetch(
            `https://api.github.com/search/issues?q=is:pr+author:${username}&sort=created&order=desc&per_page=30`, 
            { headers }
        );
        const prsData = await prsResponse.json();
        const prs = prsData.items || [];

        if (prs.length === 0) {
            return res.status(200).send('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="40"><text x="10" y="25" fill="#c9d1d9">No Pull Requests found.</text></svg>');
        }

        const uniqueRepoUrls = [...new Set(prs.map(pr => pr.repository_url))].slice(0, 15);
        const repoStats = {};

        await Promise.all(uniqueRepoUrls.map(async (url) => {
            try {
                const repoRes = await fetch(url, { headers });
                const repoData = await repoRes.json();
                repoStats[url] = repoData.stargazers_count || 0;
            } catch (e) {
                repoStats[url] = 0;
            }
        }));

        const sortedPrs = prs
            .map(pr => ({
                ...pr,
                repoStars: repoStats[pr.repository_url] || 0
            }))
            .sort((a, b) => b.repoStars - a.repoStars)
            .slice(0, 7);

        const getStatusIcon = (pr) => {
            if (pr.state === 'open') {
                return { color: '#3fb950', path: 'M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.25 2.25 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1.5 1.5 0 011.5 1.5v5.628a2.25 2.25 0 101.5 0V5.5A3 3 0 0011 2.5zm1.25 9.25a.75.75 0 100 1.5.75.75 0 000-1.5zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z' };
            } else if (pr.pull_request && pr.pull_request.merged_at) {
                return { color: '#a371f7', path: 'M5 3.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm0 2.122a2.25 2.25 0 10-1.5 0v3.256a2.25 2.25 0 101.5 0V5.372zm3.15 4.63a.75.75 0 01-.22 1.036l-2.004 1.336a.75.75 0 01-1.052-.187L3.06 10.45a.75.75 0 011.24-.834l.654.975 1.157-.771a.75.75 0 011.04.18v-.001zM13.75 2.5h-1V4h1a1.5 1.5 0 011.5 1.5v5.628a2.25 2.25 0 101.5 0V5.5A3 3 0 0013.75 2.5zm1.25 9.25a.75.75 0 100 1.5.75.75 0 000-1.5z' };
            } else {
                return { color: '#f85149', path: 'M1.5 3.25a2.25 2.25 0 113 2.122v5.256a2.25 2.25 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zM3 12a.75.75 0 101.5 0 .75.75 0 00-1.5 0zm6.669-9.158a.25.25 0 01.352-.02l3.396 2.808a.25.25 0 010 .386L10.02 8.824a.25.25 0 01-.387-.319l2.768-2.288-2.768-2.288a.25.25 0 01-.034-.352zM10.02 8.824a.25.25 0 01.352.02l3.396-2.808a.25.25 0 010-.386L10.02 2.842a.25.25 0 01-.387.319l2.768 2.288-2.768 2.288a.25.25 0 01-.034.352z' };
            }
        };

        const truncate = (str, length) => str.length > length ? str.substring(0, length - 3) + '...' : str;
        const formatStars = (stars) => stars >= 1000 ? (stars / 1000).toFixed(1) + 'k' : stars;

        let rowsHtml = '';
        sortedPrs.forEach((pr, index) => {
            const yOffset = 110 + (index * 40);
            const icon = getStatusIcon(pr);
            const repoName = pr.repository_url.split('/').slice(-2).join('/');
            const date = new Date(pr.created_at).toISOString().split('T')[0];
            const title = truncate(pr.title, 50);
            const repoText = truncate(repoName, 22);
            const starsText = formatStars(pr.repoStars);

            rowsHtml += `
                <g transform="translate(0, ${yOffset})">
                    <svg x="20" y="-12" width="16" height="16" viewBox="0 0 16 16" fill="${icon.color}">
                        <path fill-rule="evenodd" d="${icon.path}"></path>
                    </svg>
                    <text x="45" y="0" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="14" font-weight="600" fill="#c9d1d9">${repoText}</text>
                    <text x="240" y="0" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="14" fill="#8b949e">${title}</text>
                    <text x="660" y="0" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="13" fill="#8b949e">${date}</text>
                    
                    <svg x="735" y="-12" width="16" height="16" viewBox="0 0 16 16" fill="#e3b341">
                        <path fill-rule="evenodd" d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z"></path>
                    </svg>
                    <text x="755" y="0" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="13" font-weight="bold" fill="#e3b341">${starsText}</text>
                </g>
            `;
        });

        const svgHeight = 130 + (sortedPrs.length * 40);
        
        const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="830" height="${svgHeight}" viewBox="0 0 830 ${svgHeight}">
            <rect width="828" height="${svgHeight - 2}" x="1" y="1" rx="8" fill="#0d1117" stroke="#30363d" stroke-width="1"/>
            
            <text x="20" y="35" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="18" font-weight="bold" fill="#58a6ff">
                Top Contributions by ${username}
            </text>
            
            <text x="45" y="75" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="12" font-weight="bold" fill="#8b949e" text-transform="uppercase">Repository</text>
            <text x="240" y="75" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="12" font-weight="bold" fill="#8b949e" text-transform="uppercase">Pull Request</text>
            <text x="660" y="75" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="12" font-weight="bold" fill="#8b949e" text-transform="uppercase">Date</text>
            <text x="735" y="75" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="12" font-weight="bold" fill="#8b949e" text-transform="uppercase">Stars</text>

            <line x1="20" y1="85" x2="810" y2="85" stroke="#21262d" stroke-width="1" />

            ${rowsHtml}
        </svg>
        `;

        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate'); 
        res.status(200).send(svg);
    } catch (error) {
        console.error(error);
        res.status(500).send('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="40"><text x="10" y="25" fill="#f85149">Error generating badge</text></svg>');
    }
}

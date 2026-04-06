# GitHub PR Contributors Rating

Dynamic, configurable SVG badge library for logging and visualizing top GitHub pull request activity directly inside `README.md` files.

[![Build](https://img.shields.io/badge/Build-Vercel-black?style=for-the-badge&logo=vercel)](https://vercel.com)
[![Version](https://img.shields.io/badge/Version-1.0.0-blue?style=for-the-badge)](./package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](./LICENSE)
[![API](https://img.shields.io/badge/API-GitHub%20GraphQL-181717?style=for-the-badge&logo=github)](https://docs.github.com/en/graphql)

> [!NOTE]
> The previous README contained only a single badge embed. This rewritten documentation keeps that intent while fully documenting architecture, configuration, usage patterns, and deployment workflows.

## Table of Contents

- [Features](#features)
- [Tech Stack & Architecture](#tech-stack--architecture)
- [Getting Started](#getting-started)
- [Testing](#testing)
- [Deployment](#deployment)
- [Usage](#usage)
- [Configuration](#configuration)
- [License](#license)
- [Support the Project](#support-the-project)

## Features

- Generates a live SVG badge from GitHub pull request activity using the GitHub GraphQL API.
- Sorts PR records by repository stargazer count to prioritize impact and visibility.
- Supports filtering by merged/open (and optionally rejected) PRs.
- Supports optional unique repository mode to avoid duplicate repo entries.
- Provides per-column visibility controls:
  - PR title/status
  - PR creation date
  - Primary repository language
  - Line-change volume (`additions + deletions`)
- Supports configurable column ordering through `col_order`.
- Exposes extensive layout controls (`badge_width`, row and column widths).
- Exposes full color theming controls (background, title, text, muted text, star, border, shadow).
- Supports transparent mode for seamless embedding into both dark and light READMEs.
- Includes secure/safe query sanitization for username, custom text, and color values.
- Includes a static visual generator UI (`index.html`) for no-code badge generation.
- Ships multilingual UI labels via `i18n/*` locale bundles.
- Includes an i18n key integrity validator to prevent translation drift.
- Returns SVG-based error responses (instead of raw JSON), preserving Markdown rendering fidelity.
- Adds cache headers for better CDN performance (`s-maxage` + `stale-while-revalidate`).

> [!TIP]
> Use `unique_repos=true` for contributor portfolios where you want breadth across repositories instead of multiple PRs from one project.

## Tech Stack & Architecture

### Core Stack

- **Runtime:** Node.js (ES module style).
- **API Layer:** Serverless function (`api/badge.js`) compatible with Vercel-style routing.
- **Data Source:** GitHub GraphQL API (`search` query over PR issues).
- **Frontend Generator:** Plain HTML/CSS/JavaScript single-page utility (`index.html`).
- **Localization:** In-browser locale dictionaries loaded from `i18n/*.js`.

### Project Structure

```text
.
|-- api/
|   `-- badge.js               # Serverless badge generation handler
|-- i18n/
|   |-- en.js                  # English UI strings
|   |-- es.js                  # Spanish UI strings
|   |-- ru.js                  # Russian UI strings
|   |-- zh-CN.js               # Simplified Chinese UI strings
|   |-- ...                    # Other locale bundles
|   `-- validate.js            # i18n required-key validator
|-- index.html                 # Badge generator UI + markdown output helper
|-- package.json               # Package metadata and scripts
|-- LICENSE
`-- README.md
```

### Key Design Decisions

1. **GraphQL over REST**
   - Uses GitHub GraphQL to collect PR metadata and repository attributes in one request shape.
   - Reduces over-fetching compared to multiple REST endpoint calls.

2. **Defensive Input Sanitization**
   - Username is constrained to GitHub-compatible characters.
   - Colors are constrained to hex-safe values.
   - User-facing custom title text is length-limited and sanitized.

3. **SVG-first Output Contract**
   - Success and failure modes both return SVG, enabling robust README embedding.

4. **Configurable Rendering Layout**
   - Width controls and optional columns support dense but readable compact displays.

5. **Static UI + API Separation**
   - `index.html` is a client utility; `api/badge.js` is the canonical rendering engine.

### Data Flow

```mermaid
flowchart LR
    A[Client README or Browser UI] --> B[/api/badge]
    B --> C[Parse & sanitize query params]
    C --> D[GitHub GraphQL search: is:pr author:<username>]
    D --> E[Normalize PR records]
    E --> F[Filter state + unique repos]
    F --> G[Sort by stargazer count]
    G --> H[Render SVG rows and theme]
    H --> I[Cache headers + SVG response]
```

> [!IMPORTANT]
> For higher request quotas and stable production behavior, set `GITHUB_TOKEN` in your deployment environment.

## Getting Started

### Prerequisites

- Node.js `>=18` (recommended `>=20` for modern runtime parity).
- npm (or compatible package manager).
- Optional but recommended: GitHub personal access token in `GITHUB_TOKEN`.

### Installation

```bash
git clone https://github.com/readme-SVG/readme-pr-contributors-rating.git
cd readme-pr-contributors-rating
npm install
```

Create a local environment file:

```bash
cp .env.example .env 2>/dev/null || true
```

Then export your token (if no `.env` loader is configured):

```bash
export GITHUB_TOKEN="ghp_your_token_here"
```

Run locally:

```bash
npm start
```

> [!WARNING]
> Without `GITHUB_TOKEN`, GitHub anonymous rate limits may throttle badge generation.

## Testing

This repository is lightweight and currently does not define a full dedicated test framework in `package.json`. Use the following practical checks:

### Lint/Static Checks

```bash
node --check api/badge.js
node --check i18n/validate.js
```

### i18n Integrity

```bash
node -e "global.window={};require('fs').readdirSync('./i18n').filter(f=>f.endsWith('.js')).forEach(f=>{eval(require('fs').readFileSync('./i18n/'+f,'utf8'))});window.validateI18nIntegrity();console.log('i18n OK')"
```

### API Smoke Test (after deployment or local serverless emulation)

```bash
curl "http://localhost:3000/api/badge?username=OstinUA&limit=5&show_pr=true&show_date=true"
```

> [!CAUTION]
> If your runtime does not polyfill `fetch`, the serverless handler may require a Node.js runtime that includes native `fetch`.

## Deployment

### Recommended: Vercel

1. Import repository into Vercel.
2. Set environment variable:
   - `GITHUB_TOKEN`
3. Deploy.
4. Use endpoint:
   - `https://<your-domain>/api/badge?...`

### CI/CD Integration Guidelines

- Add a CI job that runs syntax checks (`node --check ...`).
- Add a smoke request against `/api/badge` on preview deployments.
- Fail deployment if SVG response contains known error markers.

### Containerization (Optional)

For teams that prefer containerized preview environments, serve static files and route function execution through your platform’s Node serverless adapter. Keep the API contract unchanged to preserve badge URLs.

## Usage

### Minimal Badge Embed

```md
[![Top PRs](https://readme-pr-contributors-rating.vercel.app/api/badge?username=OstinUA)](https://github.com/readme-SVG/readme-pr-contributors-rating)
```

### Fully Customized Example

```md
[![Top PRs](https://readme-pr-contributors-rating.vercel.app/api/badge?username=OstinUA&show_pr=true&show_date=true&show_lang=true&show_changes=true&unique_repos=true&col_order=pr%2Cdate%2Clang%2Cchanges&bg_color=000000&text_color=ffffff&title_color=ffffff&muted_color=d1d5db&star_color=ffd166&border_color=000000&transparent=true)](https://github.com/readme-SVG/readme-pr-contributors-rating)
```

### Programmatic Consumption Example

```js
// Fetch SVG badge markup from deployed endpoint
const endpoint = 'https://readme-pr-contributors-rating.vercel.app/api/badge';
const params = new URLSearchParams({
  username: 'OstinUA',
  limit: '7',
  show_pr: 'true',
  show_date: 'true',
  show_lang: 'true',
  show_changes: 'true',
  unique_repos: 'true',
  transparent: 'true'
});

const res = await fetch(`${endpoint}?${params.toString()}`);
const svg = await res.text();

// Persist badge snapshot for docs pipelines
await Bun.write('./badge.svg', svg);
```

> [!NOTE]
> The API returns SVG text. If consuming from scripts, treat the response body as UTF-8 XML.

## Configuration

Below is the runtime query parameter reference for `/api/badge`.

### Identity & Dataset

- `username` (string): GitHub username; sanitized to GitHub-safe characters.
- `limit` (int, default `7`, min `1`, max `15`): Number of entries.
- `show_rejected` (`true|false`, default `false`): Include closed-but-not-merged PRs.
- `unique_repos` (`true|false`, default `false`): Keep latest PR per repository only.

### Visibility & Layout

- `show_pr` (`true|false`, default `true`)
- `show_date` (`true|false`, default `true`)
- `show_lang` (`true|false`, default `false`)
- `show_changes` (`true|false`, default `false`)
- `repo_name_format` (`full|short`, default `full`)
- `col_order` (CSV of `pr,date,lang,changes`): Ordered visible columns.

### Dimension Controls

- `badge_width` (default `830`, range `700..1400`)
- `row_height` (default `40`, range `30..60`)
- `repo_width` (default `180`, range `60..500`)
- `lang_width` (default `80`, range `60..300`)
- `pr_width` (default `320`, range `100..900`)
- `date_width` (default `90`, range `60..300`)
- `changes_width` (default `100`, range `70..300`)
- `stars_width` (default `60`, range `50..240`)

### Theming

- `custom_title` (string, sanitized, max length `80`)
- `bg_color` (hex, default `0d1117`)
- `text_color` (hex, default `c9d1d9`)
- `title_color` (hex, default `58a6ff`)
- `muted_color` (hex, default `8b949e`)
- `star_color` (hex, default `e3b341`)
- `border_color` (hex, default `30363d`)
- `shadow_color` (hex, default `000000`)
- `transparent` (`true|false`, default `false`)

### Environment Variables

- `GITHUB_TOKEN`: Optional but recommended token for increased rate limits and improved stability.

> [!IMPORTANT]
> All color parameters are sanitized; invalid values are replaced by secure defaults.

## License

This project is licensed under the **MIT License**. See [`LICENSE`](./LICENSE) for full terms.

## Support the Project

[![Patreon](https://img.shields.io/badge/Patreon-OstinFCT-f96854?style=flat-square&logo=patreon)](https://www.patreon.com/OstinFCT)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-fctostin-29abe0?style=flat-square&logo=ko-fi)](https://ko-fi.com/fctostin)
[![Boosty](https://img.shields.io/badge/Boosty-Support-f15f2c?style=flat-square)](https://boosty.to/ostinfct)
[![YouTube](https://img.shields.io/badge/YouTube-FCT--Ostin-red?style=flat-square&logo=youtube)](https://www.youtube.com/@FCT-Ostin)
[![Telegram](https://img.shields.io/badge/Telegram-FCTostin-2ca5e0?style=flat-square&logo=telegram)](https://t.me/FCTostin)

If you find this tool useful, consider leaving a star on GitHub or supporting the author directly.

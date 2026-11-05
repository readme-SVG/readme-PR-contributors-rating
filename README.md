<a href="https://github.com/OstinUA" target="_blank" rel="noopener"><img src="https://raw.githubusercontent.com/OstinUA/Image-storage/main/readme/readme-pr-contributors-rating.png" valign="middle" alt="readme pr contributors rating"></a>

> [!NOTE]
> The previous README contained only a single badge embed. This rewritten documentation keeps that intent while fully documenting architecture, configuration, usage patterns, and deployment workflows.

Dynamic, configurable SVG badge library for logging and visualizing top GitHub pull request activity directly inside `README.md` files.

[![Build](https://img.shields.io/badge/Build-Vercel-black?style=for-the-badge&logo=vercel)](https://vercel.com)
[![Version](https://img.shields.io/badge/Version-1.0.0-blue?style=for-the-badge)](./package.json)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-green?style=for-the-badge)](./LICENSE)
[![API](https://img.shields.io/badge/API-GitHub%20GraphQL-181717?style=for-the-badge&logo=github)](https://docs.github.com/en/graphql)

---

[![Top PRs](https://readme-pr-contributors-rating.vercel.app/api/badge?username=john-preston&show_pr=true&show_date=true&show_lang=false&show_changes=true&unique_repos=true&show_rejected=true&col_order=changes%2Cpr%2Cdate%2Clang&bg_color=22272e&text_color=539bf5&title_color=539bf5&muted_color=768390&star_color=d29922&border_color=1f6feb)](https://github.com/readme-SVG/readme-pr-contributors-rating)

[![Top PRs](https://readme-pr-contributors-rating.vercel.app/api/badge?username=schacon&show_pr=true&show_date=true&show_lang=true&show_changes=true&unique_repos=true&col_order=pr%2Cdate%2Clang%2Cchanges&bg_color=1c0d0d&text_color=d8e5ff&title_color=ff4d4d&muted_color=89a4d6&star_color=1f6feb&border_color=1d3557)](https://github.com/readme-SVG/readme-pr-contributors-rating)

---

## Table of Contents

- [Features](#features)
- [Tech Stack & Architecture](#tech-stack--architecture)
- [Getting Started](#getting-started)
- [Testing](#testing)
- [Deployment](#deployment)
- [Repository Automation](#repository-automation)
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
|-- .github/
|   |-- workflows/             # CI: lint, CodeQL SAST, Scorecard, Dependabot, AI issue analysis
|   `-- labels.yml             # Declarative label catalog (source of truth for sync)
|-- api/
|   `-- badge.js               # Serverless badge generation handler
|-- i18n/
|   |-- en.js                  # English UI strings
|   |-- es.js                  # Spanish UI strings
|   |-- ru.js                  # Russian UI strings
|   |-- zh-CN.js               # Simplified Chinese UI strings
|   |-- ...                    # Other locale bundles
|   `-- validate.js            # i18n required-key schema and validator
|-- scripts/
|   |-- sync_labels.py         # Applies .github/labels.yml to the repository
|   |-- trigger_action.py      # AI change-analysis automation (GitHub Actions)
|   `-- validate-i18n.mjs      # Node.js i18n integrity check used by CI
|-- index.html                 # Badge generator UI + markdown output helper
|-- package.json               # Package metadata and scripts
|-- requirements.txt           # Pinned Python dependencies (Dependabot-managed)
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

The badge handler is a serverless function; to run the full stack locally use the Vercel CLI:

```bash
npx vercel dev
```

Static checks (no deployment required):

```bash
npm run lint
```

> [!WARNING]
> Without `GITHUB_TOKEN`, GitHub anonymous rate limits may throttle badge generation.

## Testing

The repository ships fast, dependency-free static checks that also run in CI (`.github/workflows/lint.yml`):

### Lint/Static Checks

```bash
npm run lint          # JS syntax check + i18n schema validation
```

### i18n Integrity

```bash
npm run validate:i18n # every locale must match the schema in i18n/validate.js
```

The validator loads all locale bundles, enforces the required-key schema and
cross-checks every `data-i18n` key referenced from `index.html`.

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

- Pull requests run syntax checks, i18n schema validation, and CodeQL SAST automatically.
- Add a smoke request against `/api/badge` on preview deployments.
- Fail deployment if SVG response contains known error markers.

### Containerization (Optional)

For teams that prefer containerized preview environments, serve static files and route function execution through your platform’s Node serverless adapter. Keep the API contract unchanged to preserve badge URLs.

## Repository Automation

Two workflows drive repository hygiene. Both are idempotent and safe to re-run.

### AI Change Analysis

`.github/workflows/ai-issue.yml` runs `scripts/trigger_action.py` on pushes and
pull requests. The script collects the diff, classifies the change, asks a
configurable model for a severity verdict and files a labeled issue. Runs are
skipped (exit code `0`) when the actor is not allow-listed, the diff is too
small, an issue already exists for the change, or the model is unavailable.

| Variable | Required | Purpose |
| --- | --- | --- |
| `GITHUB_TOKEN` | yes | Repository access for diff collection and issue creation |
| `GH_MODELS_TOKEN` | yes | Inference backend authentication |
| `REPOSITORY` | yes | `owner/repo` target |
| `EVENT_NAME` | yes | `push` or `pull_request` |
| `ALLOWED_USER` | no | Comma-separated allow-list of triggering logins |
| `AI_ENDPOINT` | no | Override the inference endpoint |
| `AI_MODEL` | no | Override the model name |

### Label Synchronization

`.github/workflows/label-sync.yml` runs `scripts/sync_labels.py` whenever
`.github/labels.yml` changes, treating that file as the single source of truth.
Labels are created or updated to match; labels absent from the catalog are left
alone unless `PRUNE_LABELS=true` is set.

```bash
GITHUB_TOKEN=ghp_xxx GITHUB_REPOSITORY=owner/repo python scripts/sync_labels.py
```

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

This project is licensed under the **GNU General Public License v3.0**. See [`LICENSE`](./LICENSE) for full terms.

## Support the Project

[![Patreon](https://img.shields.io/badge/Patreon-OstinFCT-f96854?style=flat-square&logo=patreon)](https://www.patreon.com/OstinFCT)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-fctostin-29abe0?style=flat-square&logo=ko-fi)](https://ko-fi.com/fctostin)
[![Boosty](https://img.shields.io/badge/Boosty-Support-f15f2c?style=flat-square)](https://boosty.to/ostinfct)
[![YouTube](https://img.shields.io/badge/YouTube-FCT--Ostin-red?style=flat-square&logo=youtube)](https://www.youtube.com/@FCT-Ostin)
[![Telegram](https://img.shields.io/badge/Telegram-FCTostin-2ca5e0?style=flat-square&logo=telegram)](https://t.me/FCTostin)

If you find this tool useful, consider leaving a star on GitHub or supporting the author directly.

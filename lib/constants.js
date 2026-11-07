/**
 * Immutable configuration shared by the request parser, the GitHub client and
 * the SVG renderer.
 *
 * Everything in this module is declarative: no function ever mutates these
 * objects, which keeps the runtime behaviour of the badge fully predictable
 * and makes the values trivially testable.
 */

// ---------------------------------------------------------------------------
// Upstream API
// ---------------------------------------------------------------------------

export const GITHUB_GRAPHQL_ENDPOINT = 'https://api.github.com/graphql';
export const GITHUB_REST_ROOT = 'https://api.github.com';

/** Maximum number of search pages fetched per request (100 nodes each). */
export const SEARCH_MAX_PAGES = 5;
export const SEARCH_PAGE_SIZE = 100;

/** Number of `repo:owner/name` qualifiers batched per REST search request. */
export const REST_REPO_BATCH_SIZE = 30;

/** Per-request timeout for upstream GitHub API calls, in milliseconds. */
export const UPSTREAM_TIMEOUT_MS = 8_000;

/**
 * Cumulative budget for multi-page GraphQL pagination, kept comfortably below
 * Vercel Hobby's 10 s serverless execution limit.
 */
export const PAGINATION_BUDGET_MS = 6_500;

/**
 * Upper bound of pull requests whose diff statistics are fetched when the
 * caller sorts by change size. One batched GraphQL request covers up to 100
 * node ids, so this stays a single round-trip.
 */
export const CHANGE_SORT_CANDIDATES_AUTH = 60;
export const CHANGE_SORT_CANDIDATES_ANON = 15;

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

/** Warm-instance cache TTL for raw pull request pages. */
export const PR_CACHE_TTL_MS = 10 * 60 * 1000;
export const PR_CACHE_MAX_ENTRIES = 200;

/** Cache-Control for successfully rendered badges (2 days at the CDN edge). */
export const CACHE_CONTROL_SUCCESS = 'public, s-maxage=172800, stale-while-revalidate=86400';
/** Cache-Control for error badges; short so a fixed deployment recovers fast. */
export const CACHE_CONTROL_ERROR = 'public, s-maxage=300, stale-while-revalidate=60';

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

export const FONT_STACK = 'Segoe UI, Helvetica, Arial, sans-serif';

/**
 * GitHub's primary language colours, mirrored from Linguist
 * (https://github.com/github/linguist/blob/main/lib/linguist/languages.yml)
 * for the languages most frequently seen in public repositories.
 */
export const LANGUAGE_COLORS = {
    JavaScript: '#f1e05a',
    TypeScript: '#3178c6',
    Python: '#3572A5',
    Java: '#b07219',
    Go: '#00ADD8',
    Rust: '#dea584',
    'C': '#555555',
    'C++': '#f34b7d',
    'C#': '#178600',
    Ruby: '#701516',
    PHP: '#4F5D95',
    Swift: '#F05138',
    Kotlin: '#A97BFF',
    Dart: '#00B4AB',
    Scala: '#c22d40',
    Shell: '#89e051',
    Lua: '#000080',
    HTML: '#e34c26',
    CSS: '#563d7c',
    Vue: '#41b883',
    Svelte: '#ff3e00',
    Elixir: '#6e4a7e',
    Haskell: '#5e5086',
    R: '#198CE7',
    'Objective-C': '#438eff',
    Perl: '#0298c3',
    Zig: '#ec915c',
    'Jupyter Notebook': '#DA5B0B',
    Nix: '#7e7eff',
    Assembly: '#6E4C13'
};

export const DEFAULT_LANGUAGE_COLOR = '#8b949e';

/** Octicons (16x16 viewBox) used for the PR status and star glyphs. */
export const ICONS = {
    merged: {
        color: '#a371f7',
        path: 'M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z'
    },
    open: {
        color: '#3fb950',
        path: 'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.25 2.25 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854v4.792a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm.75-2.25a2.25 2.25 0 1 1 0 4.5 2.25 2.25 0 0 1 0-4.5Z'
    },
    closed: {
        color: '#f85149',
        path: 'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.25 2.25 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854v4.792a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z'
    },
    star: {
        path: 'M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z'
    }
};

/** Fixed layout metrics (pixels) shared by the header and every row. */
export const LAYOUT = {
    leftPad: 20,
    rightPad: 20,
    iconWidth: 24,
    iconGap: 8,
    colGap: 12,
    headerY: 75,
    headerLineY: 85,
    firstRowY: 110,
    titleY: 35,
    repoMinWidth: 60,
    columnMinWidth: 50,
    rankWidth: 26
};

/** Column keys accepted in `col_order`, in their default order. */
export const COLUMN_KEYS = ['pr', 'date', 'lang', 'changes'];

/** Header captions, kept in English to match the GitHub UI vocabulary. */
export const COLUMN_LABELS = {
    repo: 'REPOSITORY',
    pr: 'PULL REQUEST',
    date: 'DATE',
    lang: 'LANGUAGE',
    changes: 'CHANGES',
    stars: 'STARS'
};

export const SORT_KEYS = ['stars', 'date', 'changes'];
export const ORDER_KEYS = ['desc', 'asc'];
export const OUTPUT_FORMATS = ['svg', 'json'];

/** Theme presets, mirrored by the configurator UI in `assets/app.js`. */
export const THEME_PRESETS = {
    dark: {
        transparent: false,
        colors: {
            bg: '0d1117',
            text: 'c9d1d9',
            title: '58a6ff',
            muted: '8b949e',
            star: 'e3b341',
            border: '30363d',
            shadow: '000000'
        }
    },
    light: {
        transparent: false,
        colors: {
            bg: 'ffffff',
            text: '24292f',
            title: '0969da',
            muted: '57606a',
            star: 'bf8700',
            border: 'd0d7de',
            shadow: '000000'
        }
    },
    dimmed: {
        transparent: false,
        colors: {
            bg: '22272e',
            text: 'adbac7',
            title: '539bf5',
            muted: '768390',
            star: 'd29922',
            border: '444c56',
            shadow: '000000'
        }
    },
    night: {
        transparent: false,
        colors: {
            bg: '0b1320',
            text: 'd8e5ff',
            title: '4ea1ff',
            muted: '89a4d6',
            star: 'ffd166',
            border: '1d3557',
            shadow: '000000'
        }
    },
    transparent: {
        transparent: true,
        colors: {
            bg: '000000',
            text: 'ffffff',
            title: 'ffffff',
            muted: 'd1d5db',
            star: 'ffd166',
            border: '000000',
            shadow: '000000'
        }
    }
};

export const THEME_NAMES = Object.keys(THEME_PRESETS);
export const COLOR_KEYS = ['bg', 'text', 'title', 'muted', 'star', 'border', 'shadow'];

/** Inclusive numeric bounds for every dimension query parameter. */
export const LIMITS = {
    limit: [1, 15],
    badgeWidth: [700, 1400],
    rowHeight: [30, 60],
    repoWidth: [60, 500],
    langWidth: [60, 300],
    prWidth: [100, 900],
    dateWidth: [60, 300],
    changesWidth: [70, 300],
    starsWidth: [50, 240]
};

export const DEFAULTS = {
    username: 'OstinUA',
    theme: 'dark',
    limit: 7,
    sort: 'stars',
    order: 'desc',
    format: 'svg',
    badgeWidth: 830,
    rowHeight: 40,
    repoWidth: 180,
    langWidth: 80,
    prWidth: 320,
    dateWidth: 90,
    changesWidth: 100,
    starsWidth: 60
};

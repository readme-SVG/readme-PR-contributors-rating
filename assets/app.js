/**
 * Configurator controller for the pull request badge generator.
 *
 * Responsibilities, in order of execution:
 *   1. Bootstrap the UI theme, the active locale and any persisted state.
 *   2. Keep form controls, theme presets and column ordering in sync.
 *   3. Translate the form into a canonical `/api/badge` query string.
 *   4. Render the preview, and expose the embeddable snippet, share link and
 *      SVG download.
 *
 * All state lives in `localStorage` under namespaced keys, and the badge URL
 * itself is mirrored into `location.hash` so any configuration can be shared
 * or bookmarked without a backend round-trip.
 *
 * The file is a classic script (not a module) so `index.html` keeps working
 * when opened directly from disk, where ES module loading is blocked by CORS.
 */
(() => {
    'use strict';

    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    const i18n = window.__I18N;
    const STORAGE_KEYS = {
        config: 'badge-generator:config:v2',
        language: 'badge-generator:lang',
        uiTheme: 'badge-generator:ui-theme'
    };

    const PROJECT_URL = 'https://github.com/readme-SVG/readme-pr-contributors-rating';
    const BADGE_ENDPOINT = `${window.location.origin}/api/badge`;

    /** Upper bound for the preview request before it is reported as failed. */
    const PREVIEW_TIMEOUT_MS = 15000;
    /** Duration of the transient "Copied!" confirmation. */
    const COPY_FEEDBACK_MS = 2000;

    /** Server-side defaults; only deviations are serialised into the URL. */
    const DEFAULTS = {
        username: 'OstinUA',
        limit: '7',
        badgeWidth: '830',
        rowHeight: '40',
        repoWidth: '180',
        langWidth: '80',
        prWidth: '320',
        dateWidth: '90',
        changesWidth: '100',
        starsWidth: '60',
        previewHeight: '220',
        repoNameFormat: 'full',
        sort: 'stars',
        order: 'desc',
        themePreset: 'dark'
    };

    const NUMERIC_FIELDS = ['limit', 'badgeWidth', 'rowHeight', 'repoWidth', 'langWidth', 'prWidth', 'dateWidth', 'changesWidth', 'starsWidth'];

    /**
     * Badge palettes. Kept in sync with `THEME_PRESETS` in `lib/constants.js`;
     * the duplication is deliberate so the configurator keeps working when the
     * API is unavailable.
     */
    const THEME_PRESETS = {
        dark: { bg: '0d1117', text: 'c9d1d9', title: '58a6ff', muted: '8b949e', star: 'e3b341', border: '30363d', shadow: '000000' },
        light: { bg: 'ffffff', text: '24292f', title: '0969da', muted: '57606a', star: 'bf8700', border: 'd0d7de', shadow: '000000' },
        dimmed: { bg: '22272e', text: 'adbac7', title: '539bf5', muted: '768390', star: 'd29922', border: '444c56', shadow: '000000' },
        night: { bg: '0b1320', text: 'd8e5ff', title: '4ea1ff', muted: '89a4d6', star: 'ffd166', border: '1d3557', shadow: '000000' },
        transparent: { bg: '000000', text: 'ffffff', title: 'ffffff', muted: 'd1d5db', star: 'ffd166', border: '000000', shadow: '000000', transparent: true }
    };

    const COLOR_NAMES = ['bg', 'text', 'title', 'muted', 'star', 'border', 'shadow'];
    const COLUMN_LABEL_KEYS = {
        pr: 'showPullsLabel',
        date: 'showDateLabel',
        lang: 'showLangLabel',
        changes: 'showChangesLabel'
    };
    const COLUMN_KEYS = ['pr', 'date', 'lang', 'changes'];

    /** Maps a query parameter to the form element that owns it. */
    const PARAM_TO_FIELD = {
        username: 'username',
        limit: 'limit',
        custom_title: 'customTitle',
        repo_name_format: 'repoNameFormat',
        sort: 'sort',
        order: 'order',
        theme: 'themePreset',
        since: 'since',
        until: 'until'
    };

    /** Maps a numeric query parameter onto its form element. */
    const PARAM_TO_NUMERIC_FIELD = {
        badge_width: 'badgeWidth',
        row_height: 'rowHeight',
        repo_width: 'repoWidth',
        lang_width: 'langWidth',
        pr_width: 'prWidth',
        date_width: 'dateWidth',
        changes_width: 'changesWidth',
        stars_width: 'starsWidth'
    };

    const $ = (id) => document.getElementById(id);

    // Fail fast when a locale bundle is broken or drifted from the schema.
    window.validateI18nIntegrity();

    // -----------------------------------------------------------------------
    // Localisation helpers
    // -----------------------------------------------------------------------

    let currentLang = 'en';

    /** Translate a key for the active locale, falling back to English. */
    function t(key) {
        return i18n[currentLang]?.[key] ?? i18n.en?.[key] ?? key;
    }

    // -----------------------------------------------------------------------
    // UI chrome theme
    // -----------------------------------------------------------------------

    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;

    function initUiTheme() {
        const saved = localStorage.getItem(STORAGE_KEYS.uiTheme);
        const theme = saved === 'dark' || saved === 'light' ? saved : prefersDark ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', theme);
    }

    function toggleUiTheme() {
        const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
        const next = current === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem(STORAGE_KEYS.uiTheme, next);
    }

    // -----------------------------------------------------------------------
    // Column ordering
    // -----------------------------------------------------------------------

    let columnOrderState = COLUMN_KEYS.map((key) => ({ key, enabled: key === 'pr' || key === 'date' }));

    function moveColumn(key, direction) {
        const index = columnOrderState.findIndex((item) => item.key === key);
        const target = index + direction;
        if (index < 0 || target < 0 || target >= columnOrderState.length) return;
        const [item] = columnOrderState.splice(index, 1);
        columnOrderState.splice(target, 0, item);
        renderColumnOrderList();
    }

    function renderColumnOrderList() {
        const list = $('columnOrderList');
        list.textContent = '';

        columnOrderState.forEach((item, index) => {
            const row = document.createElement('div');
            row.className = 'column-order-item';

            const left = document.createElement('div');
            left.className = 'checkbox-row';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.id = `col-${item.key}`;
            checkbox.checked = item.enabled;
            checkbox.addEventListener('change', (event) => {
                item.enabled = event.target.checked;
                saveConfig();
            });

            const label = document.createElement('label');
            label.setAttribute('for', checkbox.id);
            label.textContent = t(COLUMN_LABEL_KEYS[item.key] ?? item.key);

            left.append(checkbox, label);

            const actions = document.createElement('div');
            actions.className = 'order-actions';

            const upButton = document.createElement('button');
            upButton.type = 'button';
            upButton.className = 'order-btn';
            upButton.textContent = '▲';
            upButton.disabled = index === 0;
            upButton.setAttribute('aria-label', `${item.key}: ${t('moveUpLabel')}`);
            upButton.addEventListener('click', () => moveColumn(item.key, -1));

            const downButton = document.createElement('button');
            downButton.type = 'button';
            downButton.className = 'order-btn';
            downButton.textContent = '▼';
            downButton.disabled = index === columnOrderState.length - 1;
            downButton.setAttribute('aria-label', `${item.key}: ${t('moveDownLabel')}`);
            downButton.addEventListener('click', () => moveColumn(item.key, 1));

            actions.append(upButton, downButton);
            row.append(left, actions);
            list.appendChild(row);
        });
    }

    // -----------------------------------------------------------------------
    // Language switching
    // -----------------------------------------------------------------------

    function switchLanguage(lang) {
        if (!i18n[lang]) return;
        currentLang = lang;
        localStorage.setItem(STORAGE_KEYS.language, lang);
        document.documentElement.setAttribute('lang', lang);
        document.title = t('title');
        document.querySelectorAll('[data-i18n]').forEach((element) => {
            const key = element.getAttribute('data-i18n');
            const value = i18n[lang]?.[key];
            if (value) element.textContent = value;
        });
        renderColumnOrderList();
    }

    // -----------------------------------------------------------------------
    // Badge colours and theme presets
    // -----------------------------------------------------------------------

    function setColor(name, value) {
        $(`${name}Color`).value = value;
        $(`${name}ColorPicker`).value = `#${value}`;
    }

    /** Expand `#abc` / `abc` into the 6 digit form required by the inputs. */
    function expandHex(value) {
        const cleaned = String(value ?? '').trim().replace(/^#/, '');
        if (/^[a-fA-F0-9]{3}$/.test(cleaned)) {
            return cleaned
                .split('')
                .map((char) => char + char)
                .join('')
                .toLowerCase();
        }
        return /^[a-fA-F0-9]{6}$/.test(cleaned) ? cleaned.toLowerCase() : null;
    }

    function applyThemePreset(name) {
        const preset = THEME_PRESETS[name];
        if (!preset) return;
        COLOR_NAMES.forEach((color) => setColor(color, preset[color] ?? '000000'));
        $('previewArea').classList.toggle('checkerboard', Boolean(preset.transparent));
    }

    function setupColorSync(name) {
        const picker = $(`${name}ColorPicker`);
        const hex = $(`${name}Color`);

        const markCustom = () => {
            $('themePreset').value = 'custom';
            $('previewArea').classList.remove('checkerboard');
        };

        picker.addEventListener('input', () => {
            hex.value = picker.value.replace('#', '').toLowerCase();
            markCustom();
        });
        hex.addEventListener('input', () => {
            const normalized = hex.value.replace(/[^a-fA-F0-9]/g, '').slice(0, 6).toLowerCase();
            hex.value = normalized;
            if (normalized.length === 6) picker.value = `#${normalized}`;
            markCustom();
        });
    }

    // -----------------------------------------------------------------------
    // Persistence
    // -----------------------------------------------------------------------

    const CONFIG_FIELDS = [
        'username', 'limit', 'customTitle', 'repoNameFormat', 'themePreset',
        'repoWidth', 'langWidth', 'prWidth', 'dateWidth', 'changesWidth',
        'starsWidth', 'badgeWidth', 'rowHeight', 'previewHeight',
        'sort', 'order', 'since', 'until'
    ];

    const CONFIG_CHECKBOXES = ['uniqueRepos', 'showRejected', 'showRank'];

    function collectConfig() {
        const config = {};
        CONFIG_FIELDS.forEach((field) => {
            config[field] = $(field).value;
        });
        COLOR_NAMES.forEach((color) => {
            config[`${color}Color`] = $(`${color}Color`).value;
        });
        CONFIG_CHECKBOXES.forEach((field) => {
            config[field] = $(field).checked;
        });
        config.columns = columnOrderState.map((item) => ({ ...item }));
        return config;
    }

    function applyConfig(config) {
        if (!config || typeof config !== 'object') return;

        CONFIG_FIELDS.forEach((field) => {
            const value = config[field];
            if (typeof value === 'string' || typeof value === 'number') $(field).value = String(value);
        });
        COLOR_NAMES.forEach((color) => {
            const expanded = expandHex(config[`${color}Color`]);
            if (expanded) setColor(color, expanded);
        });
        CONFIG_CHECKBOXES.forEach((field) => {
            $(field).checked = Boolean(config[field]);
        });

        if (Array.isArray(config.columns) && config.columns.length === COLUMN_KEYS.length) {
            const known = new Set(COLUMN_KEYS);
            const restored = config.columns.filter((item) => item && known.has(item.key));
            if (new Set(restored.map((item) => item.key)).size === known.size) {
                columnOrderState = restored.map((item) => ({ key: item.key, enabled: Boolean(item.enabled) }));
            }
        }

        applyThemePreset($('themePreset').value);
        updatePreviewWindowSize();
    }

    function saveConfig() {
        try {
            localStorage.setItem(STORAGE_KEYS.config, JSON.stringify(collectConfig()));
        } catch {
            // Storage may be unavailable (private mode, quota exceeded).
            // Persistence is a convenience, so failures are non-fatal.
        }
    }

    function restoreConfig() {
        try {
            const raw = localStorage.getItem(STORAGE_KEYS.config);
            if (raw) applyConfig(JSON.parse(raw));
        } catch {
            localStorage.removeItem(STORAGE_KEYS.config);
        }
    }

    // -----------------------------------------------------------------------
    // Badge URL construction
    // -----------------------------------------------------------------------

    /** Clamp a numeric input into its declared `min` / `max` bounds. */
    function readNumeric(id) {
        const element = $(id);
        const parsed = Number.parseInt(element.value, 10);
        const fallback = Number.parseInt(element.defaultValue, 10);
        const min = Number.parseInt(element.min, 10);
        const max = Number.parseInt(element.max, 10);
        const resolved = Number.isFinite(parsed) ? parsed : fallback;
        return String(Math.min(max, Math.max(min, resolved)));
    }

    /**
     * Build the canonical query string for the current form state.
     * Values equal to the server defaults are omitted, so a badge URL stays
     * short and human-readable.
     *
     * @returns {URLSearchParams}
     */
    function buildBadgeParams() {
        const enabled = Object.fromEntries(columnOrderState.map((item) => [item.key, item.enabled]));
        const params = new URLSearchParams();

        params.set('username', $('username').value.trim() || DEFAULTS.username);

        if (readNumeric('limit') !== DEFAULTS.limit) params.set('limit', readNumeric('limit'));
        if ($('sort').value !== DEFAULTS.sort) params.set('sort', $('sort').value);
        if ($('order').value !== DEFAULTS.order) params.set('order', $('order').value);

        if (!enabled.pr) params.set('show_pr', 'false');
        if (!enabled.date) params.set('show_date', 'false');
        if (enabled.lang) params.set('show_lang', 'true');
        if (enabled.changes) params.set('show_changes', 'true');
        if ($('showRank').checked) params.set('show_rank', 'true');
        if ($('uniqueRepos').checked) params.set('unique_repos', 'true');
        if ($('showRejected').checked) params.set('show_rejected', 'true');
        if ($('repoNameFormat').value !== DEFAULTS.repoNameFormat) {
            params.set('repo_name_format', $('repoNameFormat').value);
        }

        const order = columnOrderState.map((item) => item.key).join(',');
        if (order !== COLUMN_KEYS.join(',')) params.set('col_order', order);

        NUMERIC_FIELDS.slice(1).forEach((field) => {
            const param = field.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
            const value = readNumeric(field);
            if (value !== DEFAULTS[field]) params.set(param, value);
        });

        const customTitle = $('customTitle').value.trim();
        if (customTitle) params.set('custom_title', customTitle);

        const since = $('since').value;
        const until = $('until').value;
        if (since) params.set('since', since);
        if (until) params.set('until', until);

        const themeName = $('themePreset').value;
        const preset = THEME_PRESETS[themeName];
        if (preset) {
            if (themeName !== DEFAULTS.themePreset) params.set('theme', themeName);
            if (preset.transparent) params.set('transparent', 'true');
        }
        // For a custom palette the colours are always serialised explicitly.
        COLOR_NAMES.forEach((color) => {
            const value = $(`${color}Color`).value;
            if (!preset || value !== preset[color]) params.set(`${color}_color`, value);
        });

        return params;
    }

    /** Absolute badge URL for the current form state. */
    function buildBadgeUrl() {
        return `${BADGE_ENDPOINT}?${buildBadgeParams().toString()}`;
    }

    /**
     * Validate the date filters. An inverted range is a client-side mistake we
     * can explain precisely, so it never reaches the API.
     */
    function validateFilters() {
        const since = $('since').value;
        const until = $('until').value;
        if (since && until && since > until) {
            showPreviewError('errorDateRange');
            return false;
        }
        return true;
    }

    // -----------------------------------------------------------------------
    // Preview, snippet and downloads
    // -----------------------------------------------------------------------

    let currentBadgeUrl = null;
    /** Monotonic id of the newest preview request; stale probes are ignored. */
    let previewRequestId = 0;

    function clearPreviewError() {
        $('previewError')?.remove();
    }

    function showPreviewError(key = 'errorFetch') {
        clearPreviewError();
        const error = document.createElement('div');
        error.className = 'error-msg';
        error.id = 'previewError';
        error.setAttribute('role', 'alert');
        error.textContent = t(key);
        $('previewArea').appendChild(error);
    }

    /** Build the embeddable snippet for the selected output format. */
    function buildSnippet(url) {
        const alt = $('customTitle').value.trim() || `Top PRs by ${$('username').value.trim() || DEFAULTS.username}`;
        const escapedAlt = alt.replace(/"/g, '&quot;');
        switch ($('snippetFormat').value) {
            case 'html':
                return `<a href="${PROJECT_URL}"><img src="${url}" alt="${escapedAlt}"></a>`;
            case 'url':
                return url;
            case 'markdown':
            default:
                return `[![${alt}](${url})](${PROJECT_URL})`;
        }
    }

    function refreshSnippet() {
        if (!currentBadgeUrl) return;
        $('markdownCode').textContent = buildSnippet(currentBadgeUrl);
    }

    /** Mirror the current configuration into `location.hash`. */
    function syncUrlHash(params) {
        const hash = params.toString();
        try {
            history.replaceState(null, '', hash ? `#${hash}` : window.location.pathname);
        } catch {
            // `replaceState` can be blocked in sandboxed frames; harmless.
        }
    }

    function generate() {
        if (!validateFilters()) return;

        const params = buildBadgeParams();
        const url = `${BADGE_ENDPOINT}?${params.toString()}`;
        const badge = $('badge');
        const spinner = $('spinner');
        const placeholder = $('previewPlaceholder');
        const button = $('generateBtn');

        badge.style.display = 'none';
        placeholder.style.display = 'none';
        spinner.style.display = 'block';
        button.disabled = true;
        clearPreviewError();

        currentBadgeUrl = url;
        refreshSnippet();
        $('copyBtn').disabled = false;
        $('downloadBtn').disabled = false;
        $('shareBtn').disabled = false;

        // Load into a detached image first so a failing request never leaves a
        // broken image in the preview. The cache-buster ensures the preview
        // reflects freshly generated server-side data on every regeneration.
        const requestId = (previewRequestId += 1);
        let timeoutId = 0;

        const settle = (loaded) => () => {
            // A slow earlier request must not overwrite a newer one.
            if (requestId !== previewRequestId) return;
            clearTimeout(timeoutId);

            if (loaded) {
                badge.src = probe.src;
                badge.style.display = 'block';
            } else {
                placeholder.style.display = 'inline';
                showPreviewError();
            }
            spinner.style.display = 'none';
            button.disabled = false;
        };

        const probe = new Image();
        probe.addEventListener('load', settle(true));
        probe.addEventListener('error', settle(false));

        // Watchdog: a request that neither resolves nor fails must not pin the
        // UI to the spinner and leave the button disabled forever.
        timeoutId = setTimeout(settle(false), PREVIEW_TIMEOUT_MS);
        probe.src = `${url}&_=${Date.now()}`;

        syncUrlHash(params);
        saveConfig();
    }

    /** Copy text using the async Clipboard API with a legacy fallback. */
    async function copyText(text) {
        if (navigator.clipboard && window.isSecureContext) {
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch {
                // Fall through to the legacy path.
            }
        }
        const scratch = document.createElement('textarea');
        scratch.value = text;
        scratch.setAttribute('readonly', '');
        scratch.style.position = 'fixed';
        scratch.style.opacity = '0';
        document.body.appendChild(scratch);
        scratch.select();
        let copied = false;
        try {
            copied = document.execCommand('copy');
        } catch {
            copied = false;
        }
        scratch.remove();
        return copied;
    }

    /** Flash a transient confirmation label on a button. */
    function flashLabel(button, labelKey) {
        const label = button.querySelector('[data-i18n]');
        if (!label) return;
        const original = label.textContent;
        label.textContent = t(labelKey);
        button.classList.add('copied');
        setTimeout(() => {
            label.textContent = original;
            button.classList.remove('copied');
        }, COPY_FEEDBACK_MS);
    }

    async function copySnippet() {
        const text = $('markdownCode').textContent;
        if (!text || text === '-') return;
        if (await copyText(text)) flashLabel($('copyBtn'), 'copiedBtn');
    }

    /** Copy the shareable configurator URL (configuration in the hash). */
    async function shareConfiguration() {
        const params = buildBadgeParams();
        const shareUrl = `${window.location.origin}${window.location.pathname}#${params.toString()}`;
        if (await copyText(shareUrl)) flashLabel($('shareBtn'), 'copiedBtn');
    }

    async function downloadSvg() {
        const badgeSrc = $('badge').style.display !== 'none' ? $('badge').src : '';
        const targetUrl = badgeSrc || currentBadgeUrl;
        if (!targetUrl) return;
        try {
            const response = await fetch(targetUrl);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const blob = await response.blob();
            const objectUrl = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = objectUrl;
            anchor.download = `top-pr-contributions-${$('username').value.trim() || 'badge'}.svg`;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            URL.revokeObjectURL(objectUrl);
        } catch {
            showPreviewError();
        }
    }

    // -----------------------------------------------------------------------
    // Preview window sizing
    // -----------------------------------------------------------------------

    function updatePreviewWindowSize() {
        const parsed = Number.parseInt($('previewHeight').value, 10);
        const height = Number.isFinite(parsed) ? Math.min(580, Math.max(120, parsed)) : 220;
        $('previewArea').style.minHeight = `${height}px`;
    }

    // -----------------------------------------------------------------------
    // Hash state (shareable / bookmarkable configurations)
    // -----------------------------------------------------------------------

    /** Apply persisted query parameters from `location.hash` onto the form. */
    function applyHashState() {
        const raw = window.location.hash.replace(/^#\??/, '');
        if (!raw) return false;
        const params = new URLSearchParams(raw);

        for (const [param, field] of Object.entries(PARAM_TO_FIELD)) {
            const value = params.get(param);
            if (value !== null) $(field).value = value;
        }
        for (const [param, field] of Object.entries(PARAM_TO_NUMERIC_FIELD)) {
            const value = params.get(param);
            if (value !== null && /^\d+$/.test(value)) $(field).value = value;
        }

        for (const key of COLUMN_KEYS) {
            const flag = params.get(`show_${key}`);
            if (flag !== null) {
                columnOrderState = columnOrderState.map((item) =>
                    item.key === key ? { ...item, enabled: flag === 'true' } : item
                );
            }
        }

        const columnOrder = params.get('col_order');
        if (columnOrder) {
            const seen = new Set();
            const restored = columnOrder
                .split(',')
                .map((key) => key.trim())
                .filter((key) => COLUMN_KEYS.includes(key) && !seen.has(key) && Boolean(seen.add(key)))
                .map((key) => columnOrderState.find((item) => item.key === key) ?? { key, enabled: true });
            if (restored.length === COLUMN_KEYS.length) columnOrderState = restored;
        }

        CONFIG_CHECKBOXES.forEach((field) => {
            const param = field.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
            const value = params.get(param);
            if (value !== null) $(field).checked = value === 'true';
        });

        // Resolve the palette: a presets first, then explicit overrides on top.
        if (THEME_PRESETS[$('themePreset').value]) applyThemePreset($('themePreset').value);
        if (params.get('transparent') === 'true' && !params.get('theme')) {
            $('themePreset').value = 'transparent';
            applyThemePreset('transparent');
        }

        const basePreset = THEME_PRESETS[$('themePreset').value];
        const overrides = COLOR_NAMES.map((color) => [color, expandHex(params.get(`${color}_color`) ?? '')]).filter(
            ([, value]) => Boolean(value)
        );
        if (overrides.length > 0) {
            const deviates = overrides.some(([color, value]) => !basePreset || value !== basePreset[color]);
            overrides.forEach(([color, value]) => setColor(color, value));
            if (deviates) $('themePreset').value = 'custom';
        }

        renderColumnOrderList();
        return true;
    }

    // -----------------------------------------------------------------------
    // Reset
    // -----------------------------------------------------------------------

    function resetConfiguration() {
        CONFIG_FIELDS.forEach((field) => {
            const element = $(field);
            element.value = element.defaultValue;
        });
        CONFIG_CHECKBOXES.forEach((field) => {
            $(field).checked = $(field).defaultChecked;
        });
        columnOrderState = COLUMN_KEYS.map((key) => ({ key, enabled: key === 'pr' || key === 'date' }));
        renderColumnOrderList();
        applyThemePreset($('themePreset').value);
        updatePreviewWindowSize();
        clearPreviewError();
        saveConfig();
        syncUrlHash(buildBadgeParams());
        $('markdownCode').textContent = '-';
        $('badge').style.display = 'none';
        $('badge').removeAttribute('src');
        $('previewPlaceholder').style.display = 'inline';
        $('copyBtn').disabled = true;
        $('downloadBtn').disabled = true;
        $('shareBtn').disabled = true;
        currentBadgeUrl = null;
    }

    // -----------------------------------------------------------------------
    // Wiring
    // -----------------------------------------------------------------------

    function init() {
        initUiTheme();

        const savedLang = localStorage.getItem(STORAGE_KEYS.language);
        $('langSelect').value = i18n[savedLang] ? savedLang : 'en';

        COLOR_NAMES.forEach(setupColorSync);
        restoreConfig();
        switchLanguage($('langSelect').value);

        $('themeToggle').addEventListener('click', toggleUiTheme);
        $('langSelect').addEventListener('change', (event) => switchLanguage(event.target.value));
        $('themePreset').addEventListener('change', (event) => {
            applyThemePreset(event.target.value);
            saveConfig();
        });
        $('generateBtn').addEventListener('click', generate);
        $('resetBtn').addEventListener('click', resetConfiguration);
        $('copyBtn').addEventListener('click', copySnippet);
        $('shareBtn').addEventListener('click', shareConfiguration);
        $('downloadBtn').addEventListener('click', downloadSvg);
        $('snippetFormat').addEventListener('change', refreshSnippet);
        $('previewHeight').addEventListener('input', updatePreviewWindowSize);

        // Persist the configuration whenever any control settles, so a reload
        // never loses work in progress.
        document.querySelectorAll('.panel input, .panel select').forEach((element) => {
            element.addEventListener('change', saveConfig);
        });

        // Enter inside a text input regenerates the badge.
        document.querySelectorAll('.panel input[type="text"], .panel input[type="number"]').forEach((element) => {
            element.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    generate();
                }
            });
        });

        // A shared link always wins over the persisted configuration.
        if (applyHashState()) generate();
    }

    init();
})();

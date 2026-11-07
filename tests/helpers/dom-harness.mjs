/**
 * Headless execution harness for the configurator controller.
 *
 * The controller is a classic browser script, which no bundler or type checker
 * validates. Rather than pull a full DOM implementation into a deliberately
 * dependency-free repository, this harness provides the small subset of the
 * platform API that `assets/app.js` actually touches. It lets the test suite
 * boot the controller, click "Generate Badge" and assert on the resulting URL
 * and markup, which is exactly where template mistakes would surface.
 */

/** A minimal element double: properties, attributes and listeners. */
function createElement(tagName = 'div') {
    const listeners = new Map();
    const element = {
        tagName: tagName.toUpperCase(),
        id: '',
        value: '',
        defaultValue: '',
        min: '',
        max: '',
        checked: false,
        defaultChecked: false,
        disabled: false,
        style: {},
        textContent: '',
        children: [],
        attributes: {},
        classList: {
            _set: new Set(),
            add(name) {
                this._set.add(name);
            },
            remove(name) {
                this._set.delete(name);
            },
            toggle(name, force) {
                const shouldAdd = force ?? !this._set.has(name);
                if (shouldAdd) this._set.add(name);
                else this._set.delete(name);
                return shouldAdd;
            },
            contains(name) {
                return this._set.has(name);
            }
        },
        addEventListener(type, handler) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(handler);
        },
        removeEventListener(type, handler) {
            const bucket = listeners.get(type) ?? [];
            listeners.set(
                type,
                bucket.filter((entry) => entry !== handler)
            );
        },
        dispatch(type, event = {}) {
            for (const handler of listeners.get(type) ?? []) handler({ target: element, ...event });
        },
        setAttribute(name, value) {
            this.attributes[name] = String(value);
        },
        getAttribute(name) {
            return this.attributes[name] ?? null;
        },
        append(...nodes) {
            this.children.push(...nodes);
        },
        appendChild(node) {
            this.children.push(node);
            return node;
        },
        remove() {
            this.removed = true;
            for (const [id, element] of Object.entries(this.ownerIndex ?? {})) {
                if (element === this) delete this.ownerIndex[id];
            }
        },
        removeAttribute(name) {
            delete this.attributes[name];
        },
        set ownerIndex(index) {
            this._ownerIndex = index;
        },
        get ownerIndex() {
            return this._ownerIndex;
        },
        querySelector() {
            return null;
        },
        select() {},
        focus() {},
        click() {
            this.dispatch('click');
        }
    };
    return element;
}

/**
 * Build a sandbox in which `assets/app.js` can be evaluated.
 *
 * @param {object} options Harness options.
 * @param {string} options.source Controller source code.
 * @param {Record<string, object>} options.locales Locale dictionaries.
 * @param {object[]} options.formState Declarative form field definitions.
 * @param {string} [options.hash] Initial `location.hash` value.
 * @returns {{ window: object, document: object, storage: Map<string, string>, fetchCalls: string[] }}
 */
export function runController({ source, locales, formState, hash = '' }) {
    const storage = new Map();
    const fetchCalls = [];
    const elements = new Map();
    const panelElements = [];

    for (const definition of formState) {
        const element = createElement(definition.tagName);
        Object.assign(element, definition);
        elements.set(definition.id, element);
        panelElements.push(element);
    }

    // Preview surface and controls created or toggled by the controller.
    for (const id of [
        'badge',
        'spinner',
        'previewPlaceholder',
        'previewArea',
        'markdownCode',
        'columnOrderList',
        'showLang',
        'showRank',
        'uniqueRepos',
        'showRejected'
    ]) {
        if (!elements.has(id)) elements.set(id, createElement('div'));
    }
    elements.get('previewArea').classList = createElement().classList;

    const document = {
        documentElement: createElement('html'),
        title: '',
        body: createElement('body'),
        getElementById: (id) => elements.get(id) ?? null,
        createElement: (tagName) => createElement(tagName),
        querySelectorAll: (selector) => (selector.includes('.panel') ? panelElements : []),
        execCommand: () => true
    };

    const i18n = { __I18N: locales, __I18N_REQUIRED_KEYS: [], validateI18nIntegrity() {} };

    const window = {
        __I18N: locales,
        validateI18nIntegrity() {},
        location: { origin: 'https://badge.test', pathname: '/', hash },
        history: {
            replaceState(_state, _title, url) {
                window.location.hash = String(url).startsWith('#') ? String(url) : '';
            }
        },
        localStorage: {
            getItem: (key) => (storage.has(key) ? storage.get(key) : null),
            setItem: (key, value) => storage.set(key, String(value)),
            removeItem: (key) => storage.delete(key)
        },
        matchMedia: () => ({ matches: false }),
        isSecureContext: false,
        setTimeout: () => 0,
        clearTimeout: () => {},
        navigator: { clipboard: null },
        Image: class {
            constructor() {
                this.listeners = {};
            }
            addEventListener(type, handler) {
                this.listeners[type] = handler;
            }
            set src(value) {
                this._src = value;
                fetchCalls.push(value);
            }
            get src() {
                return this._src;
            }
        },
        fetch: async () => ({ ok: true, blob: async () => 'blob' }),
        URL,
        URLSearchParams
    };

    // The controller is an IIFE that closes over the globals it needs.
    const factory = new Function(
        'window',
        'document',
        'localStorage',
        'navigator',
        'history',
        'location',
        'Image',
        'fetch',
        'setTimeout',
        'clearTimeout',
        'URL',
        'URLSearchParams',
        'window_',
        `${source}`
    );

    factory(
        window,
        document,
        window.localStorage,
        window.navigator,
        window.history,
        window.location,
        window.Image,
        window.fetch,
        window.setTimeout,
        window.clearTimeout,
        URL,
        URLSearchParams,
        window
    );

    return { window, document, storage, fetchCalls, elements, i18n };
}

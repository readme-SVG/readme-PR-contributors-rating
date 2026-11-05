window.__I18N = window.__I18N || {};

/**
 * Canonical key set every locale must implement, exactly. The integrity check
 * below rejects both missing and unexpected keys so locales can never drift
 * apart silently. Keep in sync with the `data-i18n` attributes in index.html.
 */
window.__I18N_REQUIRED_KEYS = [
  'title',
  'configTitle',
  'previewTitle',
  'usernameLabel',
  'limitLabel',
  'showPullsLabel',
  'showDateLabel',
  'showLangLabel',
  'showChangesLabel',
  'showRejectedLabel',
  'columnOrderLabel',
  'uniqueReposLabel',
  'repoNameFormatLabel',
  'repoNameFormatFull',
  'repoNameFormatShort',
  'themeLabel',
  'repoWidthLabel',
  'langWidthLabel',
  'prWidthLabel',
  'dateWidthLabel',
  'changesWidthLabel',
  'starsWidthLabel',
  'badgeWidthLabel',
  'rowHeightLabel',
  'customTitleLabel',
  'previewHeightLabel',
  'bgColorLabel',
  'textColorLabel',
  'titleColorLabel',
  'mutedColorLabel',
  'starColorLabel',
  'borderColorLabel',
  'shadowColorLabel',
  'generateBtn',
  'previewPlaceholder',
  'markdownLabel',
  'downloadBtn',
  'copyBtn',
  'copiedBtn',
  'errorFetch',
  'footerDocs',
  'footerIssue'
];

window.validateI18nIntegrity = function validateI18nIntegrity() {
  const locales = window.__I18N;
  const required = window.__I18N_REQUIRED_KEYS;
  const localeCodes = Object.keys(locales);

  if (!localeCodes.length) {
    throw new Error('No i18n locales loaded.');
  }

  for (const code of localeCodes) {
    const data = locales[code];
    for (const key of required) {
      if (!(key in data)) {
        throw new Error(`Missing i18n key "${key}" in locale "${code}".`);
      }
      if (typeof data[key] !== 'string' || !data[key].trim()) {
        throw new Error(`Empty i18n value for key "${key}" in locale "${code}".`);
      }
    }

    const extra = Object.keys(data).filter((k) => !required.includes(k));
    if (extra.length) {
      throw new Error(`Unexpected i18n keys in locale "${code}": ${extra.join(', ')}`);
    }
  }
};


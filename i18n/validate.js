window.__I18N = window.__I18N || {};
window.__I18N_REQUIRED_KEYS = [
  'title',
  'configTitle',
  'previewTitle',
  'usernameLabel',
  'limitLabel',
  'showPullsLabel',
  'showDateLabel',
  'showRepoLabel',
  'themeLabel',
  'badgeWidthLabel',
  'rowHeightLabel',
  'previewHeightLabel',
  'bgColorLabel',
  'textColorLabel',
  'titleColorLabel',
  'mutedColorLabel',
  'starColorLabel',
  'borderColorLabel',
  'generateBtn',
  'previewPlaceholder',
  'markdownLabel',
  'copyBtn',
  'copiedBtn',
  'errorFetch'
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
    }

    const extra = Object.keys(data).filter((k) => !required.includes(k));
    if (extra.length) {
      throw new Error(`Unexpected i18n keys in locale "${code}": ${extra.join(', ')}`);
    }
  }
};

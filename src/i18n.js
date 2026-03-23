const fs = require('fs');
const path = require('path');

const localesDir = path.join(__dirname, 'locales');
const translations = {};
const SUPPORTED_LANGS = ['en', 'pt', 'es', 'fr', 'de', 'zh', 'ja'];

for (const lang of SUPPORTED_LANGS) {
  const filePath = path.join(localesDir, `${lang}.json`);
  if (fs.existsSync(filePath)) {
    translations[lang] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }
}

function t(lang, key, params = {}) {
  const str = translations[lang]?.[key] || translations['en']?.[key] || key;
  return str.replace(/\{\{(\w+)\}\}/g, (_, k) => params[k] ?? '');
}

module.exports = { t, SUPPORTED_LANGS };

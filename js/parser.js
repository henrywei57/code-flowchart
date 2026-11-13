// Parsing entry point. Maps a language to the parser that turns its source
// code into the language-neutral outline (see js/outline.js).
//
// To add a language: implement `parseX(source) -> Outline` in js/languages/,
// then register it in LANGUAGES below with the file extensions it handles.

import { parseJavaScript } from './languages/javascript.js';
import { CodeParseError } from './outline.js';

export { CodeParseError };

export const LANGUAGES = {
  javascript: {
    label: 'JavaScript',
    extensions: ['.js', '.mjs', '.cjs'],
    parse: parseJavaScript,
  },
};

/** Language id for a file path, or null if unsupported. */
export function languageForPath(path) {
  const lower = path.toLowerCase();
  for (const [id, lang] of Object.entries(LANGUAGES)) {
    if (lang.extensions.some((ext) => lower.endsWith(ext))) return id;
  }
  return null;
}

export function supportedExtensions() {
  return Object.values(LANGUAGES).flatMap((l) => l.extensions);
}

/**
 * Parse source code into an outline.
 * @param {string} source
 * @param {{ language?: string }} [options]
 * @returns {import('./outline.js').Outline}
 */
export function parseSource(source, { language = 'javascript' } = {}) {
  const lang = LANGUAGES[language];
  if (!lang) throw new CodeParseError(`Unsupported language: ${language}`);
  if (!source.trim()) throw new CodeParseError('There is no code to analyze yet.');
  return lang.parse(source);
}

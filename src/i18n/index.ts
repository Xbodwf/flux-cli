/**
 * Flux internationalization module.
 *
 * Supports English and Chinese. Auto-detects from LANG env var.
 * Use `t(key, params)` to get translated strings throughout the codebase.
 */
import en, { type Locale } from './en.js';
import zh from './zh.js';

let currentLocale: string = 'en';
let strings: Locale = en;

const locales: Record<string, Locale> = { en, zh };

/**
 * Detect locale from LANG environment variable.
 */
export function detectLocale(): string {
  const lang = process.env.LANG || '';
  if (lang.startsWith('zh')) return 'zh';
  return 'en';
}

/**
 * Set the current locale.
 */
export function setLocale(locale: string): void {
  if (locales[locale]) {
    currentLocale = locale;
    strings = locales[locale]!;
  }
}

/**
 * Get the current locale name.
 */
export function getLocale(): string {
  return currentLocale;
}

/**
 * Translate a key with optional parameter substitution.
 *
 * Parameters use {name} syntax in the translation string.
 *
 * Examples:
 *   t('provider.key_prompt', { name: 'Anthropic' })
 *   t('cmd.unknown', { cmd: '/foo' })
 *   t('repl.goodbye')
 */
export function t(key: string, params?: Record<string, string | number>): string {
  let str = (strings as Record<string, string>)[key];
  if (str === undefined) {
    str = (en as Record<string, string>)[key] || key;
  }
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(`{${k}}`, String(v));
    }
  }
  return str;
}

/**
 * Placeholder indicator — marks strings as needing translation without
 * disrupting the code. At runtime this just calls t().
 *
 * Usage:
 *   _(provider.key_prompt)  →  t(provider.key_prompt)
 */
export const _ = t;

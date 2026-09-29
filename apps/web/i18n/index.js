/**
 * UTOPIA · Web Control Surface — i18n runtime.
 *
 * Scope: display copy only. This module never touches protocol fields, never
 * reconnects and never reloads the page. Supported locales are fixed to `en`
 * and `zh-CN`; anything else falls back to `en`.
 */

import en from './en.js';
import zhCN from './zh-CN.js';

export const SUPPORTED_LOCALES = ['en', 'zh-CN'];
export const DEFAULT_LOCALE = 'en';
export const LOCALE_STORAGE_KEY = 'utopia.ui.locale';

const PACKS = {
  en,
  'zh-CN': zhCN,
};

/** Runtime locale used when no storage is reachable (SSR / tests). */
let activeLocale = null;
/** Host objects used to detect the first-run locale; overridable for tests. */
let runtime = { storage: null, navigator: null };
const listeners = new Set();

/**
 * Point the runtime at a host environment. Tests use this to stay deterministic:
 * without it, a Node host with `navigator.language = zh-CN` would leak into
 * unrelated test files that share one process.
 */
export function configureRuntime({ storage, navigator: navigatorLike } = {}) {
  runtime = { storage: storage ?? null, navigator: navigatorLike ?? null };
  activeLocale = null;
}

function pack(locale) {
  return PACKS[locale] ?? PACKS[DEFAULT_LOCALE];
}

/** Normalize any incoming value to a supported locale token. */
export function normalizeLocale(value) {
  return SUPPORTED_LOCALES.includes(value) ? value : DEFAULT_LOCALE;
}

/**
 * First-run locale: `zh-CN` when the browser language starts with `zh`,
 * otherwise `en`. An unknown or unreadable stored value falls back to `en`.
 */
export function resolveInitialLocale(storage, navigatorLike) {
  let stored = null;
  try {
    stored = storage?.getItem?.(LOCALE_STORAGE_KEY) ?? null;
  } catch {
    stored = null;
  }
  if (stored !== null && stored !== undefined && stored !== '') return normalizeLocale(stored);
  const language = String(navigatorLike?.language ?? navigatorLike?.languages?.[0] ?? '');
  return language.toLowerCase().startsWith('zh') ? 'zh-CN' : DEFAULT_LOCALE;
}

/** The locale currently in effect. */
export function getLocale() {
  if (activeLocale) return activeLocale;
  activeLocale = resolveInitialLocale(runtime.storage, runtime.navigator);
  return activeLocale;
}

/** Every message key known to the runtime. */
export function messageKeys() {
  return Object.keys(PACKS[DEFAULT_LOCALE].messages);
}

/** Raw message table for a locale (used by tests and tooling). */
export function messagesFor(locale) {
  return { ...pack(normalizeLocale(locale)).messages };
}

/** Human label for a locale, e.g. "English" / "简体中文". */
export function localeLabel(locale) {
  return pack(normalizeLocale(locale)).meta.label;
}

/** Translate a key, substituting {placeholders}. Missing keys fall back to en. */
export function t(key, params) {
  const locale = getLocale();
  const primary = pack(locale).messages;
  const fallback = PACKS[DEFAULT_LOCALE].messages;
  const template = primary[key] ?? fallback[key];
  if (template === undefined) return key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  );
}

/** Locale-aware time formatting for ISO timestamps coming from the Gateway. */
export function formatTime(iso, locale = getLocale()) {
  const date = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso ?? '');
  return date.toLocaleTimeString(locale);
}

/** Apply the locale to a document: <html lang>, data-i18n text and attributes. */
export function applyTranslations(root = globalThis.document) {
  const locale = getLocale();
  if (!root) return locale;
  if (root.documentElement) root.documentElement.lang = locale;
  if (root.title !== undefined) root.title = t('app.title');
  for (const node of root.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const node of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of node.dataset.i18nAttr.split(',')) {
      const [attribute, key] = pair.split(':').map((part) => part.trim());
      if (attribute && key) node.setAttribute(attribute, t(key));
    }
  }
  return locale;
}

/** Subscribe to locale changes; returns an unsubscribe function. */
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Switch locale: persist it, apply static translations and notify listeners so
 * the caller can re-render. No reload and no reconnect happen here.
 */
export function setLocale(locale, { storage, root = globalThis.document } = {}) {
  const next = normalizeLocale(locale);
  activeLocale = next;
  try {
    (storage ?? runtime.storage)?.setItem?.(LOCALE_STORAGE_KEY, next);
  } catch {
    // a blocked storage must not break the switch
  }
  applyTranslations(root);
  for (const listener of listeners) listener(next);
  return next;
}

/** Test hook: drop the memoized runtime locale. */
export function resetLocaleCache() {
  activeLocale = null;
}

const api = {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  normalizeLocale,
  resolveInitialLocale,
  getLocale,
  setLocale,
  applyTranslations,
  subscribe,
  t,
  formatTime,
  messageKeys,
  messagesFor,
  localeLabel,
  resetLocaleCache,
  configureRuntime,
};

if (globalThis.window !== undefined || globalThis.document !== undefined) {
  configureRuntime({ storage: globalThis.localStorage ?? null, navigator: globalThis.navigator ?? null });
  globalThis.UtopiaI18n = api;
}

export default api;

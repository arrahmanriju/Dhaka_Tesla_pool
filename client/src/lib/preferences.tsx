'use client';
// ─── Language + theme preferences (localStorage-backed) ───────────────────
// Defaults: Bangla, light. `layout.tsx` runs an inline script before first paint
// that applies the stored values to <html>, so there is no flash on reload.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import {
  DICTIONARIES,
  type Lang,
  type PluralBase,
  type TranslationKey,
} from './translations';

export type Theme = 'dark' | 'light';

export const LANG_KEY = 'lang';
export const THEME_KEY = 'theme';
const DEFAULT_LANG: Lang = 'bn';
const DEFAULT_THEME: Theme = 'light';

// Tiny external store so every component re-renders when a preference changes
// (including from another tab, via the `storage` event).
const listeners = new Set<() => void>();
// In-memory copy so a preference still works if localStorage is unavailable.
const memory: Record<string, string | undefined> = {};

function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === LANG_KEY || e.key === THEME_KEY) {
      if (e.key) delete memory[e.key];
      cb();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener('storage', onStorage);
  };
}

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  let value = memory[key];
  if (value === undefined) {
    try { value = localStorage.getItem(key) ?? undefined; } catch { /* storage blocked */ }
  }
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function writePref(key: string, value: string) {
  memory[key] = value;
  try { localStorage.setItem(key, value); } catch { /* storage blocked */ }
  listeners.forEach((l) => l());
}

const getLang = () => readPref<Lang>(LANG_KEY, ['bn', 'en'], DEFAULT_LANG);
const getTheme = () => readPref<Theme>(THEME_KEY, ['dark', 'light'], DEFAULT_THEME);

// ─── Context ───────────────────────────────────────────────────────────────
type Vars = Record<string, string | number>;

interface PreferencesValue {
  lang: Lang;
  /** BCP-47 locale for date/time formatting. */
  locale: string;
  setLang: (lang: Lang) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  t: (key: TranslationKey, vars?: Vars) => string;
  /** Plural-aware: resolves `<base>_one` when n === 1, otherwise `<base>_other`. */
  tp: (base: PluralBase, n: number, vars?: Vars) => string;
  /** Localised display name for a Dhaka zone (falls back to the raw value). */
  tz: (zone: string) => string;
}

const PreferencesContext = createContext<PreferencesValue | null>(null);

function format(template: string, vars?: Vars) {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

export function PreferencesProvider({ children }: { children: React.ReactNode }) {
  // Server snapshot = defaults, so SSR markup is always Bangla/light; the client
  // snapshot reads localStorage and React re-renders right after hydration.
  const lang = useSyncExternalStore(subscribe, getLang, () => DEFAULT_LANG);
  const theme = useSyncExternalStore(subscribe, getTheme, () => DEFAULT_THEME);

  useEffect(() => {
    const root = document.documentElement;
    root.lang = lang;
    document.title = DICTIONARIES[lang]['meta.title'];
    // Reveal the page once the stored language has been rendered (see layout.tsx).
    if (lang === getLang()) root.removeAttribute('data-lang-pending');
  }, [lang]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const setLang = useCallback((l: Lang) => writePref(LANG_KEY, l), []);
  const setTheme = useCallback((th: Theme) => writePref(THEME_KEY, th), []);
  const toggleTheme = useCallback(
    () => writePref(THEME_KEY, getTheme() === 'dark' ? 'light' : 'dark'),
    [],
  );

  const value = useMemo<PreferencesValue>(() => {
    const dict = DICTIONARIES[lang];
    const t = (key: TranslationKey, vars?: Vars) => format(dict[key], vars);
    return {
      lang,
      locale: lang === 'bn' ? 'bn-BD' : 'en-BD',
      setLang,
      theme,
      setTheme,
      toggleTheme,
      t,
      tp: (base, n, vars) => t(`${base}_${n === 1 ? 'one' : 'other'}` as TranslationKey, { n, ...vars }),
      tz: (zone) => {
        const key = `zone.${zone}` as TranslationKey;
        return key in dict ? dict[key] : zone;
      },
    };
  }, [lang, theme, setLang, setTheme, toggleTheme]);

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): PreferencesValue {
  const ctx = useContext(PreferencesContext);
  if (!ctx) throw new Error('usePreferences must be used inside <PreferencesProvider>');
  return ctx;
}

/**
 * Formats an API error as "Error <status>: <message>" in the current language.
 * The returned function has a stable identity, so it is safe inside `useCallback`
 * deps without re-running data loads when the language changes.
 */
export function useFormatApiError() {
  const { t } = usePreferences();
  const tRef = useRef(t);
  useEffect(() => { tRef.current = t; }, [t]);
  return useCallback(
    (err: { status?: number; message: string }) =>
      err.status
        ? tRef.current('common.errorWithStatus', { status: err.status, message: err.message })
        : err.message,
    [],
  );
}

'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { usePreferences } from '@/lib/preferences';
import { LANGUAGES } from '@/lib/translations';

const svgProps = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
};

const GlobeIcon = () => (
  <svg {...svgProps}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" />
  </svg>
);
const ChevronIcon = () => (
  <svg {...svgProps} width={14} height={14}><path d="m6 9 6 6 6-6" /></svg>
);
const CheckIcon = () => (
  <svg {...svgProps} width={16} height={16}><path d="M20 6 9 17l-5-5" /></svg>
);
const SunIcon = () => (
  <svg {...svgProps}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);
const MoonIcon = () => (
  <svg {...svgProps}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
);

/** Language dropdown + light/dark toggle. `floating` pins it to the top-right of the viewport. */
export function PreferenceControls({ floating = false }: { floating?: boolean }) {
  const { lang, setLang, theme, toggleTheme, t } = usePreferences();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const current = LANGUAGES.find((l) => l.code === lang)!;
  const items = () =>
    Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);

  // Close on outside click; move focus to the selected option when opening.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    (items().find((el) => el.getAttribute('aria-checked') === 'true') ?? items()[0])?.focus();
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const closeAndRefocus = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const els = items();
    const i = els.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); els[(i + 1) % els.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); els[(i - 1 + els.length) % els.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); els[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); els[els.length - 1]?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeAndRefocus(); }
  };

  const themeLabel = theme === 'dark' ? t('pref.switchToLight') : t('pref.switchToDark');

  return (
    <div className={`pref-controls${floating ? ' pref-controls--floating' : ''}`}>
      <div
        className="pref-lang"
        ref={rootRef}
        onBlur={(e) => {
          if (!rootRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
        }}
      >
        <button
          ref={buttonRef}
          type="button"
          id="language-button"
          className="pref-btn pref-lang__button"
          aria-label={`${t('pref.language')}: ${current.label}`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => setOpen((o) => !o)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); }
          }}
        >
          <GlobeIcon />
          <span className="pref-lang__label">{current.label}</span>
          <ChevronIcon />
        </button>

        {open && (
          <div
            ref={menuRef}
            id={menuId}
            className="pref-menu"
            role="menu"
            aria-label={t('pref.language')}
            onKeyDown={onMenuKeyDown}
          >
            {LANGUAGES.map((l) => (
              <button
                key={l.code}
                type="button"
                role="menuitemradio"
                aria-checked={l.code === lang}
                lang={l.code}
                id={`language-option-${l.code}`}
                className={`pref-menu__item${l.code === lang ? ' pref-menu__item--active' : ''}`}
                onClick={() => { setLang(l.code); closeAndRefocus(); }}
              >
                <span>{l.label}</span>
                {l.code === lang && <CheckIcon />}
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        type="button"
        id="theme-toggle"
        className="pref-btn pref-btn--icon"
        aria-label={themeLabel}
        title={themeLabel}
        onClick={toggleTheme}
      >
        {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
      </button>
    </div>
  );
}

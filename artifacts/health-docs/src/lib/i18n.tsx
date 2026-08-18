import { useEffect, useState, ReactNode } from 'react';
import { ar } from './locales/ar';
import { en } from './locales/en';
import { LanguageContext, type Language } from './language-context';

// This module exports ONLY the provider component so it stays compatible
// with Vite Fast Refresh: editing translation files hot-swaps strings in
// place instead of invalidating the app and crashing open sessions.
// `useLanguage` lives in ./language-context.
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(() => {
    const saved = localStorage.getItem('healthdocs_lang');
    return (saved as Language) || 'ar';
  });

  useEffect(() => {
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.lang = language;
    localStorage.setItem('healthdocs_lang', language);
  }, [language]);

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
  };

  const t = (key: string): string => {
    const dict: any = language === 'ar' ? ar : en;
    const keys = key.split('.');
    let value = dict;
    for (const k of keys) {
      if (value === undefined) return key;
      value = value[k];
    }
    return value || key;
  };

  return (
    <LanguageContext.Provider
      value={{
        language,
        setLanguage,
        t,
        isRTL: language === 'ar',
      }}
    >
      {children}
    </LanguageContext.Provider>
  );
}

import React, { createContext, useContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { translations } from '../constants/i18n';

type Language = 'ar' | 'en';

interface LanguageContextType {
  language: Language;
  isRTL: boolean;
  setLanguage: (lang: Language) => Promise<void>;
  t: (key: string) => string;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setLangState] = useState<Language>('ar');

  useEffect(() => {
    AsyncStorage.getItem('medcreds_language').then((saved) => {
      if (saved === 'ar' || saved === 'en') {
        setLangState(saved as Language);
      }
    });
  }, []);

  const setLanguage = async (lang: Language) => {
    setLangState(lang);
    await AsyncStorage.setItem('medcreds_language', lang);
  };

  const t = (path: string): string => {
    const keys = path.split('.');
    let current: any = translations[language];
    for (const k of keys) {
      if (current[k] === undefined) {
        // Fallback to English if Arabic is missing
        let fallback: any = translations['en'];
        for (const fk of keys) {
          if (fallback[fk] === undefined) return path;
          fallback = fallback[fk];
        }
        return fallback as string;
      }
      current = current[k];
    }
    return current as string;
  };

  return (
    <LanguageContext.Provider value={{ language, isRTL: language === 'ar', setLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error('useLanguage must be used within LanguageProvider');
  }
  return context;
}

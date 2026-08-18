import { createContext, useContext } from 'react';

export type Language = 'ar' | 'en';

export interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: string) => string;
  isRTL: boolean;
}

// Kept in its own module (with no locale imports) so hot updates to
// translation files never re-create this context object. Re-creating it
// mid-session detaches mounted components from the provider and crashes
// the page with "useLanguage must be used within a LanguageProvider".
export const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export function useLanguage(): LanguageContextType {
  const context = useContext(LanguageContext);
  if (context === undefined) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return context;
}

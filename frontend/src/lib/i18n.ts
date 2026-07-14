// EN/SW internationalisation. EN is authoritative and carries the spec's
// WORDING LOCKS (e.g. gross/net are "Total Pay"/"Net Pay" — the Exact file's
// own column header 'TOTAL ALLOWANCE' may be referenced ONLY when naming that
// source column). SW is a DRAFT: generic chrome is translated; locked or
// governance terms stay in English until Design/client sign the Swahili
// wording — a translation is a wording change and goes through the same lock.
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../locales/en.json';
import sw from '../locales/sw.json';

i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, sw: { translation: sw } },
  lng: localStorage.getItem('hcmos.lang') || 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

export function setLanguage(lng: 'en' | 'sw') {
  localStorage.setItem('hcmos.lang', lng);
  i18n.changeLanguage(lng);
}

export default i18n;

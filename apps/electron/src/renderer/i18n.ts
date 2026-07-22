// ============================================================
// i18n Configuration — react-i18next setup
// ============================================================

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import ja from "./locales/ja.json";
import zh from "./locales/zh.json";

export type SupportedLocale = "en" | "zh" | "ja";

export const SUPPORTED_LOCALES: SupportedLocale[] = ["en", "zh", "ja"];

export const LOCALE_LABELS: Record<SupportedLocale, string> = {
	en: "English",
	zh: "中文",
	ja: "日本語",
};

const resources = {
	en: { translation: en },
	zh: { translation: zh },
	ja: { translation: ja },
};

i18n.use(initReactI18next).init({
	resources,
	lng: "en",
	fallbackLng: "en",
	interpolation: {
		escapeValue: false,
	},
	returnObjects: false,
	returnNull: false,
});

export default i18n;

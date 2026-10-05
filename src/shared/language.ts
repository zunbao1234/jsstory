import type { LanguageMode } from "./types";

export function detectLanguageMode(text: string): LanguageMode | null {
  const clean = text.trim();
  if (clean.length < 20) return null;

  const cjkCount = clean.match(/[\u4e00-\u9fa5]/g)?.length ?? 0;
  const latinWordCount = clean.match(/[A-Za-z]+(?:['-][A-Za-z]+)?/g)?.length ?? 0;

  if (latinWordCount >= 4 && latinWordCount > cjkCount * 1.5) return "en";
  if (cjkCount >= 8 && cjkCount >= latinWordCount) return "zh";
  return null;
}

export function shouldAutoTranslate(text: string, language: LanguageMode): boolean {
  return language === "en" && text.trim().length >= 20;
}

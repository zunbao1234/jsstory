import type { Estimate, LanguageMode, ReadingRateUnit, StoryboardShot } from "./types";

const CHINESE_SENTENCE_RE = /[^。！？!?；;]+[。！？!?；;]?/g;
const CHUNK_SIZE = 2200;
const STORYBOARD_CHUNK_UNIT_LIMIT = 8;
const STORYBOARD_CHUNK_SIZE = 1100;
const MAX_NARRATION_READING_SECONDS = 8;
const STORYBOARD_ZH_UNITS_PER_SECOND = 6;
const STORYBOARD_EN_WORDS_PER_SECOND = 2.4;
const MAX_ZH_STORYBOARD_UNITS = 48;
const MAX_EN_STORYBOARD_UNITS = 36;
const MIN_EN_TAIL_WORDS = 4;
const BRIDGE_SHOT_SECONDS = 2;
const REACTION_SHOT_SECONDS = 2.5;
const ESTABLISHING_SHOT_SECONDS = 3;
const DEFAULT_SHOT_SECONDS = 4;
const ACTION_SHOT_SECONDS = 4.5;
const MAX_ESTIMATED_SHOT_SECONDS = 6;

export function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

export function splitSentences(text: string, language: LanguageMode): string[] {
  const clean = normalizeText(text);
  if (!clean) return [];

  const blocks = clean.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const sentences = blocks.flatMap((block) => {
    const matches = language === "zh" ? block.match(CHINESE_SENTENCE_RE) : splitEnglishSentences(block);
    return matches?.map((item) => item.trim()).filter(Boolean) ?? [block];
  });

  return sentences.filter((sentence) => sentence.length > 0);
}

function splitEnglishSentences(text: string): string[] {
  const sentences: string[] = [];
  let current = "";
  let quote: "\"" | "'" | "“" | "‘" | null = null;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    current += char;

    if (isEnglishQuote(char, quote)) {
      quote = getNextEnglishQuoteState(char, quote);
      continue;
    }

    if (quote) continue;
    if (!/[.!?]/.test(char)) continue;

    let lookahead = index + 1;
    while (lookahead < text.length && /["'”’]/.test(text[lookahead])) {
      current += text[lookahead];
      lookahead += 1;
    }
    index = lookahead - 1;

    if (shouldKeepAttributionWithQuote(current, text.slice(lookahead))) continue;

    sentences.push(current.trim());
    current = "";
    while (index + 1 < text.length && /\s/.test(text[index + 1])) {
      index += 1;
    }
  }

  if (current.trim()) sentences.push(current.trim());
  return sentences;
}

function isEnglishQuote(char: string, activeQuote: "\"" | "'" | "“" | "‘" | null): boolean {
  if (char === "\"" || char === "“" || char === "”" || char === "‘" || char === "’") return true;
  if (char !== "'") return false;
  if (activeQuote === "'") return true;
  return false;
}

function getNextEnglishQuoteState(
  char: string,
  activeQuote: "\"" | "'" | "“" | "‘" | null
): "\"" | "'" | "“" | "‘" | null {
  if (activeQuote === "“" && char === "”") return null;
  if (activeQuote === "‘" && char === "’") return null;
  if (activeQuote === "\"" && char === "\"") return null;
  if (activeQuote === "'" && char === "'") return null;
  if (activeQuote) return activeQuote;
  if (char === "“") return "“";
  if (char === "‘") return "‘";
  if (char === "\"") return "\"";
  if (char === "'") return "'";
  return null;
}

function shouldKeepAttributionWithQuote(current: string, rest: string): boolean {
  if (!/["”’]\s*$/.test(current)) return false;
  return /^\s*(?:he|she|they|i|we|you|[A-Z][a-z]+)\s+(?:said|asked|whispered|shouted|murmured|replied|cried|sobbed|snapped|answered|continued|added)\b/i.test(rest);
}

export function countReadingUnits(text: string, language: LanguageMode, unit: ReadingRateUnit): number {
  const clean = normalizeText(text);
  if (!clean) return 0;

  if (unit === "secondsPerWord" || language === "en") {
    const words = clean.match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)?|[\u4e00-\u9fa5]/g);
    return words?.length ?? 0;
  }

  const chars = clean.match(/[\u4e00-\u9fa5A-Za-z0-9]/g);
  return chars?.length ?? 0;
}

export function calculateDurationSeconds(
  text: string,
  language: LanguageMode,
  readingRate: number,
  unit: ReadingRateUnit
): number {
  return roundSeconds(countReadingUnits(text, language, unit) * readingRate);
}

export function estimateNovel(
  text: string,
  language: LanguageMode,
  readingRate: number,
  unit: ReadingRateUnit
): Estimate {
  const unitCount = countReadingUnits(text, language, unit);
  const sentenceCount = splitSentences(text, language).length;
  return {
    unitCount,
    sentenceCount,
    chunkCount: buildStoryboardChunks(text, language, readingRate, unit).length || 1,
    readingSeconds: roundSeconds(unitCount * readingRate)
  };
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}小时${m}分${s}秒`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

export function recalculateShotDurations(
  shots: StoryboardShot[],
  language: LanguageMode,
  _readingRate: number,
  _unit: ReadingRateUnit,
  episodeCount = 1
): StoryboardShot[] {
  return shots.map((shot, index) => ({
    ...shot,
    episodeNumber: calculateEpisodeNumber(index + 1, episodeCount, shots.length),
    index: shot.index ?? index + 1,
    dialogueLines: shot.dialogueLines ?? [],
    durationSeconds: calculateShotDurationSeconds(shot, language)
  }));
}

function calculateEpisodeNumber(index: number, episodeCount: number, totalShots: number): number {
  const safeEpisodeCount = Math.max(1, Math.floor(episodeCount));
  const safeTotalShots = Math.max(1, totalShots);
  return Math.min(safeEpisodeCount, Math.floor(((index - 1) * safeEpisodeCount) / safeTotalShots) + 1);
}

export function roundSeconds(value: number): number {
  return Math.round(value * 10) / 10;
}

export function buildChunks(text: string): string[] {
  const clean = normalizeText(text);
  if (!clean) return [];
  if (clean.length <= CHUNK_SIZE) return [clean];

  const paragraphs = clean.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if ((current + "\n\n" + paragraph).trim().length > CHUNK_SIZE && current) {
      chunks.push(current.trim());
      current = paragraph;
    } else {
      current = `${current}\n\n${paragraph}`.trim();
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks.flatMap((chunk) => splitOversizedChunk(chunk));
}

export function buildStoryboardChunks(
  text: string,
  language: LanguageMode,
  _readingRate: number,
  unit: ReadingRateUnit
): string[] {
  const units = buildStoryboardUnits(text, language, unit);
  if (units.length === 0) return [];

  const chunks: string[] = [];
  let current: string[] = [];
  let currentLength = 0;

  for (const storyboardUnit of units) {
    const nextLine = `【分镜单元 ${storyboardUnit.index}】${storyboardUnit.text}`;
    const wouldExceedUnits = current.length >= STORYBOARD_CHUNK_UNIT_LIMIT;
    const wouldExceedSize = currentLength + nextLine.length > STORYBOARD_CHUNK_SIZE && current.length > 0;

    if (wouldExceedUnits || wouldExceedSize) {
      chunks.push(current.join("\n"));
      current = [];
      currentLength = 0;
    }

    current.push(nextLine);
    currentLength += nextLine.length;
  }

  if (current.length > 0) chunks.push(current.join("\n"));
  return chunks;
}

export function calculateShotDurationSeconds(
  shot: Pick<StoryboardShot, "narration" | "sourceText" | "shotType" | "imageDescription" | "prompt">,
  language: LanguageMode
): number {
  if (isBridgeShot(shot) && !normalizeNarration(shot.narration)) return BRIDGE_SHOT_SECONDS;
  if (isReactionShot(shot)) return REACTION_SHOT_SECONDS;
  if (isEstablishingShot(shot)) return ESTABLISHING_SHOT_SECONDS;
  if (isActionShot(shot)) return ACTION_SHOT_SECONDS;

  const coverageText = normalizeNarration(shot.narration) || shot.sourceText;
  const unit = language === "en" ? "secondsPerWord" : "secondsPerChar";
  const coverageUnits = countReadingUnits(coverageText, language, unit);
  if (coverageUnits <= 0) return DEFAULT_SHOT_SECONDS;

  const lengthBias = language === "en"
    ? Math.min(2, Math.max(0, (coverageUnits - 10) / 10))
    : Math.min(2, Math.max(0, (coverageUnits - 14) / 14));
  return roundSeconds(Math.min(MAX_ESTIMATED_SHOT_SECONDS, DEFAULT_SHOT_SECONDS + lengthBias));
}

function splitOversizedChunk(chunk: string): string[] {
  if (chunk.length <= CHUNK_SIZE) return [chunk];
  const sentenceChunks = splitBySentenceBoundary(chunk);
  if (sentenceChunks.length > 1) return sentenceChunks;

  const chunks: string[] = [];
  for (let index = 0; index < chunk.length; index += CHUNK_SIZE) {
    chunks.push(chunk.slice(index, index + CHUNK_SIZE));
  }
  return chunks;
}

function splitBySentenceBoundary(text: string): string[] {
  const sentences = text.match(/[^。！？!?；;.!?]+[。！？!?；;.!?]?/g)?.map((item) => item.trim()).filter(Boolean);
  if (!sentences || sentences.length <= 1) return [text];

  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    if ((current + sentence).length > CHUNK_SIZE && current) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current = `${current}${sentence}`;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function buildStoryboardUnits(
  text: string,
  language: LanguageMode,
  unit: ReadingRateUnit
): Array<{ index: number; text: string }> {
  const maxUnits = getMaxShotReadingUnits(language);
  const sentences = splitSentences(text, language);
  const units: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    if (current && shouldPreserveSentenceBoundary(current, sentence, language)) {
      units.push(current.trim());
      current = "";
    }

    const clauses = splitSentenceForVideo(sentence, language, maxUnits, unit);
    const preserveVideoPartBoundaries = shouldPreserveVideoPartBoundaries(sentence, clauses, language, maxUnits, unit);
    for (const clause of clauses) {
      const next = joinTextUnit(current, clause, language);
      const nextUnits = countReadingUnits(next, language, unit);
      if (current && nextUnits > maxUnits) {
        units.push(current.trim());
        current = clause;
      } else {
        current = next;
      }

      if (preserveVideoPartBoundaries && current) {
        units.push(current.trim());
        current = "";
      }
    }

    if (current && containsDirectSpeech(sentence)) {
      units.push(current.trim());
      current = "";
    }
  }

  if (current.trim()) units.push(current.trim());
  return units.map((unitText, index) => ({ index: index + 1, text: unitText }));
}

function shouldPreserveVideoPartBoundaries(
  sentence: string,
  parts: string[],
  language: LanguageMode,
  maxUnits: number,
  unit: ReadingRateUnit
): boolean {
  if (parts.length <= 1) return false;
  return shouldSplitNearLimitEnglishClause(countReadingUnits(sentence, language, unit), parts, language, maxUnits);
}

function shouldPreserveSentenceBoundary(current: string, nextSentence: string, language: LanguageMode): boolean {
  if (language !== "en") return false;
  return containsDirectSpeech(current) || containsDirectSpeech(nextSentence);
}

function containsDirectSpeech(text: string): boolean {
  return /["“”‘’]/.test(text);
}

function joinTextUnit(current: string, next: string, language: LanguageMode): string {
  if (!current) return next.trim();
  if (language === "en") return `${current} ${next}`.trim();
  return `${current}${next}`.trim();
}

function splitSentenceForVideo(
  sentence: string,
  language: LanguageMode,
  maxUnits: number,
  unit: ReadingRateUnit
): string[] {
  const directSpeechParts = splitDirectSpeechForVideo(sentence, language, unit, maxUnits);
  if (directSpeechParts) return directSpeechParts;
  const sentenceUnits = countReadingUnits(sentence, language, unit);

  const clauses = splitSentenceClauses(sentence, language)
    .map((item) => item.trim())
    .filter(Boolean);
  if (sentenceUnits <= maxUnits && !shouldSplitNearLimitEnglishClause(sentenceUnits, clauses, language, maxUnits)) {
    return [sentence];
  }
  const candidates = clauses.length > 1 ? clauses : splitLongTextByReadingUnits(sentence, language, unit, maxUnits);

  return candidates.flatMap((candidate) => {
    if (countReadingUnits(candidate, language, unit) <= maxUnits) return [candidate];
    return splitLongTextByReadingUnits(candidate, language, unit, maxUnits);
  });
}

function splitSentenceClauses(sentence: string, language: LanguageMode): string[] {
  if (language === "zh") return sentence.split(/(?<=[，,、：:])/);
  return splitEnglishClausesOutsideQuotes(sentence);
}

function splitEnglishClausesOutsideQuotes(sentence: string): string[] {
  const clauses: string[] = [];
  let current = "";
  let quote: "\"" | "'" | "“" | "‘" | null = null;

  for (let index = 0; index < sentence.length; index += 1) {
    const char = sentence[index];
    current += char;

    if (isEnglishQuote(char, quote)) {
      quote = getNextEnglishQuoteState(char, quote);
      continue;
    }

    if (quote || !/[,;:]/.test(char)) continue;
    while (index + 1 < sentence.length && /\s/.test(sentence[index + 1])) {
      index += 1;
    }
    clauses.push(current.trim());
    current = "";
  }

  if (current.trim()) clauses.push(current.trim());
  return clauses.length > 0 ? clauses : [sentence];
}

function shouldSplitNearLimitEnglishClause(
  sentenceUnits: number,
  clauses: string[],
  language: LanguageMode,
  maxUnits: number
): boolean {
  return language === "en" && clauses.length > 1 && sentenceUnits >= Math.ceil(maxUnits * 0.7);
}

function splitDirectSpeechForVideo(
  text: string,
  language: LanguageMode,
  unit: ReadingRateUnit,
  maxUnits: number
): string[] | null {
  if (language !== "en") return null;
  const trimmed = text.trim();
  const match = trimmed.match(/^(['"])(.+)\1(\s+(?:he|she|they|i|we|you|[A-Z][a-z]+)\s+(?:said|asked|whispered|shouted|murmured|replied|cried|sobbed|snapped|answered|continued|added)\.)?$/is);
  if (!match) return null;

  const quote = match[1];
  const quoteText = match[2].trim();
  const attribution = match[3]?.trim() ?? "";
  const totalUnits = countReadingUnits(trimmed, language, unit);
  if (totalUnits <= maxUnits) return [trimmed];

  const safeMaxUnits = Math.max(MIN_EN_TAIL_WORDS, maxUnits - countReadingUnits(attribution, language, unit));
  const parts = splitLongTextByReadingUnits(quoteText, language, unit, safeMaxUnits)
    .map((part) => `${quote}${part}${quote}${attribution ? ` ${attribution}` : ""}`);
  return parts.length > 0 ? parts : [trimmed];
}

function splitLongTextByReadingUnits(
  text: string,
  language: LanguageMode,
  unit: ReadingRateUnit,
  maxUnits: number
): string[] {
  if (language === "en" || unit === "secondsPerWord") {
    const words = text.match(/\S+/g) ?? [text];
    const parts: string[] = [];
    for (let index = 0; index < words.length; index += maxUnits) {
      parts.push(words.slice(index, index + maxUnits).join(" "));
    }
    return rebalanceShortEnglishTail(parts.filter(Boolean), maxUnits);
  }

  const parts: string[] = [];
  for (let index = 0; index < text.length; index += maxUnits) {
    parts.push(text.slice(index, index + maxUnits));
  }
  return parts.map((item) => item.trim()).filter(Boolean);
}

function rebalanceShortEnglishTail(parts: string[], maxUnits: number): string[] {
  if (parts.length < 2) return parts;

  const last = parts[parts.length - 1];
  const lastWordCount = countReadingUnits(last, "en", "secondsPerWord");
  if (lastWordCount === 0 || lastWordCount >= MIN_EN_TAIL_WORDS) return parts;

  const previous = parts[parts.length - 2];
  const previousWords = previous.match(/\S+/g) ?? [];
  const lastWords = last.match(/\S+/g) ?? [];
  const overflowBudget = Math.max(MIN_EN_TAIL_WORDS, Math.ceil(maxUnits * 0.2));

  if (previousWords.length + lastWords.length <= maxUnits + overflowBudget) {
    return [...parts.slice(0, -2), `${previous} ${last}`.trim()];
  }

  const moveCount = Math.min(MIN_EN_TAIL_WORDS - lastWordCount, Math.max(0, previousWords.length - 1));
  if (moveCount <= 0) return parts;

  const movedWords = previousWords.slice(-moveCount);
  const nextPrevious = previousWords.slice(0, -moveCount).join(" ");
  const nextLast = [...movedWords, ...lastWords].join(" ");
  return [...parts.slice(0, -2), nextPrevious, nextLast].filter(Boolean);
}

function getMaxShotReadingUnits(language: LanguageMode): number {
  if (language === "en") {
    return Math.min(MAX_EN_STORYBOARD_UNITS, Math.floor(MAX_NARRATION_READING_SECONDS * STORYBOARD_EN_WORDS_PER_SECOND));
  }
  return Math.min(MAX_ZH_STORYBOARD_UNITS, Math.floor(MAX_NARRATION_READING_SECONDS * STORYBOARD_ZH_UNITS_PER_SECOND));
}

function isBridgeShot(shot: Pick<StoryboardShot, "shotType" | "imageDescription" | "prompt">): boolean {
  const text = `${shot.shotType} ${shot.imageDescription} ${shot.prompt}`;
  return /反应镜头|第三方反应|空镜|场景空镜|过场|转场|reaction|cutaway|establishing/i.test(text);
}

function isReactionShot(shot: Pick<StoryboardShot, "shotType" | "imageDescription" | "prompt">): boolean {
  const text = `${shot.shotType} ${shot.imageDescription} ${shot.prompt}`;
  return /反应镜头|第三方反应|旁观者|当事人反应|关系视线|reaction|cutaway/i.test(text);
}

function isEstablishingShot(shot: Pick<StoryboardShot, "shotType" | "imageDescription" | "prompt">): boolean {
  const text = `${shot.shotType} ${shot.imageDescription} ${shot.prompt}`;
  return /空镜|场景空镜|建立镜头|转场镜头|环境镜头|establishing/i.test(text);
}

function isActionShot(shot: Pick<StoryboardShot, "shotType" | "imageDescription" | "prompt">): boolean {
  const text = `${shot.shotType} ${shot.imageDescription} ${shot.prompt}`;
  return /动作|追逐|打斗|坠落|爆发|冲刺|推开|挥|撞|action|fight|chase/i.test(text);
}

function normalizeNarration(value: string): string {
  return value.trim().replace(/^无$/, "");
}

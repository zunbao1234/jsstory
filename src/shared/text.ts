import type { Estimate, LanguageMode, ReadingRateUnit, StoryboardPlan, StoryboardShot, StoryboardUnit } from "./types";

const CHINESE_SENTENCE_RE = /[^。！？!?；;]+[。！？!?；;]?/g;
const CHUNK_SIZE = 2200;
export const TRANSLATION_QUERY_SAFE_LIMIT = 450;
const STORYBOARD_CHUNK_UNIT_LIMIT = 8;
const STORYBOARD_CHUNK_SIZE = 1100;
const MAX_NARRATION_READING_SECONDS = 12;
const STORYBOARD_ZH_UNITS_PER_SECOND = 6;
const STORYBOARD_EN_WORDS_PER_SECOND = 2.4;
const MAX_ZH_STORYBOARD_UNITS = 72;
const MAX_EN_STORYBOARD_UNITS = 36;
const MIN_EN_TAIL_WORDS = 4;
const ENGLISH_PERIOD_ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "miss", "mx", "dr", "prof", "sr", "jr", "st", "no", "etc", "vs", "fig", "dept", "inc", "ltd", "co",
  "a.m", "p.m", "u.s", "u.k", "u.n"
]);
const BRIDGE_SHOT_SECONDS = 2;
const REACTION_SHOT_SECONDS = 2.5;
const ESTABLISHING_SHOT_SECONDS = 3;
const DEFAULT_SHOT_SECONDS = 4;
const ACTION_SHOT_SECONDS = 4.5;
const MAX_ESTIMATED_SHOT_SECONDS = 12;

export function normalizeText(text: string): string {
  return stripStructuralStoryMarkers(text)
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function stripStructuralStoryMarkers(text: string): string {
  return text
    .replace(/###\s*[^#\n]+?\s*###\s*\{\{\{?/g, "\n")
    .replace(/^\s*(?:\{\{\{|\}\}\})\s*$/gm, "\n");
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

    if (isEnglishQuoteAt(text, index, quote)) {
      const previousQuote = quote;
      quote = getNextEnglishQuoteState(char, quote);
      if (
        previousQuote &&
        !quote &&
        /[.!?]/.test(text[index - 1] ?? "") &&
        shouldSplitAfterClosedQuotedSentence(current, text.slice(index + 1))
      ) {
        sentences.push(current.trim());
        current = "";
        while (index + 1 < text.length && /\s/.test(text[index + 1])) {
          index += 1;
        }
      }
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

    if (char === "." && shouldKeepEnglishPeriodInsideSentence(text, lookahead)) continue;
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

function shouldKeepEnglishPeriodInsideSentence(text: string, lookahead: number): boolean {
  const beforePeriod = text.slice(0, lookahead);
  const previousToken = beforePeriod.match(/([A-Za-z](?:\.[A-Za-z])+\.?|[A-Za-z]+)\.?$/)?.[1]?.toLowerCase();
  const nextNonSpace = text.slice(lookahead).match(/^\s*(\S)/)?.[1] ?? "";

  if (/\b[A-Z]\.$/.test(beforePeriod) && /^[A-Z]/.test(nextNonSpace)) return true;
  if (/(?:\b[A-Z]\.){2,}$/.test(beforePeriod) && /^[a-z]/.test(nextNonSpace)) return true;
  if (previousToken && ENGLISH_PERIOD_ABBREVIATIONS.has(previousToken.replace(/\.$/, ""))) return true;
  if (/\d\.$/.test(beforePeriod) && /^\d/.test(nextNonSpace)) return true;
  return false;
}

function isEnglishQuote(char: string, activeQuote: "\"" | "'" | "“" | "‘" | null): boolean {
  if (char === "\"" || char === "“" || char === "”" || char === "‘" || char === "’") return true;
  if (char !== "'") return false;
  if (activeQuote === "'") return true;
  return false;
}

function isEnglishQuoteAt(text: string, index: number, activeQuote: "\"" | "'" | "“" | "‘" | null): boolean {
  const char = text[index];
  if (char !== "'") return isEnglishQuote(char, activeQuote);
  if (activeQuote === "'") return true;
  const previous = text[index - 1] ?? "";
  const next = text[index + 1] ?? "";
  if (!next || /[A-Za-z0-9]/.test(previous) || !/[A-Za-z0-9]/.test(next)) return false;
  return (index === 0 || /[\s([{]/.test(previous)) && text.indexOf("'", index + 1) > index + 1;
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
  if (!/["'”’]\s*$/.test(current)) return false;
  return /^\s*(?:he|she|they|i|we|you|[A-Z][a-z]+)\s+(?:said|asked|whispered|shouted|murmured|replied|cried|sobbed|snapped|answered|continued|added|barked|screamed|yelled|called|growled|hissed|demanded|ordered|muttered|gasped|pleaded|warned|insisted)\b/i.test(rest);
}

function shouldSplitAfterClosedQuotedSentence(current: string, rest: string): boolean {
  if (shouldKeepAttributionWithQuote(current, rest)) return false;
  const nextWord = rest.match(/^\s*([A-Z][A-Za-z'-]*)\b/)?.[1] ?? "";
  if (!nextWord) return false;
  if (/^(?:I|He|She|They|We|You)$/i.test(nextWord)) return false;
  return true;
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

export function buildTranslationChunks(text: string): string[] {
  const clean = text;
  if (!clean) return [];

  const chunks: string[] = [];
  let offset = 0;
  while (offset < clean.length) {
    const hardEnd = Math.min(clean.length, offset + TRANSLATION_QUERY_SAFE_LIMIT);
    if (hardEnd === clean.length) {
      chunks.push(clean.slice(offset));
      break;
    }

    const candidate = clean.slice(offset, hardEnd);
    let splitAt = -1;
    for (let index = 0; index < candidate.length; index += 1) {
      if (/[\s。！？!?；;.]/.test(candidate[index])) splitAt = index + 1;
    }
    if (splitAt <= 0) splitAt = candidate.length;
    chunks.push(clean.slice(offset, offset + splitAt));
    offset += splitAt;
  }

  return chunks;
}

export function buildStoryboardChunks(
  text: string,
  language: LanguageMode,
  _readingRate: number,
  unit: ReadingRateUnit
): string[] {
  return buildStoryboardPlan(text, language, _readingRate, unit).chunks;
}

export function buildStoryboardPlan(
  text: string,
  language: LanguageMode,
  _readingRate: number,
  unit: ReadingRateUnit
): StoryboardPlan {
  const units = buildStoryboardUnits(text, language, unit);
  if (units.length === 0) return { chunks: [], units: [] };

  const chunks: string[] = [];
  const storyboardUnits: StoryboardUnit[] = [];
  let current: string[] = [];
  let currentLength = 0;
  let currentChunkIndex = 0;

  for (const storyboardUnit of units) {
    const nextLine = `【分镜单元 ${storyboardUnit.index}】${normalizeStoryboardUnitLine(storyboardUnit.text)}`;
    const wouldExceedUnits = current.length >= STORYBOARD_CHUNK_UNIT_LIMIT;
    const wouldExceedSize = currentLength + nextLine.length > STORYBOARD_CHUNK_SIZE && current.length > 0;

    if (wouldExceedUnits || wouldExceedSize) {
      chunks.push(current.join("\n"));
      current = [];
      currentLength = 0;
      currentChunkIndex += 1;
    }

    current.push(nextLine);
    currentLength += nextLine.length;
    storyboardUnits.push({
      id: `unit-${storyboardUnit.index}`,
      index: storyboardUnit.index,
      text: normalizeStoryboardUnitLine(storyboardUnit.text),
      chunkIndex: currentChunkIndex
    });
  }

  if (current.length > 0) chunks.push(current.join("\n"));
  return { chunks, units: storyboardUnits };
}

export function calculateShotDurationSeconds(
  shot: Pick<StoryboardShot, "narration" | "sourceText" | "shotType" | "imageDescription" | "prompt">,
  language: LanguageMode
): number {
  if (isBridgeShot(shot) && !normalizeNarration(shot.narration)) return BRIDGE_SHOT_SECONDS;
  if (isReactionShot(shot)) return REACTION_SHOT_SECONDS;
  if (isEstablishingShot(shot)) return ESTABLISHING_SHOT_SECONDS;

  const coverageText = normalizeNarration(shot.narration) || shot.sourceText;
  const unit = language === "en" ? "secondsPerWord" : "secondsPerChar";
  const coverageUnits = countReadingUnits(coverageText, language, unit);
  if (coverageUnits <= 0) return isActionShot(shot) ? ACTION_SHOT_SECONDS : DEFAULT_SHOT_SECONDS;

  const lengthBias = language === "en"
    ? Math.min(8, Math.max(0, (coverageUnits - 10) / 3))
    : Math.min(8, Math.max(0, (coverageUnits - 14) / 5));
  const estimatedSeconds = Math.min(MAX_ESTIMATED_SHOT_SECONDS, DEFAULT_SHOT_SECONDS + lengthBias);
  return roundSeconds(isActionShot(shot) ? Math.max(ACTION_SHOT_SECONDS, estimatedSeconds) : estimatedSeconds);
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
  return units.map((unitText, index) => ({ index: index + 1, text: normalizeStoryboardUnitLine(unitText) }));
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
  return /["“”‘’]/.test(text) || hasStraightSingleQuotedSpan(text);
}

function hasStraightSingleQuotedSpan(text: string): boolean {
  const firstQuote = text.search(/(^|[\s([{])'[A-Za-z0-9]/);
  if (firstQuote < 0) return false;
  const quoteIndex = text.indexOf("'", firstQuote);
  return quoteIndex >= 0 && text.indexOf("'", quoteIndex + 2) > quoteIndex + 1;
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
  const consecutiveDirectSpeechParts = splitConsecutiveDirectSpeechForVideo(sentence, language, unit, maxUnits);
  if (consecutiveDirectSpeechParts) return consecutiveDirectSpeechParts;
  const directSpeechParts = splitDirectSpeechForVideo(sentence, language, unit, maxUnits);
  if (directSpeechParts) return directSpeechParts;
  const sentenceUnits = countReadingUnits(sentence, language, unit);

  const clauses = splitSentenceClauses(sentence, language)
    .map((item) => item.trim())
    .filter(Boolean);
  if (sentenceUnits <= maxUnits && !shouldSplitNearLimitEnglishClause(sentenceUnits, clauses, language, maxUnits)) {
    return [sentence];
  }
  const candidates = clauses.length > 1 ? mergeDependentEnglishClauses(clauses, language, unit, maxUnits) : splitLongTextByReadingUnits(sentence, language, unit, maxUnits);

  return candidates.flatMap((candidate) => {
    if (countReadingUnits(candidate, language, unit) <= maxUnits) return [candidate];
    return splitLongTextByReadingUnits(candidate, language, unit, maxUnits);
  });
}

function normalizeStoryboardUnitLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function mergeDependentEnglishClauses(
  clauses: string[],
  language: LanguageMode,
  unit: ReadingRateUnit,
  maxUnits: number
): string[] {
  if (language !== "en" || clauses.length <= 1) return clauses;
  const merged: string[] = [];

  for (let index = 0; index < clauses.length; index += 1) {
    const clause = normalizeStoryboardUnitLine(clauses[index]);
    if (!clause) continue;
    const previousIndex = merged.length - 1;
    const nextClause = normalizeStoryboardUnitLine(clauses[index + 1] ?? "");

    if (
      previousIndex >= 0 &&
      shouldMergeEnglishClauseWithPrevious(clause, merged[previousIndex], unit, maxUnits)
    ) {
      merged[previousIndex] = `${merged[previousIndex]} ${clause}`.trim();
      continue;
    }

    if (
      nextClause &&
      shouldMergeEnglishClauseWithNext(clause, nextClause, unit, maxUnits)
    ) {
      merged.push(`${clause} ${nextClause}`.trim());
      index += 1;
      continue;
    }

    merged.push(clause);
  }

  return merged;
}

function shouldMergeEnglishClauseWithNext(
  clause: string,
  nextClause: string,
  unit: ReadingRateUnit,
  maxUnits: number
): boolean {
  if (!isDependentEnglishClausePrefix(clause)) return false;
  return canMergeEnglishClauses(clause, nextClause, unit, maxUnits);
}

function shouldMergeEnglishClauseWithPrevious(
  clause: string,
  previousClause: string,
  unit: ReadingRateUnit,
  maxUnits: number
): boolean {
  if (!isDependentEnglishClausePrefix(clause) && !/^(?:and|but|or|so|yet|because|while|when|after|before|from)\b/i.test(clause)) return false;
  return canMergeEnglishClauses(previousClause, clause, unit, maxUnits);
}

function isDependentEnglishClausePrefix(clause: string): boolean {
  const clean = clause.trim();
  if (!/[,:;]$/.test(clean)) return false;
  if (countReadingUnits(clean, "en", "secondsPerWord") <= MIN_EN_TAIL_WORDS) return true;
  return /^(?:in this world|from the moment|in the moment|at that moment|before dawn|after that|when |while |because |from |in |under |during )/i.test(clean);
}

function canMergeEnglishClauses(
  first: string,
  second: string,
  unit: ReadingRateUnit,
  maxUnits: number
): boolean {
  const mergedUnits = countReadingUnits(`${first} ${second}`, "en", unit);
  const overflowBudget = Math.max(MIN_EN_TAIL_WORDS, Math.ceil(maxUnits * 0.25));
  return mergedUnits <= maxUnits + overflowBudget;
}

function splitSentenceClauses(sentence: string, language: LanguageMode): string[] {
  if (language === "zh") return sentence.split(/(?<=[，,：:])/);
  return splitEnglishClausesOutsideQuotes(sentence);
}

function splitEnglishClausesOutsideQuotes(sentence: string): string[] {
  const clauses: string[] = [];
  let current = "";
  let quote: "\"" | "'" | "“" | "‘" | null = null;

  for (let index = 0; index < sentence.length; index += 1) {
    const char = sentence[index];
    current += char;

    if (isEnglishQuoteAt(sentence, index, quote)) {
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
  const match = matchEnglishDirectSpeech(trimmed);
  if (!match) return null;

  const { openQuote, closeQuote, quoteText, attribution } = match;
  const totalUnits = countReadingUnits(trimmed, language, unit);
  if (totalUnits <= maxUnits) return [trimmed];

  const safeMaxUnits = Math.max(MIN_EN_TAIL_WORDS, maxUnits - countReadingUnits(attribution, language, unit));
  const parts = splitLongTextByReadingUnits(quoteText, language, unit, safeMaxUnits)
    .map((part) => `${openQuote}${part}${closeQuote}${attribution ? ` ${attribution}` : ""}`);
  return parts.length > 0 ? parts : [trimmed];
}

function matchEnglishDirectSpeech(text: string): {
  openQuote: "\"" | "'" | "“" | "‘";
  closeQuote: "\"" | "'" | "”" | "’";
  quoteText: string;
  attribution: string;
} | null {
  const quotePairs = [
    { openQuote: "\"", closeQuote: "\"" },
    { openQuote: "'", closeQuote: "'" },
    { openQuote: "“", closeQuote: "”" },
    { openQuote: "‘", closeQuote: "’" }
  ] as const;

  for (const { openQuote, closeQuote } of quotePairs) {
    if (!text.startsWith(openQuote)) continue;
    const closeIndex = text.lastIndexOf(closeQuote);
    if (closeIndex <= 0) continue;

    const quoteText = text.slice(openQuote.length, closeIndex).trim();
    const attribution = text.slice(closeIndex + closeQuote.length).trim();
    if (!quoteText) continue;
    if (attribution && !isEnglishSpeechAttribution(attribution)) continue;
    return { openQuote, closeQuote, quoteText, attribution };
  }

  return null;
}

function isEnglishSpeechAttribution(text: string): boolean {
  return /^(?:he|she|they|i|we|you|[A-Z][a-z]+)\s+(?:said|asked|whispered|shouted|murmured|replied|cried|sobbed|snapped|answered|continued|added|barked|screamed|yelled|called|growled|hissed|demanded|ordered|muttered|gasped|pleaded|warned|insisted)\.$/i.test(text);
}

function splitConsecutiveDirectSpeechForVideo(
  text: string,
  language: LanguageMode,
  unit: ReadingRateUnit,
  maxUnits: number
): string[] | null {
  if (language !== "en") return null;

  const parts = splitByEnglishQuoteSpans(text);
  const quotePartCount = parts.filter((part) => part.isQuote).length;
  if (quotePartCount < 2) return null;

  return parts.flatMap((part) => {
    if (countReadingUnits(part.text, language, unit) <= maxUnits) return [part.text];
    if (part.isQuote) return splitDirectSpeechForVideo(part.text, language, unit, maxUnits) ?? [part.text];
    return splitLongTextByReadingUnits(part.text, language, unit, maxUnits);
  });
}

function splitByEnglishQuoteSpans(text: string): Array<{ text: string; isQuote: boolean }> {
  const parts: Array<{ text: string; isQuote: boolean }> = [];
  let cursor = 0;

  while (cursor < text.length) {
    const quoteStart = findNextEnglishOpeningQuote(text, cursor);
    if (!quoteStart) break;

    if (quoteStart.index > cursor) {
      const plainText = text.slice(cursor, quoteStart.index).trim();
      if (plainText) parts.push({ text: plainText, isQuote: false });
    }

    const closeIndex = text.indexOf(quoteStart.closeQuote, quoteStart.index + quoteStart.openQuote.length);
    if (closeIndex < 0) break;

    const quoteText = text.slice(quoteStart.index, closeIndex + quoteStart.closeQuote.length).trim();
    if (quoteText) parts.push({ text: quoteText, isQuote: true });
    cursor = closeIndex + quoteStart.closeQuote.length;
  }

  const tail = text.slice(cursor).trim();
  if (tail) parts.push({ text: tail, isQuote: false });
  return parts.length > 0 ? parts : [{ text: text.trim(), isQuote: false }];
}

function findNextEnglishOpeningQuote(
  text: string,
  startIndex: number
): { index: number; openQuote: "\"" | "'" | "“" | "‘"; closeQuote: "\"" | "'" | "”" | "’" } | null {
  const quotePairs = [
    { openQuote: "“", closeQuote: "”" },
    { openQuote: "\"", closeQuote: "\"" },
    { openQuote: "‘", closeQuote: "’" },
    { openQuote: "'", closeQuote: "'" }
  ] as const;

  let next: { index: number; openQuote: "\"" | "'" | "“" | "‘"; closeQuote: "\"" | "'" | "”" | "’" } | null = null;
  for (const quotePair of quotePairs) {
    const index = text.indexOf(quotePair.openQuote, startIndex);
    if (index >= 0 && (!next || index < next.index)) next = { index, ...quotePair };
  }
  return next;
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
    return rebalanceShortEnglishTail(rebalanceEnglishPhraseBoundaries(parts.filter(Boolean), maxUnits), maxUnits);
  }

  const parts: string[] = [];
  for (let index = 0; index < text.length; index += maxUnits) {
    parts.push(text.slice(index, index + maxUnits));
  }
  return parts.map((item) => item.trim()).filter(Boolean);
}

function rebalanceEnglishPhraseBoundaries(parts: string[], maxUnits: number): string[] {
  if (parts.length < 2) return parts;
  const balanced = [...parts];
  const overflowBudget = Math.max(MIN_EN_TAIL_WORDS, Math.ceil(maxUnits * 0.25));

  for (let index = 0; index < balanced.length - 1; index += 1) {
    const currentWords = balanced[index].match(/\S+/g) ?? [];
    const nextWords = balanced[index + 1].match(/\S+/g) ?? [];
    const moveCount = getEnglishBoundaryMoveCount(currentWords, nextWords);
    if (moveCount <= 0) continue;
    if (currentWords.length - moveCount < MIN_EN_TAIL_WORDS) continue;
    if (nextWords.length + moveCount > maxUnits + overflowBudget) continue;

    const movedWords = currentWords.slice(-moveCount);
    balanced[index] = currentWords.slice(0, -moveCount).join(" ");
    balanced[index + 1] = [...movedWords, ...nextWords].join(" ");
  }

  return balanced.map((item) => item.trim()).filter(Boolean);
}

function getEnglishBoundaryMoveCount(currentWords: string[], nextWords: string[]): number {
  if (currentWords.length === 0 || nextWords.length === 0) return 0;
  const last = normalizeEnglishBoundaryWord(currentWords[currentWords.length - 1]);
  const previous = normalizeEnglishBoundaryWord(currentWords[currentWords.length - 2] ?? "");
  const next = normalizeEnglishBoundaryWord(nextWords[0]);

  if (previous === "out" && last === "with" && next === "the") return 2;
  if (previous === "in" && last === "with" && /^(?:the|a|an|new|old)$/.test(next)) return 2;
  if (/^(?:and|but|or|so|yet|because|while|when|after|before|from|with|without|into|onto|over|under|through|toward|towards|to|of|for|at|by|as)$/.test(last)) return 1;
  if (/^(?:the|a|an)$/.test(last)) return 1;
  return 0;
}

function normalizeEnglishBoundaryWord(word: string): string {
  return word.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
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

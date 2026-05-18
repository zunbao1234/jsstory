import type { Estimate, LanguageMode, ReadingRateUnit, StoryboardShot } from "./types";

const CHINESE_SENTENCE_RE = /[^。！？!?；;]+[。！？!?；;]?/g;
const ENGLISH_SENTENCE_RE = /[^.!?]+[.!?]?/g;
const CHUNK_SIZE = 2200;

export function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

export function splitSentences(text: string, language: LanguageMode): string[] {
  const clean = normalizeText(text);
  if (!clean) return [];

  const blocks = clean.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const sentences = blocks.flatMap((block) => {
    const matches = block.match(language === "zh" ? CHINESE_SENTENCE_RE : ENGLISH_SENTENCE_RE);
    return matches?.map((item) => item.trim()).filter(Boolean) ?? [block];
  });

  return sentences.filter((sentence) => sentence.length > 0);
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
    chunkCount: buildChunks(text).length || 1,
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
  readingRate: number,
  unit: ReadingRateUnit,
  episodeCount = 1
): StoryboardShot[] {
  return shots.map((shot, index) => ({
    ...shot,
    episodeNumber: calculateEpisodeNumber(index + 1, episodeCount, shots.length),
    index: shot.index ?? index + 1,
    durationSeconds: calculateDurationSeconds(shot.narration || shot.sourceText, language, readingRate, unit)
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

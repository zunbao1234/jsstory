import type { ApiConnectionStatus, LanguageMode, StorySettings, StoryboardPlan, StoryboardShot } from "./types";
import { calculateShotDurationSeconds } from "./text";

export type GenerationConnectionStatus = ApiConnectionStatus;

export function getGenerationStartBlockReason(input: {
  textLength: number;
  hasApiKey: boolean;
  connectionStatus: GenerationConnectionStatus;
}): string | null {
  if (input.textLength < 20) return "请至少输入 20 个字符的小说正文。";
  if (!input.hasApiKey) return "请先配置 API Key 并应用配置。";
  if (input.connectionStatus === "checking") return "正在检查模型连接，请稍候片刻再开始。";
  if (input.connectionStatus !== "connected") return "模型尚未通过生成测试。请先应用配置并点击“测试模型”。";
  return null;
}

export function getGenerationPreparationStatus(language: LanguageMode, needsTranslation: boolean): string {
  return language === "en" && needsTranslation ? "正在准备中文译文..." : "正在启动创作...";
}

export function createStoryboardPlaceholders(plan: StoryboardPlan, settings: StorySettings): StoryboardShot[] {
  return plan.units.map((unit) => ({
    id: unit.id,
    index: unit.index,
    episodeNumber: 1,
    sourceText: unit.text,
    anchorSentence: unit.text,
    narration: unit.text,
    dialogueLines: [],
    imageDescription: "",
    shotType: "",
    characters: [],
    scene: "",
    emotion: "",
    prompt: "",
    durationSeconds: calculateShotDurationSeconds({
      sourceText: unit.text,
      narration: unit.text,
      shotType: "",
      imageDescription: "",
      prompt: ""
    }, settings.language),
    generationStatus: "pending",
    generationChunkIndex: unit.chunkIndex
  }));
}

export function markStoryboardChunkGenerating(shots: StoryboardShot[], chunkIndex: number): StoryboardShot[] {
  return shots.map((shot) => shot.generationChunkIndex === chunkIndex && shot.generationStatus === "pending"
    ? { ...shot, generationStatus: "generating", generationError: undefined }
    : shot);
}

export function failStoryboardChunkShots(shots: StoryboardShot[], chunkIndex: number, error: string): StoryboardShot[] {
  return shots.map((shot) => shot.generationChunkIndex === chunkIndex && shot.generationStatus !== "completed"
    ? { ...shot, generationStatus: "failed", generationError: error }
    : shot);
}

export function replaceStoryboardChunkShots(
  shots: StoryboardShot[],
  chunkIndex: number,
  replacements: StoryboardShot[]
): StoryboardShot[] {
  const firstIndex = shots.findIndex((shot) => shot.generationChunkIndex === chunkIndex);
  const insertIndex = firstIndex >= 0
    ? firstIndex
    : shots.findIndex((shot) => (shot.generationChunkIndex ?? Number.MAX_SAFE_INTEGER) > chunkIndex);
  const retained = shots.filter((shot) => shot.generationChunkIndex !== chunkIndex);
  const safeInsertIndex = insertIndex < 0 ? retained.length : Math.min(insertIndex, retained.length);
  const completed = replacements.map((shot) => ({
    ...shot,
    generationChunkIndex: chunkIndex,
    generationStatus: shot.generationStatus ?? "completed",
    generationError: undefined
  }));
  return [...retained.slice(0, safeInsertIndex), ...completed, ...retained.slice(safeInsertIndex)]
    .map((shot, index) => ({ ...shot, index: index + 1 }));
}

export function replaceStoryboardShotWithResults(shots: StoryboardShot[], shotId: string, replacements: StoryboardShot[]): StoryboardShot[] {
  const targetIndex = shots.findIndex((shot) => shot.id === shotId);
  if (targetIndex < 0) return shots;
  const target = shots[targetIndex];
  const completed = replacements.map((replacement) => ({
    ...replacement,
    generationChunkIndex: target.generationChunkIndex,
    generationStatus: "completed" as const,
    generationError: undefined
  }));
  return [...shots.slice(0, targetIndex), ...completed, ...shots.slice(targetIndex + 1)]
    .map((shot, index) => ({ ...shot, index: index + 1 }));
}

export function clearGeneratingStoryboardShots(shots: StoryboardShot[]): StoryboardShot[] {
  return shots.map((shot) => shot.generationStatus === "generating"
    ? { ...shot, generationStatus: "pending", generationError: undefined }
    : shot);
}

export function countCompletedStoryboardShots(shots: StoryboardShot[]): number {
  return shots.filter((shot) => shot.generationStatus === "completed").length;
}

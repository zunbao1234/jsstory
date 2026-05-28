import cors from "cors";
import "dotenv/config";
import express from "express";
import OpenAI from "openai";
import { z } from "zod";
import { zodResponseFormat, zodTextFormat } from "openai/helpers/zod";
import type {
  AnalysisResult,
  CharacterProfile,
  ConfigUpdateRequest,
  GenerationStreamEvent,
  LanguageMode,
  SceneProfile,
  StorySettings,
  StoryboardResult,
  StoryboardShot
} from "../src/shared/types";
import { buildChunks, buildStoryboardChunks, calculateShotDurationSeconds } from "../src/shared/text";

const PORT = Number(process.env.PORT ?? 8787);
const DEFAULT_MODEL = process.env.OPENAI_MODEL ?? "gpt-5.4";
const DEFAULT_BASE_URL = process.env.OPENAI_BASE_URL ?? "";
const PARALLEL_CHUNK_LIMIT = Number(process.env.PARALLEL_CHUNK_LIMIT ?? 2);
const TRANSIENT_REQUEST_RETRIES = Number(process.env.TRANSIENT_REQUEST_RETRIES ?? 3);
const TRANSIENT_RETRY_BASE_DELAY_MS = Number(process.env.TRANSIENT_RETRY_BASE_DELAY_MS ?? 1000);
const MODEL_REQUEST_TIMEOUT_MS = Number(process.env.MODEL_REQUEST_TIMEOUT_MS ?? 90000);
const ANALYSIS_REQUEST_TIMEOUT_MS = Number(process.env.ANALYSIS_REQUEST_TIMEOUT_MS ?? 180000);
const MAX_STORYBOARD_ADAPTIVE_SPLIT_DEPTH = Number(process.env.MAX_STORYBOARD_ADAPTIVE_SPLIT_DEPTH ?? 2);
const MAX_STORYBOARD_SHOTS_PER_CHUNK = 16;
const MOCK_STORYBOARD_FAIL_UNIT_LIMIT = Number(process.env.JSSTORY_MOCK_STORYBOARD_FAIL_UNIT_LIMIT ?? 0);
const RESPONSE_INSTRUCTIONS = "You are a structured generation engine. Follow the user input exactly and return the requested content. For structured outputs, return only data that matches the provided schema.";
const VISUAL_SAFETY_REPLACEMENTS: Array<[RegExp, string]> = [
  [/(?:血腥|鲜血|血液|血泊|\bbloody\b|\bblood\b|\bgore\b)/gi, "红色液体"],
  [/(?:肢解|断肢|内脏|开膛破肚|\bdismember(?:ed|ment)?\b|\bguts?\b|\bentrails?\b)/gi, "严重后果"],
  [/(?:尸体|尸块|\bcorpse\b|\bdead body\b|\bbody parts\b)/gi, "倒下的身影"],
  [/(?:杀死|杀害|杀人|砍死|枪杀|捅死|\bkill(?:ed|ing)?\b|\bmurder(?:ed|ing)?\b|\bslaughter\b)/gi, "造成严重冲突后果"],
  [/(?:自杀|自残|\bsuicide\b|\bself-harm\b|\bself harm\b)/gi, "极端危机状态"],
  [/(?:强奸|性侵|\brape\b|\bsexual assault\b)/gi, "越界威胁"],
  [/(?:性行为|性交|做爱|性爱|床戏|\bsex\b|\bsexual intercourse\b|\blove scene\b)/gi, "亲密关系张力"],
  [/(?:摸|触摸|抚摸|抓住|按住|碰到)(?:她|他|对方|女孩|女人|男人|男孩|身体|胸|乳房|臀|屁股|下体|私处|敏感部位|大腿内侧)/gi, "手靠近对方肩侧或手臂，两人距离明显拉近"],
  [/(?:胸部|乳房|乳沟|臀部|屁股|下体|私处|敏感部位|大腿内侧|\bbreasts?\b|\bchest\b|\bbuttocks?\b|\bgenitals?\b|\bprivate parts?\b|\binner thigh\b)/gi, "肩侧或手臂附近"],
  [/(?:亲吻|舌吻|强吻|\bkissing\b|\bkissed\b|\bforced kiss\b)/gi, "近距离对峙"],
  [/(?:挑逗|撩拨|性暗示|\bseduce\b|\bseduction\b|\bsexual hint\b)/gi, "暧昧张力"],
  [/(?:裸露|裸体|全裸|\bnude\b|\bnaked\b|\bnudity\b)/gi, "避免裸露的构图"],
  [/(?:脱衣|脱掉衣服|撕开衣服|undress(?:ed|ing)?|strip(?:ped|ping)?)/gi, "衣物凌乱但保持遮挡的构图"],
  [/(?:酷刑|折磨|\btorture\b)/gi, "高压对峙"],
  [/(?:殴打|暴打|拳打脚踢|打断|打残|捅|砍|刺|射击|开枪|\bbeating\b|\bstab(?:bed|bing)?\b|\bshoot(?:ing|s)?\b|\bgunshot\b)/gi, "激烈冲突"],
  [/(?:仇恨羞辱|种族辱骂|\bhate speech\b|\bracial slur\b)/gi, "冲突性言语"],
  [/(?:制作武器|炸药配方|爆炸物配方|\bweapon making\b|\bbomb recipe\b|\bexplosive recipe\b)/gi, "危险操作线索"]
];
const envApiKey = process.env.OPENAI_API_KEY;
let runtimeConfig = {
  model: DEFAULT_MODEL,
  apiKey: envApiKey ?? "",
  baseURL: DEFAULT_BASE_URL
};

const characterSchema = z.object({
  name: z.string(),
  role: z.string(),
  appearance: z.string(),
  costume: z.string(),
  continuityNote: z.string()
});

const sceneSchema = z.object({
  name: z.string(),
  location: z.string(),
  mood: z.string(),
  visualAnchor: z.string()
});

const dialogueLineSchema = z.object({
  speaker: z.string(),
  delivery: z.string(),
  text: z.string()
});

const analysisSchema = z.object({
  logline: z.string(),
  characters: z.array(characterSchema).max(12),
  scenes: z.array(sceneSchema).max(16),
  keyEvents: z.array(z.string()).max(24),
  emotionalRhythm: z.array(z.string()).max(18),
  continuityNotes: z.array(z.string()).max(24)
});

const shotSchema = z.object({
  sourceText: z.string(),
  anchorSentence: z.string(),
  narration: z.string(),
  dialogueLines: z.array(dialogueLineSchema).max(8),
  imageDescription: z.string(),
  shotType: z.string(),
  characters: z.array(z.string()),
  scene: z.string(),
  emotion: z.string(),
  prompt: z.string()
});

const storyboardSchema = z.object({
  shots: z.array(shotSchema).max(MAX_STORYBOARD_SHOTS_PER_CHUNK),
  notes: z.array(z.string()).max(12)
});
type RawStoryboardResult = z.infer<typeof storyboardSchema>;
type ModelRequestKind = "default" | "analysis" | "storyboard";
type QualityIssueSeverity = "error" | "warning" | "auto_fixed";
interface QualityIssue {
  code: string;
  severity: QualityIssueSeverity;
  shotIndex: number;
  field: string;
  message: string;
  evidence?: {
    sourceText?: string;
    offendingText?: string;
    supportedBy?: string;
  };
  fixApplied?: string;
}
type QualityCheckedStoryboardResult = RawStoryboardResult & {
  qualityReport: QualityIssue[];
};

const settingsSchema = z.object({
  visualStyle: z.string().trim().min(1),
  scriptStyle: z.string().trim().min(1),
  language: z.enum(["zh", "en"]),
  readingRate: z.number().positive(),
  readingRateUnit: z.enum(["secondsPerChar", "secondsPerWord"]),
  episodeCount: z.number().int().min(1).max(999).default(1)
});

const analyzeRequestSchema = z.object({
  text: z.string().min(20),
  settings: settingsSchema
});

const storyboardRequestSchema = z.object({
  text: z.string().min(20),
  settings: settingsSchema,
  analysis: analysisSchema
});

const storyboardResumeRequestSchema = storyboardRequestSchema.extend({
  existingShots: z.array(shotSchema.extend({
    id: z.string(),
    index: z.number().int().positive(),
    episodeNumber: z.number().int().positive(),
    durationSeconds: z.number().nonnegative()
  })),
  startChunkIndex: z.number().int().min(0)
});

const configUpdateSchema = z.object({
  model: z.string().trim().min(1),
  apiKey: z.string().trim().optional(),
  baseURL: z.string().trim().optional()
});

const translateRequestSchema = z.object({
  text: z.string().min(1)
});

const app = express();
app.use(cors());
app.use(express.json({ limit: "12mb" }));

app.get("/api/config", (_req, res) => {
  res.json(getConfigResponse());
});

app.post("/api/config", (req, res) => {
  try {
    const nextConfig = configUpdateSchema.parse(req.body);
    applyRuntimeConfig(nextConfig);
    res.json(getConfigResponse());
  } catch (error) {
    sendApiError(res, error);
  }
});

app.get("/api/models", async (_req, res) => {
  try {
    ensureOpenAI();
    const models = await listAvailableModels();
    res.json({ models });
  } catch (error) {
    sendApiError(res, error);
  }
});

app.post("/api/translate", async (req, res) => {
  try {
    ensureOpenAI();
    const { text } = translateRequestSchema.parse(req.body);
    const translatedText = await translateToChinese(text);
    res.json({ translatedText });
  } catch (error) {
    sendApiError(res, error);
  }
});

app.post("/api/analyze", async (req, res) => {
  try {
    ensureOpenAI();
    const { text, settings } = analyzeRequestSchema.parse(req.body);
    const chunks = buildChunks(text);
    const analysis = await analyzeNovel(chunks, settings);
    res.json(analysis);
  } catch (error) {
    sendApiError(res, error);
  }
});

app.post("/api/storyboard", async (req, res) => {
  try {
    ensureOpenAI();
    const { text, settings, analysis } = storyboardRequestSchema.parse(req.body);
    const chunks = buildStoryboardChunks(text, settings.language, settings.readingRate, settings.readingRateUnit);
    const shots = await generateStoryboard(chunks, settings, analysis);
    res.json(shots);
  } catch (error) {
    sendApiError(res, error);
  }
});

app.post("/api/generate/stream", async (req, res) => {
  const sendEvent = createNdjsonStream(res);
  const abortController = new AbortController();
  const startedAt = Date.now();
  let closed = false;
  sendEvent({ type: "heartbeat", phase: "connected", elapsedSeconds: 0 });
  const heartbeat = setInterval(() => {
    if (!closed) sendEvent({ type: "heartbeat", phase: "analysis", elapsedSeconds: Math.round((Date.now() - startedAt) / 1000) });
  }, 10000);
  const closeStream = () => {
    closed = true;
    clearInterval(heartbeat);
    abortController.abort();
  };
  req.on("aborted", () => {
    closeStream();
  });
  res.on("close", () => {
    if (!res.writableEnded) closeStream();
  });

  try {
    ensureOpenAI();
    const { text, settings } = analyzeRequestSchema.parse(req.body);
    const analysisChunks = buildChunks(text);
    const storyboardChunks = buildStoryboardChunks(text, settings.language, settings.readingRate, settings.readingRateUnit);
    sendEvent({ type: "started", chunkTotal: storyboardChunks.length });
    sendEvent({ type: "analysis_started", chunkTotal: analysisChunks.length });

    const analysis = await analyzeNovel(analysisChunks, settings, {
      signal: abortController.signal,
      isClosed: () => closed,
      onChunk: (chunkIndex, chunkTotal, completedChunks) => {
        if (!closed) sendEvent({ type: "analysis_chunk", chunkIndex, chunkTotal, completedChunks });
      },
      onMerge: (completedBatches, totalBatches) => {
        if (!closed) sendEvent({ type: "analysis_merge", completedBatches, totalBatches });
      },
      onMergeProgress: (activeBatch, totalBatches, completedBatches, elapsedSeconds) => {
        if (!closed) sendEvent({ type: "analysis_merge_progress", activeBatch, totalBatches, completedBatches, elapsedSeconds });
      }
    });
    if (closed) return;

    sendEvent({ type: "analysis_completed", analysis });
    sendEvent({ type: "storyboard_started", chunkTotal: storyboardChunks.length });

    const storyboard = await generateStoryboardStream(storyboardChunks, settings, analysis, (event) => {
      if (!closed) sendEvent(event);
    }, abortController.signal, () => closed);
    if (!closed) sendEvent({ type: "done", totalShots: storyboard.shots.length, notes: storyboard.notes, shots: storyboard.shots });
  } catch (error) {
    if (!closed) sendEvent({ type: "error", error: formatApiError(error) });
  } finally {
    clearInterval(heartbeat);
    if (!closed) res.end();
  }
});

app.post("/api/generate/storyboard/resume", async (req, res) => {
  const sendEvent = createNdjsonStream(res);
  const abortController = new AbortController();
  let closed = false;
  const closeStream = () => {
    closed = true;
    abortController.abort();
  };
  req.on("aborted", () => {
    closeStream();
  });
  res.on("close", () => {
    if (!res.writableEnded) closeStream();
  });

  try {
    ensureOpenAI();
    const { text, settings, analysis, existingShots, startChunkIndex } = storyboardResumeRequestSchema.parse(req.body);
    const storyboardChunks = buildStoryboardChunks(text, settings.language, settings.readingRate, settings.readingRateUnit);
    if (startChunkIndex >= storyboardChunks.length) {
      sendEvent({ type: "done", totalShots: existingShots.length, notes: [], shots: assignEpisodeNumbers(existingShots, settings.episodeCount) });
      return;
    }

    sendEvent({
      type: "storyboard_started",
      chunkTotal: storyboardChunks.length,
      startChunkIndex,
      completedChunks: startChunkIndex,
      completedShots: existingShots.length
    });

    const storyboard = await resumeStoryboardStream(
      storyboardChunks,
      settings,
      analysis,
      existingShots,
      startChunkIndex,
      (event) => {
        if (!closed) sendEvent(event);
      },
      abortController.signal,
      () => closed
    );
    if (!closed) sendEvent({ type: "done", totalShots: storyboard.shots.length, notes: storyboard.notes, shots: storyboard.shots });
  } catch (error) {
    if (!closed) sendEvent({ type: "error", error: formatApiError(error) });
  } finally {
    if (!closed) res.end();
  }
});

if (!process.env.JSSTORY_SKIP_SERVER_LISTEN) {
  app.listen(PORT, () => {
    console.log(`Storyboarding API listening on http://localhost:${PORT}`);
  });
}

interface AnalysisProgressHooks {
  onChunk?: (chunkIndex: number, chunkTotal: number, completedChunks: number) => void;
  onMerge?: (completedBatches: number, totalBatches: number) => void;
  onMergeProgress?: (activeBatch: number, totalBatches: number, completedBatches: number, elapsedSeconds: number) => void;
  signal?: AbortSignal;
  isClosed?: () => boolean;
}

async function analyzeNovel(
  chunks: string[],
  settings: StorySettings,
  hooks: AnalysisProgressHooks = {}
): Promise<AnalysisResult> {
  let completedChunks = 0;
  const partials = await mapWithConcurrency(chunks, getParallelLimit(), (chunk, index) =>
    withChunkContext("理解", index, chunks.length, (async () => {
      throwIfAborted(hooks.signal, hooks.isClosed);
      const result = await createStructuredResponse(
        analysisSchema,
        "novel_analysis",
        buildAnalysisPrompt(chunk, settings, index + 1, chunks.length),
        hooks.signal,
        "analysis"
      );
      throwIfAborted(hooks.signal, hooks.isClosed);
      completedChunks += 1;
      hooks.onChunk?.(index, chunks.length, completedChunks);
      return result;
    })())
  );

  if (partials.length === 1) return partials[0];

  return mergeAnalysisPartials(partials, hooks);
}

async function mergeAnalysisPartials(
  partials: AnalysisResult[],
  hooks: AnalysisProgressHooks = {}
): Promise<AnalysisResult> {
  throwIfAborted(hooks.signal, hooks.isClosed);
  hooks.onMergeProgress?.(1, 1, 0, 0);
  const merged = mergeAnalysisPartialsLocally(partials);
  hooks.onMerge?.(1, 1);
  return merged;
}

function mergeAnalysisPartialsLocally(partials: AnalysisResult[]): AnalysisResult {
  return {
    logline: firstNonEmpty(partials.map((partial) => partial.logline)) || "长篇小说理解档案",
    characters: uniqueByName(partials.flatMap((partial) => partial.characters), 12),
    scenes: uniqueByName(partials.flatMap((partial) => partial.scenes), 16),
    keyEvents: uniqueStrings(partials.flatMap((partial) => partial.keyEvents), 24),
    emotionalRhythm: uniqueStrings(partials.flatMap((partial) => partial.emotionalRhythm), 18),
    continuityNotes: uniqueStrings(partials.flatMap((partial) => partial.continuityNotes), 24)
  };
}

function firstNonEmpty(values: string[]): string {
  return values.find((value) => value.trim().length > 0)?.trim() ?? "";
}

function uniqueByName<T extends { name: string }>(items: T[], limit: number): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const item of items) {
    const key = item.name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
    if (unique.length >= limit) break;
  }
  return unique;
}

function uniqueStrings(items: string[], limit: number): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const item of items) {
    const clean = item.trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    unique.push(clean);
    if (unique.length >= limit) break;
  }
  return unique;
}

async function generateStoryboard(
  chunks: string[],
  settings: StorySettings,
  analysis: AnalysisResult
): Promise<StoryboardResult> {
  const results = await mapWithConcurrency(chunks, getParallelLimit(), (chunk, chunkIndex) =>
    withChunkContext(
      "分镜",
      chunkIndex,
      chunks.length,
      createStructuredResponse(
        storyboardSchema,
        "storyboard_shots",
        buildStoryboardPrompt(chunk, settings, analysis, chunkIndex + 1, chunks.length, chunks),
        undefined,
        "storyboard"
      )
    ).then((result) => repairStoryboardChunkResult(result, chunk, analysis))
  );

  const allShots: StoryboardShot[] = [];
  const notes: string[] = [];

  for (const result of results) {
    notes.push(...result.notes);
    result.shots.forEach((shot) => {
      const index = allShots.length + 1;
      const cleanShot = normalizeShotTextFields(shot);
      allShots.push({
        ...cleanShot,
        id: `shot-${index}`,
        index,
        episodeNumber: calculateEpisodeNumber(index, settings.episodeCount, allShots.length + result.shots.length),
        durationSeconds: calculateShotDurationSeconds(
          cleanShot,
          settings.language
        )
      });
    });
  }

  return { shots: assignEpisodeNumbers(allShots, settings.episodeCount), notes };
}

async function generateStoryboardStream(
  chunks: string[],
  settings: StorySettings,
  analysis: AnalysisResult,
  onEvent: (event: Extract<GenerationStreamEvent, { type: "storyboard_chunk" | "storyboard_progress" }>) => void,
  signal?: AbortSignal,
  isClosed?: () => boolean
): Promise<StoryboardResult> {
  const results: Array<RawStoryboardResult | undefined> = new Array(chunks.length);
  const allShots: StoryboardShot[] = [];
  const notes: string[] = [];
  let completedChunks = 0;
  let nextFlushIndex = 0;

  const flushReadyChunks = () => {
    throwIfAborted(signal, isClosed);
    while (results[nextFlushIndex]) {
      const result = results[nextFlushIndex]!;
      const chunkShots: StoryboardShot[] = result.shots.map((shot) => {
        const index = allShots.length + 1;
        const cleanShot = normalizeShotTextFields(shot);
        return {
          ...cleanShot,
          id: `shot-${index}`,
          index,
          episodeNumber: calculateEpisodeNumber(index, settings.episodeCount, index),
          durationSeconds: calculateShotDurationSeconds(
            cleanShot,
            settings.language
          )
        };
      });
      allShots.push(...chunkShots);
      notes.push(...result.notes);
      onEvent({
        type: "storyboard_chunk",
        chunkIndex: nextFlushIndex,
        chunkTotal: chunks.length,
        completedChunks: nextFlushIndex + 1,
        completedShots: allShots.length,
        shots: chunkShots,
        notes: result.notes
      });
      nextFlushIndex += 1;
    }
  };

  await mapWithConcurrency(chunks, getParallelLimit(), async (chunk, chunkIndex) => {
    throwIfAborted(signal, isClosed);
    const result = await generateStoryboardChunkAdaptive(chunk, chunks, settings, analysis, chunkIndex, signal);
    throwIfAborted(signal, isClosed);
    completedChunks += 1;
    results[chunkIndex] = result;
    onEvent({
      type: "storyboard_progress",
      chunkIndex,
      chunkTotal: chunks.length,
      finishedChunks: completedChunks,
      displayedChunks: nextFlushIndex
    });
    flushReadyChunks();
    return result;
  });

  return { shots: assignEpisodeNumbers(allShots, settings.episodeCount), notes };
}

async function resumeStoryboardStream(
  chunks: string[],
  settings: StorySettings,
  analysis: AnalysisResult,
  existingShots: StoryboardShot[],
  startChunkIndex: number,
  onChunk: (event: Extract<GenerationStreamEvent, { type: "storyboard_chunk" }>) => void,
  signal?: AbortSignal,
  isClosed?: () => boolean
): Promise<StoryboardResult> {
  const completedShots = existingShots.map((shot) => ({ ...shot }));
  const notes: string[] = [];

  for (let chunkIndex = startChunkIndex; chunkIndex < chunks.length; chunkIndex += 1) {
    throwIfAborted(signal, isClosed);
    const result = await generateStoryboardChunkAdaptive(chunks[chunkIndex], chunks, settings, analysis, chunkIndex, signal);
    throwIfAborted(signal, isClosed);

    const chunkShots: StoryboardShot[] = result.shots.map((shot) => {
      const index = completedShots.length + 1;
      const cleanShot = normalizeShotTextFields(shot);
      return {
        ...cleanShot,
        id: `shot-${index}`,
        index,
        episodeNumber: calculateEpisodeNumber(index, settings.episodeCount, index),
        durationSeconds: calculateShotDurationSeconds(cleanShot, settings.language)
      };
    });

    completedShots.push(...chunkShots);
    notes.push(...result.notes);
    onChunk({
      type: "storyboard_chunk",
      chunkIndex,
      chunkTotal: chunks.length,
      completedChunks: chunkIndex + 1,
      completedShots: completedShots.length,
      shots: chunkShots,
      notes: result.notes
    });
  }

  return { shots: assignEpisodeNumbers(completedShots, settings.episodeCount), notes };
}

async function generateStoryboardChunkAdaptive(
  chunk: string,
  allChunks: string[],
  settings: StorySettings,
  analysis: AnalysisResult,
  chunkIndex: number,
  signal?: AbortSignal,
  depth = 0
): Promise<RawStoryboardResult> {
  const chunkTotal = allChunks.length;
  try {
    const result = await withChunkContext(
      "分镜",
      chunkIndex,
      chunkTotal,
      createStructuredResponse(
        storyboardSchema,
        "storyboard_shots",
        buildStoryboardPrompt(chunk, settings, analysis, chunkIndex + 1, chunkTotal, allChunks),
        signal,
        "storyboard"
      )
    );
    return qualityCheckStoryboardChunkResult(repairStoryboardChunkResult(result, chunk, analysis), chunk);
  } catch (error) {
    throwIfAborted(signal);
    if (!shouldSplitStoryboardChunk(error, chunk, depth)) throw error;

    const subChunks = splitStoryboardChunkForRetry(chunk);
    if (subChunks.length <= 1) throw error;

    const partials: RawStoryboardResult[] = [];
    for (const subChunk of subChunks) {
      partials.push(await generateStoryboardChunkAdaptive(subChunk, allChunks, settings, analysis, chunkIndex, signal, depth + 1));
    }

    return mergeStoryboardPartials(partials);
  }
}

function shouldSplitStoryboardChunk(error: unknown, chunk: string, depth: number): boolean {
  if (depth >= getMaxStoryboardAdaptiveSplitDepth()) return false;
  if (splitStoryboardChunkForRetry(chunk).length <= 1) return false;
  return isTransientGatewayError(error) || isModelTimeoutError(error) || isGatewayNonJsonError(error instanceof Error ? error.message : String(error));
}

function splitStoryboardChunkForRetry(chunk: string): string[] {
  const lines = chunk.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length <= 1) return [];

  const midpoint = Math.ceil(lines.length / 2);
  return [
    lines.slice(0, midpoint).join("\n"),
    lines.slice(midpoint).join("\n")
  ].filter(Boolean);
}

function mergeStoryboardPartials(partials: RawStoryboardResult[]): RawStoryboardResult {
  return {
    shots: partials.flatMap((partial) => partial.shots),
    notes: partials.flatMap((partial) => partial.notes).slice(0, 12)
  };
}

function repairStoryboardChunkResult(
  result: RawStoryboardResult,
  chunk: string,
  analysis?: AnalysisResult
): RawStoryboardResult {
  const unitTexts = parseStoryboardUnitTexts(chunk);
  if (unitTexts.length === 0) return result;

  const availableShots = [...result.shots];
  const matchedShots = unitTexts.map((unitText, unitIndex) => {
    const shotIndex = findBestShotIndexForUnit(availableShots, unitText, unitIndex);
    return shotIndex >= 0
      ? availableShots.splice(shotIndex, 1)[0]
      : createFallbackShot(unitText);
  });
  const repairedShots = matchedShots.map((shot, unitIndex) => {
    const unitText = unitTexts[unitIndex];
    return normalizeShotTextFields(shot, unitText, analysis);
  });

  return {
    shots: repairedShots,
    notes: result.notes
  };
}

function qualityCheckStoryboardChunkResult(result: RawStoryboardResult, chunk: string): QualityCheckedStoryboardResult {
  const unitTexts = parseStoryboardUnitTexts(chunk);
  const qualityReport: QualityIssue[] = [];

  result.shots.forEach((shot, index) => {
    const sourceText = unitTexts[index] ?? shot.sourceText;
    if (!hasRequiredPromptLines(shot.prompt)) {
      qualityReport.push({
        code: "prompt_missing_required_lines",
        severity: "warning",
        shotIndex: index + 1,
        field: "prompt",
        message: "prompt 缺少固定 7 行结构中的一个或多个标签。",
        evidence: { sourceText, offendingText: shot.prompt }
      });
    }
    if (/未(?:明确|指明)场景/.test(shot.scene)) {
      qualityReport.push({
        code: "scene_not_explicit",
        severity: "warning",
        shotIndex: index + 1,
        field: "scene",
        message: "当前镜头没有足够证据确认具体场景，已使用未明确场景或保守场景表达。",
        evidence: { sourceText }
      });
    }
    const expectedSpeechLine = renderSpeechLine(shot.narration, shot.dialogueLines);
    if (!promptContainsSpeechLine(shot.prompt, expectedSpeechLine)) {
      qualityReport.push({
        code: "speech_line_mismatch",
        severity: "error",
        shotIndex: index + 1,
        field: "prompt",
        message: "[台词/旁白] 行与修复后的 narration/dialogueLines 不一致。",
        evidence: { sourceText, offendingText: shot.prompt, supportedBy: expectedSpeechLine }
      });
    }
  });

  const notes = qualityReport.length > 0
    ? [...result.notes, renderQualityReportNote(qualityReport)]
    : result.notes;

  return {
    ...result,
    notes,
    qualityReport
  };
}

function hasRequiredPromptLines(prompt: string): boolean {
  const requiredLabels = [
    "[镜头语法",
    "[画面细节]",
    "[摄影机补充状态]",
    "[声音设计]",
    "[台词/旁白]",
    "[导演批注]"
  ];
  return /^\[\d{2}:\d{2}-\d{2}:\d{2}s\]/m.test(prompt) && requiredLabels.every((label) => prompt.includes(label));
}

function promptContainsSpeechLine(prompt: string, expectedSpeechLine: string): boolean {
  const speechLine = prompt
    .split("\n")
    .find((line) => line.trimStart().startsWith("[台词/旁白]"));
  if (!speechLine) return false;
  return normalizeForCoverage(stripSpeechControlMarks(speechLine)) === normalizeForCoverage(expectedSpeechLine);
}

function stripSpeechControlMarks(value: string): string {
  return value.replace(/；?【停顿0\.4s(?:，[^】]+)?】；?/g, "；");
}

function renderQualityReportNote(issues: QualityIssue[]): string {
  const counts = issues.reduce<Record<QualityIssueSeverity, number>>((acc, issue) => {
    acc[issue.severity] += 1;
    return acc;
  }, { error: 0, warning: 0, auto_fixed: 0 });
  return `质检提示：${issues.length} 项；error ${counts.error}，warning ${counts.warning}，auto_fixed ${counts.auto_fixed}。`;
}

function parseStoryboardUnitTexts(chunk: string): string[] {
  return chunk
    .split("\n")
    .map((line) => stripStoryboardUnitLabels(line))
    .map((line) => line.trim())
    .filter(Boolean);
}

function findBestShotIndexForUnit(shots: RawStoryboardResult["shots"], unitText: string, fallbackIndex: number): number {
  const normalizedUnit = normalizeForCoverage(unitText);
  const exactIndex = shots.findIndex((shot) => normalizeForCoverage(shot.sourceText) === normalizedUnit);
  if (exactIndex >= 0) return exactIndex;

  const containingIndex = shots.findIndex((shot) => {
    const source = normalizeForCoverage(shot.sourceText);
    return Boolean(source && (normalizedUnit.includes(source) || source.includes(normalizedUnit)));
  });
  if (containingIndex >= 0) return containingIndex;

  return -1;
}

function createFallbackShot(sourceText: string): RawStoryboardResult["shots"][number] {
  return {
    sourceText,
    anchorSentence: sourceText,
    narration: sourceText,
    dialogueLines: [],
    imageDescription: `根据原文内容设计安全画面：${sourceText.slice(0, 80)}`,
    shotType: "中景",
    characters: [],
    scene: "未指明场景",
    emotion: "承接原文情绪",
    prompt: [
      "[00:00-00:04s]",
      "[镜头语法 / 客观视角 / 中景 / 35mm / 稳定焦点 // 稳定]",
      `[画面细节] 根据原文内容设计安全画面，使用人物反应、环境变化和关键道具承接：${sourceText.slice(0, 80)}`,
      "[摄影机补充状态] 稳定机位，轻微推进。",
      "[声音设计] 环境声低铺，跟随旁白节奏。",
      renderSpeechLine(sourceText, []),
      "[导演批注] 保底修复镜头，用于补齐模型遗漏的原文分镜单元。"
    ].join("\n")
  };
}

async function translateToChinese(text: string): Promise<string> {
  const chunks = buildChunks(text);
  const translatedChunks = await mapWithConcurrency(chunks, getParallelLimit(), (chunk, index) =>
    withChunkContext(
      "翻译",
      index,
      chunks.length,
      createTextResponse(
        [
          "请把以下英文小说正文翻译成自然、流畅、便于中文创作者查看的中文。",
          "保留原文段落结构、人物名和关键专有名词；不要添加解释、标题或项目符号。",
          `这是第 ${index + 1}/${chunks.length} 段。`,
          `英文原文：\n${chunk}`
        ].join("\n\n")
      )
    )
  );

  return translatedChunks.join("\n\n");
}

async function createStructuredResponse<T extends z.ZodTypeAny>(
  schema: T,
  name: string,
  input: string,
  signal?: AbortSignal,
  requestKind: ModelRequestKind = "default"
): Promise<z.infer<T>> {
  if (isMockAiEnabled()) {
    throwIfAborted(signal);
    return createMockStructuredResponse(schema, name, input);
  }
  if (!runtimeConfig.apiKey) throw new Error("OPENAI_API_KEY is not configured.");
  const openai = createOpenAIClient();

  return withTransientRetry(async () => {
    throwIfAborted(signal);
    const requestSignal = createRequestSignal(signal, getModelRequestTimeoutMs(requestKind));
    try {
      const response = await openai.responses.parse({
        model: runtimeConfig.model,
        instructions: RESPONSE_INSTRUCTIONS,
        input: buildResponseInput(input),
        text: {
          format: zodTextFormat(schema, name)
        }
      }, { signal: requestSignal.signal });

      const parsed = response.output_parsed;
      if (!parsed) throw new Error("模型没有返回符合 JSON Schema 的结构化结果。");
      return parsed;
    } catch (error) {
      if (requestSignal.didTimeout()) throw createModelTimeoutError(requestKind);
      throwIfAborted(signal);
      if (!shouldFallbackToChat(error)) throw normalizeOpenAIError(error);
      return createStructuredChatResponse(openai, schema, name, input, error, signal, requestKind);
    } finally {
      requestSignal.dispose();
    }
  }, getTransientRetryCount(), signal);
}

async function createTextResponse(input: string, signal?: AbortSignal): Promise<string> {
  if (isMockAiEnabled()) {
    throwIfAborted(signal);
    return `模拟译文：${input.slice(0, 200)}`;
  }
  if (!runtimeConfig.apiKey) throw new Error("OPENAI_API_KEY is not configured.");
  const openai = createOpenAIClient();

  return withTransientRetry(async () => {
    throwIfAborted(signal);
    try {
      const response = await openai.responses.create({
        model: runtimeConfig.model,
        instructions: RESPONSE_INSTRUCTIONS,
        input: buildResponseInput(input)
      }, { signal });
      return response.output_text.trim();
    } catch (error) {
      throwIfAborted(signal);
      if (!shouldFallbackToChat(error)) throw normalizeOpenAIError(error);
      return createTextChatResponse(openai, input, error, signal);
    }
  }, getTransientRetryCount(), signal);
}

async function createStructuredChatResponse<T extends z.ZodTypeAny>(
  openai: OpenAI,
  schema: T,
  name: string,
  input: string,
  responseError: unknown,
  signal?: AbortSignal,
  requestKind: ModelRequestKind = "default"
): Promise<z.infer<T>> {
  const requestSignal = createRequestSignal(signal, getModelRequestTimeoutMs(requestKind));
  try {
    throwIfAborted(signal);
    const completion = await openai.chat.completions.parse({
      model: runtimeConfig.model,
      messages: buildChatMessages(input),
      response_format: zodResponseFormat(schema, name)
    }, { signal: requestSignal.signal });
    const parsed = completion.choices[0]?.message.parsed;
    if (!parsed) throw new Error("模型没有返回符合 JSON Schema 的结构化结果。");
    return parsed;
  } catch (chatSchemaError) {
    if (requestSignal.didTimeout()) throw createModelTimeoutError(requestKind);
    throwIfAborted(signal);
    if (!shouldFallbackToManualJson(chatSchemaError)) {
      throw normalizeOpenAIError(mergeFallbackErrors(responseError, chatSchemaError));
    }
    return createManualJsonChatResponse(openai, schema, input, responseError, chatSchemaError, signal, requestKind);
  } finally {
    requestSignal.dispose();
  }
}

async function createManualJsonChatResponse<T extends z.ZodTypeAny>(
  openai: OpenAI,
  schema: T,
  input: string,
  responseError: unknown,
  chatSchemaError: unknown,
  signal?: AbortSignal,
  requestKind: ModelRequestKind = "default"
): Promise<z.infer<T>> {
  const requestSignal = createRequestSignal(signal, getModelRequestTimeoutMs(requestKind));
  try {
    throwIfAborted(signal);
    const completion = await openai.chat.completions.create({
      model: runtimeConfig.model,
      messages: buildChatMessages(
        [
          input,
          "请只返回 JSON 对象，不要使用 Markdown 代码块，不要输出解释。",
          "JSON 必须满足以下 schema：",
          JSON.stringify(z.toJSONSchema(schema), null, 2)
        ].join("\n\n")
      )
    }, { signal: requestSignal.signal });
    const content = readChatContent(completion.choices[0]?.message.content);
    const parsedJson = extractJsonObject(content);
    return schema.parse(parsedJson);
  } catch (manualJsonError) {
    if (requestSignal.didTimeout()) throw createModelTimeoutError(requestKind);
    throw normalizeOpenAIError(mergeFallbackErrors(responseError, chatSchemaError, manualJsonError));
  } finally {
    requestSignal.dispose();
  }
}

function createMockStructuredResponse<T extends z.ZodTypeAny>(schema: T, name: string, input: string): z.infer<T> {
  if (name.includes("storyboard")) {
    const unitLines = input.match(/【分镜单元\s*\d+】[^\n]+/g) ?? [];
    const failLimit = getMockStoryboardFailUnitLimit();
    if (failLimit > 0 && unitLines.length > failLimit) {
      throw new Error(`503 system cpu overloaded mock: ${unitLines.length} units`);
    }
    const shots = unitLines.slice(0, MAX_STORYBOARD_SHOTS_PER_CHUNK).map((line, index) => {
      const sourceText = stripStoryboardUnitLabels(line);
      return {
        sourceText,
        anchorSentence: sourceText,
        narration: sourceText,
        dialogueLines: [],
        imageDescription: `模拟画面：${sourceText.slice(0, 60)}`,
        shotType: index % 3 === 0 ? "中景" : "近景",
        characters: ["模拟角色"],
        scene: "模拟场景",
        emotion: "紧张",
        prompt: [
          "[00:00-00:04s]",
          "[镜头语法 / 客观视角 / 中景 / 35mm / 稳定焦点 // 稳定]",
          `[画面细节] 模拟画面：${sourceText.slice(0, 80)}`,
          "[摄影机补充状态] 稳定机位，轻微推进。",
          "[声音设计] 低频环境声。",
          ` [台词/旁白] 旁白：“${sourceText.slice(0, 100)}”`,
          "[导演批注] 模拟分镜，用于本地稳定性压测。"
        ].join("\n")
      };
    });
    return schema.parse({ shots, notes: ["mock storyboard"] });
  }

  if (name.includes("analysis")) {
    return schema.parse({
      logline: "模拟长篇小说理解档案。",
      characters: [
        { name: "模拟角色", role: "主角", appearance: "轮廓清晰", costume: "深色外套", continuityNote: "保持同一服装和警觉状态" }
      ],
      scenes: [
        { name: "模拟场景", location: "室内与走廊", mood: "紧张", visualAnchor: "昏黄灯光" }
      ],
      keyEvents: ["角色发现异常", "冲突逐步升级"],
      emotionalRhythm: ["疑虑", "紧张", "推进"],
      continuityNotes: ["保持人物服装、场景光线和道具一致"]
    });
  }

  return schema.parse({});
}

function getMockStoryboardFailUnitLimit(): number {
  if (!Number.isFinite(MOCK_STORYBOARD_FAIL_UNIT_LIMIT)) return 0;
  return Math.max(0, Math.floor(MOCK_STORYBOARD_FAIL_UNIT_LIMIT));
}

async function createTextChatResponse(openai: OpenAI, input: string, responseError: unknown, signal?: AbortSignal): Promise<string> {
  try {
    throwIfAborted(signal);
    const completion = await openai.chat.completions.create({
      model: runtimeConfig.model,
      messages: buildChatMessages(input)
    }, { signal });
    const content = readChatContent(completion.choices[0]?.message.content).trim();
    if (!content) throw new Error("模型没有返回文本内容。");
    return content;
  } catch (chatError) {
    throw normalizeOpenAIError(mergeFallbackErrors(responseError, chatError));
  }
}

async function listAvailableModels(): Promise<string[]> {
  const openai = createOpenAIClient();

  try {
    const page = await openai.models.list();
    return page.data.map((model) => model.id).sort((a, b) => a.localeCompare(b));
  } catch (error) {
    throw normalizeOpenAIError(error);
  }
}

function buildAnalysisPrompt(text: string, settings: StorySettings, chunkIndex: number, chunkTotal: number): string {
  return [
    "你是解说剧小说理解 skill，专门为旁白通读小说的分镜生成做前置理解。",
    "请只返回符合 schema 的 JSON，不要输出解释。",
    `语言：${settings.language === "zh" ? "中文" : "英文"}`,
    `剧本风格：${settings.scriptStyle}`,
    `视觉风格：${renderVisualStyle(settings.visualStyle)}`,
    `目标分集数：${settings.episodeCount} 集。`,
    `这是第 ${chunkIndex}/${chunkTotal} 段。`,
    "目标：提取能支撑后续逐句画面化的角色、场景、关键事件、情绪节奏和连续性约束。",
    "注意：这是解说剧，不是对白剧；旁白每一句都需要画面承接。",
    `小说文本：\n${text}`
  ].join("\n\n");
}

function buildStoryboardPrompt(
  text: string,
  settings: StorySettings,
  analysis: AnalysisResult,
  chunkIndex: number,
  chunkTotal: number,
  allChunks: string[] = [text]
): string {
  return [
    "你是解说剧分镜导演和提示词工程师。",
    "请只返回符合 schema 的 JSON，不要输出解释。",
    `原文语言：${settings.language === "zh" ? "中文" : "英文"}`,
    "输出要求：prompt 字段必须整体使用中文写作，包括镜头语法、画面细节、摄影机补充状态、声音设计和导演批注。",
    "例外：narration 字段、dialogueLines.text 字段、sourceText 字段、anchorSentence 字段，以及 prompt 的 [台词/旁白] 行中被引用的旁白/对白阅读内容，必须保留原文语言和原文表述，不得改写、删减、净化或翻译。",
    buildSafetyInstruction(),
    `剧本风格：${settings.scriptStyle}`,
    `视觉风格：${renderVisualStyle(settings.visualStyle)}`,
    "视觉风格审美指引：高级动画感，不是越真实越好，而是把真实的空间、光影和材质，控制在一个更有审美的动画世界里；该指引只用于画面风格控制，不能突破安全画面化规则和对白/旁白边界。",
    `目标分集数：${settings.episodeCount} 集。请让整体镜头可按剧情节奏拆成 ${settings.episodeCount} 集，每集尽量有明确的小悬念、反转或情绪落点。`,
    `这是第 ${chunkIndex}/${chunkTotal} 段。本段会与其他段并发生成，请只处理本段文本，不要续写未提供内容。`,
    "分镜规则：",
    "1. 先理解每一句旁白的画面功能。",
    "2. 输入已经预先拆成【分镜单元】。短句已经尽量和相邻句合并，每个分镜单元的旁白朗读估算不超过 8 秒；原则上一个分镜单元对应一个镜头。",
    "3. durationSeconds 表示镜头画面时长，不是旁白阅读时长。单个普通镜头建议 3-6 秒，反应镜头 2-3 秒，场景空镜/建立镜头 2-4 秒。",
    "4. 单个镜头覆盖的 narration 朗读估算不能超过 8 秒；超过时必须拆成多个镜头。",
    "5. 不要跨【分镜单元】合并 sourceText、anchorSentence、narration 或 dialogueLines；每个镜头只能覆盖一个分镜单元，除非该单元内部已经包含完整对白和归属语。",
    "6. 英文或中文直接引语是硬边界：以引号开头的句子必须优先独立成对白镜头，或只和同一句里的 said/asked 等归属语保持在同一镜头；不得和前一句叙述尾部拼接。",
    "7. 不要把已经合并好的短句再拆得过碎；除非人物、动作、视角、场景或直接引语边界发生明显切换，否则保持一个分镜单元一个镜头。",
    "8. 当人物、动作、视角或场景发生切换时，不要直接跨切换合并；需要用第三方反应镜头或场景空镜承接。",
    "9. 人物切换时，补一个反应镜头：让观察者、旁观者、对立角色或被影响者成为画面主体，shotType 写“反应镜头”或“第三方反应镜头”。",
    "10. 动作从发起进入结果/当事人反应/旁人确认时，拆成动作镜头和反应镜头，中间可加入短反应镜头承接因果。",
    "11. 场景、地点、时间或氛围切换时，插入场景空镜/建立镜头/转场镜头；characters 可以为空数组，prompt 的 [台词/旁白] 写无。",
    "12. 反应镜头或空镜不能续写未提供剧情，只能视觉化已有切换、情绪余波、环境压力或人物反应。",
    "13. 原文里凡是被中文引号 “”、‘’、书名式对话引号，或英文引号 \"\"、'' 包裹的直接发言，都必须识别为角色对话，不能写进 narration 当旁白。",
    "14. 一个完整引号对白如果因为长度被拆成多个分镜单元，每个拆分片段仍然是角色对白，必须进入 dialogueLines，不能写进 narration；speaker 需要继承同一段直接发言的说话人。",
    "15. 如果直接发言前后没有明确写说话人，必须根据上下文、相邻对白片段和理解档案推断 speaker；确实无法确定时 speaker 写“未指明说话者”，不要把这句话降级成旁白。",
    "16. dialogueLines 必须列出本镜头所有角色直接发言；speaker 写角色名，delivery 写“情绪+发声方式”，text 只写引号内原文内容且保持原文语言。如果这是被拆分的长对白片段，speaker 和 delivery 应延续同一段发言的语气。",
    "17. narration 只保留非直接发言的叙述文本；如果这一镜头只有角色对话没有旁白，narration 写无。",
    "18. 每个镜头的画面重点必须落在覆盖分镜单元的最后一句，即 anchorSentence。",
    "19. 反应镜头/空镜如果没有对应旁白和对白，narration 写无，dialogueLines 为空数组。",
    "20. prompt 必须使用下方“镜头提示词格式”，不是普通散文提示词，不要绑定具体平台参数；除 [台词/旁白] 的引用内容外，其余全部用中文。[台词/旁白] 的引用内容必须保持原文语言和原文表述，不做安全改写。",
    "21. 必须参考理解档案，保持人物外貌、服装、场景和时间线一致；scene、characters、imageDescription 和 prompt 的视觉行可以结合当前分镜单元、相邻段锚点和本段相关理解档案推断，优先给出对视频生成有参考价值的具体画面。",
    "21a. 不要因为场景或人物没有在当前单句中重复出现就降级为空白表达；如果上下文连续且理解档案提供了合理依据，可以沿用或推断场景、人物和道具。",
    "21b. 每条 prompt 的画面细节必须包含明确主体、可拍摄动作或状态、情绪落点和镜头目的；即使信息较少，也要输出有质感、可执行的画面提示词，而不是泛泛写“未明确”。",
    "22. 分集拆分由系统按镜头顺序写入 episodeNumber；你只需要在 notes 中提示适合断集的剧情节点。",
    "23. 任何涉及旁白或角色对话的镜头，都必须在 [台词/旁白] 行使用标准引用格式。",
    "24. 如果同一镜头的 [台词/旁白] 行同时包含角色对白和旁白，必须在两段阅读之间插入停顿标记；角色对白切到旁白时写【停顿0.4s，角色名静默无发声】，旁白切到角色对白时写【停顿0.4s】。停顿标记不能放进双引号内，不能改变引号内原文。画面上应在停顿处切到闭口反应、旁观者、手部动作或环境物件，避免角色说完对白后继续张嘴承接旁白造成穿帮。",
    `25. 本段最多生成 ${MAX_STORYBOARD_SHOTS_PER_CHUNK} 个镜头；如果分镜单元很多，优先拆成多镜头而不是合并成长镜头。`,
    buildCinematicExpressionInstruction(),
    buildPromptFormatInstruction(),
    `本段相关理解档案：\n${renderRelevantAnalysisContext(analysis, text, allChunks, chunkIndex - 1)}`,
    `小说文本：\n${text}`
  ].join("\n\n");
}

function renderRelevantAnalysisContext(
  analysis: AnalysisResult,
  chunkText: string,
  allChunks: string[],
  chunkIndex: number
): string {
  const relevantCharacters = rankRelevantItems(
    analysis.characters,
    chunkText,
    (character) => [character.name, character.role, character.appearance, character.costume, character.continuityNote]
  ).slice(0, 8);
  const relevantScenes = rankRelevantItems(
    analysis.scenes,
    chunkText,
    (scene) => [scene.name, scene.location, scene.mood, scene.visualAnchor]
  ).slice(0, 8);
  const relevantEvents = rankRelevantStrings(analysis.keyEvents, chunkText).slice(0, 10);
  const relevantRhythm = rankRelevantStrings(analysis.emotionalRhythm, chunkText).slice(0, 8);
  const relevantContinuity = rankRelevantStrings(analysis.continuityNotes, chunkText).slice(0, 10);
  const adjacentAnchors = renderAdjacentChunkAnchors(allChunks, chunkIndex);

  return [
    `故事钩子：${analysis.logline}`,
    `本段相关人物：${relevantCharacters.map((character) =>
      `${character.name}（${character.role}；${character.appearance}；${character.costume}；${character.continuityNote}）`
    ).join("；") || "无"}`,
    `本段相关场景：${relevantScenes.map((scene) =>
      `${scene.name}（${scene.location}；${scene.mood}；${scene.visualAnchor}）`
    ).join("；") || "无"}`,
    `相关关键事件：${relevantEvents.join("；") || "无"}`,
    `相关情绪节奏：${relevantRhythm.join("；") || "无"}`,
    `相关连续性提示：${relevantContinuity.join("；") || "无"}`,
    `相邻段锚点：${adjacentAnchors || "无"}`
  ].join("\n");
}

function rankRelevantItems<T>(items: T[], text: string, fields: (item: T) => string[]): T[] {
  return items
    .map((item, index) => ({ item, index, score: scoreRelevantText(fields(item).join(" "), text) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ item }) => item);
}

function rankRelevantStrings(items: string[], text: string): string[] {
  return items
    .map((item, index) => ({ item, index, score: scoreRelevantText(item, text) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ item }) => item);
}

function scoreRelevantText(candidate: string, text: string): number {
  const cleanCandidate = candidate.toLowerCase();
  const cleanText = text.toLowerCase();
  const tokens = extractRelevanceTokens(cleanCandidate);
  let score = 0;
  for (const token of tokens) {
    if (cleanText.includes(token)) score += token.length >= 3 ? 3 : 1;
  }
  if (cleanCandidate && cleanText.includes(cleanCandidate)) score += 8;
  return score;
}

function extractRelevanceTokens(text: string): string[] {
  const latinTokens = text.match(/[a-z0-9]+(?:['-][a-z0-9]+)?/gi) ?? [];
  const cjkTokens = text.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  return Array.from(new Set([...latinTokens, ...cjkTokens].map((token) => token.toLowerCase())));
}

function renderAdjacentChunkAnchors(chunks: string[], chunkIndex: number): string {
  return [
    chunkIndex > 0 ? `上一段：${summarizeChunkAnchor(chunks[chunkIndex - 1])}` : "",
    chunkIndex + 1 < chunks.length ? `下一段：${summarizeChunkAnchor(chunks[chunkIndex + 1])}` : ""
  ].filter(Boolean).join("；");
}

function summarizeChunkAnchor(chunk: string): string {
  return stripStoryboardUnitLabels(chunk)
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

function buildSafetyInstruction(): string {
  return [
    "安全画面化规则：",
    "1. prompt、imageDescription、shotType、emotion 和 notes 不要输出露骨血腥、肢解、内脏、伤口细节、尸体特写、酷刑过程、自伤方法、性行为细节、裸露身体细节、未成年人性化、仇恨羞辱、违法操作步骤、武器制作或规避执法教程。",
    "2. 原文含有暴力、死亡、自伤、性侵、虐待、恐怖或违法内容时，只能用非露骨影视表达：远景、遮挡、剪影、声画错位、道具倒落、角色表情、环境变化、事后秩序、模糊痕迹、旁人反应或转场空镜；不得把伤害过程、身体细节或操作步骤画面化。",
    "3. 原文含有色情、亲密接触、敏感部位或侵犯边界时，不要描述胸、臀、下体、裸露或动作细节；改写为肩侧、手臂、背部外侧、衣袖、衣角、座椅边缘、门框距离、两人站位、视线躲避、手停在半空、身体后退等安全部位和相对位置。",
    "4. 血、血泊、伤口等视觉词统一改成红色液体、暗色痕迹、凌乱道具、地面痕迹或角色反应，不写喷溅、流淌、伤口形态和身体内部细节。",
    "5. 不要美化、鼓励或教学危险行为；导演批注只描述剧情功能、情绪压力和剪辑处理，不写可模仿步骤。",
    "6. 安全画面化只作用于画面、镜头、声音和导演批注表达；[台词/旁白] 行中的阅读内容必须保留原文，不得因安全规则改写。"
  ].join("\n");
}

function buildCinematicExpressionInstruction(): string {
  return [
    "镜头语言和人物表演润色规则：",
    "1. 默认保持单一景别、单一焦距和稳定焦点；不要为了显得丰富而频繁写“中景 -> 近景”。只有同一分镜单元内部确实存在情绪升级、动作结果、视线转移、信息揭示或叙事落点变化时，才使用景别切换。",
    "2. 使用景别切换时必须说明原因和节奏，例如“中景观察两人距离 -> 近景压到眼神，因为角色听见关键台词后情绪转折”；没有明确叙事原因时，只写一个最合适的景别。",
    "3. 焦距和焦点默认稳定；只有需要引导观众注意力时才描述变化逻辑，例如“35mm 中景跟随 -> 70mm 近景压缩空间，焦点从门口红色液体转到人物眼神”。",
    "4. 全身、半身或多人同框描写必须包含：表情细节、手部动作、身体姿态、视线方向；不要只写角色站着或看着。",
    "5. 面部、近景或特写描写必须包含：嘴角状态、眼部状态、面部状态、视线方向；情绪要落到可见肌肉和眼神变化上。",
    "6. 视觉质感采用高级动画感：不是越真实越好，而是把真实的空间、光影和材质，控制在一个更有审美的动画世界里；可以写克制的材质、轮廓光、空气透视、色彩层次和动画电影感表演。"
  ].join("\n");
}

function buildPromptFormatInstruction(): string {
  return [
    "镜头提示词格式：",
    "每个 prompt 必须严格使用 7 行结构，每一行都用方括号标签开头：",
    "[00:00-00:00s]",
    "[镜头语法 / 视角 / 景别 / 焦距 / 焦点变化 // 运动或强度] 默认只写一个最合适的景别、焦距和焦点；只有同一分镜单元确实需要情绪推进、动作结果、视线转移或信息揭示时，才写“中景 -> 近景”这类切换，并说明切换原因。",
    "[画面细节] 主体、动作、空间、表情、构图、光线、色彩、关键道具、视觉风格；人物全身/半身描写必须包含表情细节、手部动作、身体姿态、视线方向；面部/近景/特写描写必须包含嘴角状态、眼部状态、面部状态、视线方向；如果是主观视角，要明确是谁的视角；视觉风格遵循高级动画感，不是越真实越好，而是把真实的空间、光影和材质，控制在一个更有审美的动画世界里。",
    "[摄影机补充状态] 机位高度、运动方式、稳定程度、推拉摇移、景深、畸变或遮挡；默认保持稳定，需要时才写清楚焦距变化、焦点转移和跟焦节奏。",
    "[声音设计] BGM、环境声、拟音、情绪推进、音量或节奏变化。",
    "[台词/旁白] 旁白必须写成：旁白：“对应内容”。角色对话必须写成：角色名（情绪+发声方式）：“对应内容”。所有原文引号内的直接发言都必须作为角色对话输出；没有说话人时写：未指明说话者（情绪+发声方式）：“对应内容”。双引号里的内容必须保持原文语言和原文表述，不要翻译、改写、删减或净化；英文原文保持英文，中文原文保持中文。如果同一镜头同时有旁白和对话，必须在两段阅读之间插入停顿标记；角色对白切到旁白时写：角色名（紧张+低声）：“原文对白”；【停顿0.4s，角色名静默无发声】；旁白：“原文旁白”。旁白切到角色对白时写：旁白：“原文旁白”；【停顿0.4s】；角色名（紧张+低声）：“原文对白”。没有旁白或对话时写：无。",
    "[导演批注] 说明这个镜头的戏剧目的、紧张感/悬念/爽感等观众感受，以及剪辑或同框重点；涉及危险或敏感情节时说明采用非露骨表达。",
    "时间段表示本镜头画面时长，不是旁白阅读时长；普通镜头通常 3-6 秒，反应镜头 2-3 秒，场景空镜/建立镜头 2-4 秒。不要跨镜头累计到全片时间，只写本镜头内部时间范围。"
  ].join("\n");
}

function renderVisualStyle(style: string): string {
  const names: Record<string, string> = {
    "2D": "2D 动画/插画",
    "3D": "3D 动画/电影感渲染",
    "3D高精度CG": "3D 高精度 CG 风格，强调精细建模、电影级材质、真实灯光和高完成度渲染",
    photoreal: "仿真人/写实影视"
  };
  return names[style] ?? style;
}

function ensureOpenAI(): void {
  if (isMockAiEnabled()) return;
  if (!runtimeConfig.apiKey) {
    throw new Error("未配置 OPENAI_API_KEY。请复制 .env.example 为 .env，并填入 OpenAI API Key。");
  }
}

function applyRuntimeConfig(nextConfig: ConfigUpdateRequest): void {
  runtimeConfig = {
    model: nextConfig.model,
    apiKey: nextConfig.apiKey || runtimeConfig.apiKey,
    baseURL: nextConfig.baseURL ?? ""
  };
}

function createOpenAIClient(): OpenAI {
  return new OpenAI({
    apiKey: runtimeConfig.apiKey,
    baseURL: runtimeConfig.baseURL || undefined
  });
}

function isMockAiEnabled(): boolean {
  return process.env.JSSTORY_MOCK_AI === "1";
}

function buildResponseInput(input: string) {
  return [
    {
      role: "user" as const,
      content: [
        {
          type: "input_text" as const,
          text: input
        }
      ]
    }
  ];
}

function buildChatMessages(input: string) {
  return [
    { role: "system" as const, content: RESPONSE_INSTRUCTIONS },
    { role: "user" as const, content: input }
  ];
}

function readChatContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  return "";
}

function extractJsonObject(content: string): unknown {
  const clean = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return JSON.parse(clean);
  } catch {
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(clean.slice(start, end + 1));
    }
    throw new Error("模型返回内容不是可解析的 JSON。");
  }
}

function getConfigResponse() {
  return {
    model: runtimeConfig.model,
    hasApiKey: Boolean(runtimeConfig.apiKey),
    baseURL: runtimeConfig.baseURL,
    apiKeySource: runtimeConfig.apiKey ? (runtimeConfig.apiKey === envApiKey ? "env" : "runtime") : "missing"
  };
}

function calculateEpisodeNumber(index: number, episodeCount: number, totalShots: number): number {
  const safeEpisodeCount = Math.max(1, Math.floor(episodeCount));
  const safeTotalShots = Math.max(1, totalShots);
  return Math.min(safeEpisodeCount, Math.floor(((index - 1) * safeEpisodeCount) / safeTotalShots) + 1);
}

function assignEpisodeNumbers(shots: StoryboardShot[], episodeCount: number): StoryboardShot[] {
  return shots.map((shot, index) => ({
    ...shot,
    episodeNumber: calculateEpisodeNumber(index + 1, episodeCount, shots.length)
  }));
}

function normalizeShotTextFields(
  shot: RawStoryboardResult["shots"][number],
  originalUnitText?: string,
  analysis?: AnalysisResult
): RawStoryboardResult["shots"][number] {
  const cleanSourceText = originalUnitText ? stripStoryboardUnitLabels(originalUnitText) : stripStoryboardUnitLabels(shot.sourceText);
  const cleanAnchorSentence = originalUnitText ? cleanSourceText : stripStoryboardUnitLabels(shot.anchorSentence);
  const originalSpeech = originalUnitText ? deriveSpeechPartsFromSource(cleanSourceText, shot.dialogueLines) : undefined;
  const cleanNarration = originalSpeech ? originalSpeech.narration : stripStoryboardUnitLabels(shot.narration);
  const cleanDialogueLines = originalSpeech
    ? originalSpeech.dialogueLines
    : shot.dialogueLines.map((line) => ({
      ...line,
      text: stripStoryboardUnitLabels(line.text)
    }));
  const visualRepair = {
    scene: sanitizeVisualGenerationText(stripStoryboardUnitLabels(shot.scene)),
    imageDescription: sanitizeVisualGenerationText(stripStoryboardUnitLabels(shot.imageDescription)),
    shotType: sanitizeVisualGenerationText(shot.shotType),
    prompt: sanitizePromptVisualLines(stripStoryboardUnitLabels(shot.prompt))
  };
  return {
    ...shot,
    sourceText: cleanSourceText,
    anchorSentence: cleanAnchorSentence,
    narration: cleanNarration,
    imageDescription: visualRepair.imageDescription,
    shotType: visualRepair.shotType,
    emotion: sanitizeVisualGenerationText(shot.emotion),
    prompt: originalSpeech
      ? buildPromptWithSpeechLine(
        visualRepair.prompt,
        renderSpeechLine(cleanNarration, cleanDialogueLines),
        cleanNarration,
        cleanDialogueLines
      )
      : ensureNarrationDialoguePause(
      visualRepair.prompt,
      cleanNarration,
      cleanDialogueLines
    ),
    characters: shot.characters,
    scene: visualRepair.scene,
    dialogueLines: cleanDialogueLines
  };
}

function sanitizeVisualGenerationText(value: string): string {
  return VISUAL_SAFETY_REPLACEMENTS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

function sanitizePromptVisualLines(value: string): string {
  return normalizePromptTagLines(value)
    .split("\n")
    .map((line) => line.trimStart().startsWith("[台词/旁白]") ? line : sanitizeVisualGenerationText(line))
    .join("\n");
}

function normalizePromptTagLines(value: string): string {
  return value.replace(/\s+(?=\[(?:镜头语法|画面细节|摄影机补充状态|声音设计|台词\/旁白|导演批注)\])/g, "\n");
}

function buildPromptWithSpeechLine(
  prompt: string,
  speechLine: string,
  narration: string,
  dialogueLines: RawStoryboardResult["shots"][number]["dialogueLines"]
): string {
  const lines = prompt.split("\n");
  const speechIndex = lines.findIndex((line) => line.trimStart().startsWith("[台词/旁白]"));
  const repairedSpeechLine = ensureNarrationDialoguePause(speechLine, narration, dialogueLines);
  if (speechIndex >= 0) {
    lines[speechIndex] = repairedSpeechLine;
    return lines.join("\n");
  }
  const directorIndex = lines.findIndex((line) => line.trimStart().startsWith("[导演批注]"));
  if (directorIndex >= 0) {
    lines.splice(directorIndex, 0, repairedSpeechLine);
    return lines.join("\n");
  }
  return [...lines, repairedSpeechLine].join("\n");
}

function deriveSpeechPartsFromSource(
  sourceText: string,
  modelDialogueLines: RawStoryboardResult["shots"][number]["dialogueLines"]
): Pick<RawStoryboardResult["shots"][number], "narration" | "dialogueLines"> {
  const directSpeechParts = extractQuotedSpeechParts(sourceText);
  if (directSpeechParts.length === 0) {
    return { narration: sourceText, dialogueLines: [] };
  }

  const validDialogueLines = directSpeechParts.map((part) => {
    const matchedLine = modelDialogueLines.find((line) => sameReadableText(line.text, part.text));
    return {
      speaker: matchedLine?.speaker?.trim() || "未指明说话者",
      delivery: matchedLine?.delivery?.trim() || "平静+清晰",
      text: part.text
    };
  });

  return {
    narration: removeQuotedRanges(sourceText, directSpeechParts).trim() || "无",
    dialogueLines: validDialogueLines
  };
}

function extractQuotedSpeechParts(sourceText: string): Array<{ text: string; start: number; end: number }> {
  const parts: Array<{ text: string; start: number; end: number }> = [];
  const patterns = [
    /“([^”]+)”/g,
    /‘([^’]+)’/g,
    /"([^"]+)"/g,
    /(^|[\s([{])'([^']+)'(?=$|[\s,.;:!?)}\]])/g
  ];

  for (const pattern of patterns) {
    for (const match of sourceText.matchAll(pattern)) {
      const quotedText = (match.length > 2 ? match[2] : match[1])?.trim();
      if (!quotedText || match.index === undefined) continue;
      const leadingContextLength = match.length > 2 ? match[1].length : 0;
      parts.push({
        text: quotedText,
        start: match.index + leadingContextLength,
        end: match.index + match[0].length
      });
    }
  }

  return parts.sort((a, b) => a.start - b.start);
}

function removeQuotedRanges(sourceText: string, ranges: Array<{ start: number; end: number }>): string {
  let result = "";
  let cursor = 0;
  for (const range of ranges) {
    result += sourceText.slice(cursor, range.start);
    cursor = range.end;
  }
  result += sourceText.slice(cursor);
  return result.replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim();
}

function sameReadableText(left: string, right: string): boolean {
  return normalizeForCoverage(left) === normalizeForCoverage(right);
}

function renderSpeechLine(
  narration: string,
  dialogueLines: RawStoryboardResult["shots"][number]["dialogueLines"]
): string {
  const parts: string[] = [];
  if (hasReadableNarration(narration)) parts.push(`旁白：“${narration}”`);
  parts.push(...dialogueLines.map((line) => {
    const speaker = line.speaker.trim() || "未指明说话者";
    const delivery = line.delivery.trim() || "平静+清晰";
    return `${speaker}（${delivery}）：“${line.text}”`;
  }));
  return `[台词/旁白] ${parts.join("；") || "无"}`;
}

function ensureNarrationDialoguePause(
  prompt: string,
  narration: string,
  dialogueLines: RawStoryboardResult["shots"][number]["dialogueLines"]
): string {
  if (!hasReadableNarration(narration) || dialogueLines.length === 0 || /停顿\s*0\.4s|停顿0\.4s/i.test(prompt)) {
    return prompt;
  }

  return prompt
    .split("\n")
    .map((line) => {
      if (!line.trimStart().startsWith("[台词/旁白]")) return line;
      if (!line.includes("旁白：") || !lineHasDialogue(line, dialogueLines)) return line;
      return insertPauseBetweenSpeechParts(line);
    })
    .join("\n");
}

function hasReadableNarration(narration: string): boolean {
  const clean = narration.trim();
  return Boolean(clean && clean !== "无");
}

function lineHasDialogue(line: string, dialogueLines: RawStoryboardResult["shots"][number]["dialogueLines"]): boolean {
  return dialogueLines.some((dialogue) => {
    const speaker = dialogue.speaker.trim();
    return speaker && line.includes(`${speaker}（`);
  });
}

function insertPauseBetweenSpeechParts(line: string): string {
  const pause = "【停顿0.4s】";
  return line
    .replace(/(旁白：“[^”]*”)([；;，,、\s]+)([^【\s][^：“]{0,40}（[^）]+）：“)/g, `$1；${pause}；$3`)
    .replace(/(([^：“\s]{1,40})（[^）]+）：“[^”]*”)[；;，,、\s]+(旁白：“)/g, (_match, dialoguePart: string, speaker: string, narrationStart: string) =>
      `${dialoguePart}；【停顿0.4s，${speaker}静默无发声】；${narrationStart}`
    );
}

function stripStoryboardUnitLabels(value: string): string {
  return value.replace(/【分镜单元\s*\d+】/g, "").trim();
}

function normalizeForCoverage(value: string): string {
  return stripStoryboardUnitLabels(value)
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function looksLikeHtmlResponse(message: string): boolean {
  return /<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]/i.test(message);
}

function normalizeOpenAIError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (looksLikeHtmlResponse(message)) {
    return new Error(
      `API Base URL 返回了网页 HTML，不是 OpenAI-compatible JSON 接口。请把 Base URL 改成网关的 API 地址，通常以 /v1 结尾，不要填控制台首页。当前 Base URL：${runtimeConfig.baseURL || "默认 OpenAI API"}。`
    );
  }
  if (/502|bad gateway|upstream request failed/i.test(message)) {
    return new Error(
      `上游网关返回 502：Upstream request failed。通常是第三方网关、模型供应商或所选模型临时不可用。请先在“模型”下拉里换一个当前可用模型，或稍后重试；如果持续出现，请检查 Base URL 是否为 /v1 API 地址。原始错误：${message}`
    );
  }
  if (/503|cpu overloaded|overloaded|server overloaded|service unavailable/i.test(message)) {
    return new Error(
      `上游服务返回 503：system cpu overloaded。通常是模型供应商临时过载，不代表当前文本段内容一定有问题。服务已按可配置退避策略重试；如果仍持续出现，请把并发降低到 1，稍后重试，或切换当前可用模型。原始错误：${message}`
    );
  }
  if (isConnectionErrorMessage(message)) {
    return new Error(
      `上游连接错误：模型网关或网络连接临时中断。服务已按临时错误重试；如果连续出现，请稍后重试，或切换模型/Base URL。原始错误：${message}`
    );
  }
  if (isGatewayNonJsonError(message)) {
    return new Error(
      `上游网关返回了非 JSON 或损坏的 JSON 响应，服务已尝试 Responses/Chat Completions 回退和重试，但仍失败。通常是网关临时错误、上游模型返回异常文本，或并发请求触发了供应商限制。建议把并发降低到 1-2 后重试，或切换模型。原始错误：${message}`
    );
  }
  if (/instructions are required/i.test(message)) {
    return new Error(`当前模型网关要求 Responses 请求必须包含 instructions 字段。服务已兼容该要求，请刷新后重试。原始错误：${message}`);
  }
  if (/input must be a list/i.test(message)) {
    return new Error(`当前模型网关要求 Responses input 使用消息数组格式。服务已改为 list 打包，请刷新后重试。原始错误：${message}`);
  }
  if (/(?:model|not found|does not exist|unsupported|permission|unauthorized|forbidden|no access)/i.test(message)) {
    return new Error(`模型 ${runtimeConfig.model} 不可用或当前账号无权限。请修改模型配置后重试。原始错误：${message}`);
  }
  return error instanceof Error ? error : new Error(message);
}

function shouldFallbackToChat(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /instructions are required|input must be a list|responses api|responses endpoint|response_format|text\.format|json_schema|invalid request/i.test(message) || isGatewayNonJsonError(message);
}

function shouldFallbackToManualJson(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /response_format|json_schema|schema|parse|unsupported|invalid request/i.test(message) || isGatewayNonJsonError(message);
}

function isGatewayNonJsonError(message: string): boolean {
  return /invalid character .+ looking for beginning of value|unexpected token .+ json|not valid json|json parse|failed to parse json/i.test(message);
}

function isTransientGatewayError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /500|502|503|504|bad gateway|upstream|overloaded|service unavailable|timeout|timed out|socket hang up|econnreset/i.test(message) || isConnectionErrorMessage(message) || isGatewayNonJsonError(message);
}

function isModelTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /模型请求超时|request timeout|timed out/i.test(message);
}

function isConnectionErrorMessage(message: string): boolean {
  return /connection error|network error|fetch failed|failed to fetch|connection reset|connection refused|connection aborted|econnrefused|etimedout|enotfound|eai_again/i.test(message);
}

async function withTransientRetry<T>(
  operation: () => Promise<T>,
  retries = getTransientRetryCount(),
  signal?: AbortSignal
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      throwIfAborted(signal);
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !isTransientGatewayError(error)) break;
      await delay(getTransientRetryDelayMs(attempt));
    }
  }
  throw lastError;
}

function getTransientRetryCount(): number {
  if (!Number.isFinite(TRANSIENT_REQUEST_RETRIES)) return 3;
  return Math.max(0, Math.min(6, Math.floor(TRANSIENT_REQUEST_RETRIES)));
}

function getTransientRetryBaseDelayMs(): number {
  if (!Number.isFinite(TRANSIENT_RETRY_BASE_DELAY_MS)) return 1000;
  return Math.max(100, Math.min(10000, Math.floor(TRANSIENT_RETRY_BASE_DELAY_MS)));
}

function getTransientRetryDelayMs(attempt: number): number {
  const baseDelay = getTransientRetryBaseDelayMs();
  return Math.min(30000, baseDelay * 2 ** attempt);
}

function getModelRequestTimeoutMs(requestKind: ModelRequestKind = "default"): number {
  if (requestKind === "analysis") return normalizeTimeoutMs(ANALYSIS_REQUEST_TIMEOUT_MS, 180000);
  if (requestKind === "storyboard") return normalizeTimeoutMs(MODEL_REQUEST_TIMEOUT_MS, 90000);
  return normalizeTimeoutMs(MODEL_REQUEST_TIMEOUT_MS, 120000);
}

function normalizeTimeoutMs(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(15000, Math.min(600000, Math.floor(value)));
}

function getMaxStoryboardAdaptiveSplitDepth(): number {
  if (!Number.isFinite(MAX_STORYBOARD_ADAPTIVE_SPLIT_DEPTH)) return 2;
  return Math.max(0, Math.min(4, Math.floor(MAX_STORYBOARD_ADAPTIVE_SPLIT_DEPTH)));
}

function createRequestSignal(parentSignal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onParentAbort = () => controller.abort();
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  return {
    signal: controller.signal,
    didTimeout: () => timedOut && !parentSignal?.aborted,
    dispose: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", onParentAbort);
    }
  };
}

async function withProgressHeartbeat<T>(
  onProgress: (elapsedSeconds: number) => void,
  operation: () => Promise<T>,
  signal?: AbortSignal,
  isClosed?: () => boolean,
  intervalMs = 10000
): Promise<T> {
  const startedAt = Date.now();
  onProgress(0);
  const timer = setInterval(() => {
    if (signal?.aborted || isClosed?.()) return;
    onProgress(Math.round((Date.now() - startedAt) / 1000));
  }, intervalMs);

  try {
    return await operation();
  } finally {
    clearInterval(timer);
  }
}

function createModelTimeoutError(requestKind: ModelRequestKind): Error {
  const phase = renderRequestKindLabel(requestKind);
  const recovery = requestKind === "storyboard"
    ? "分镜阶段会尝试自动拆小段继续。"
    : "系统会按临时错误重试。";
  return new Error(`${phase}模型请求超时（${getModelRequestTimeoutMs(requestKind)}ms）。${recovery}`);
}

function renderRequestKindLabel(requestKind: ModelRequestKind): string {
  if (requestKind === "analysis") return "理解阶段";
  if (requestKind === "storyboard") return "分镜阶段";
  return "";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function throwIfAborted(signal?: AbortSignal, isClosed?: () => boolean): void {
  if (signal?.aborted || isClosed?.()) {
    throw new DOMException("Generation aborted", "AbortError");
  }
}

function createNdjsonStream(res: express.Response): (event: GenerationStreamEvent) => void {
  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  return (event) => {
    res.write(`${JSON.stringify(event)}\n`);
  };
}

export const __test__ = {
  normalizeOpenAIError,
  shouldFallbackToChat,
  shouldFallbackToManualJson,
  isGatewayNonJsonError,
  isTransientGatewayError,
  getParallelLimit,
  getTransientRetryCount,
  getTransientRetryBaseDelayMs,
  getTransientRetryDelayMs,
  getModelRequestTimeoutMs,
  createModelTimeoutError,
  getMaxStoryboardAdaptiveSplitDepth,
  mergeAnalysisPartialsLocally,
  splitStoryboardChunkForRetry,
  repairStoryboardChunkResult,
  qualityCheckStoryboardChunkResult,
  renderRelevantAnalysisContext,
  buildStoryboardPrompt,
  normalizeShotTextFields
};

function mergeFallbackErrors(...errors: unknown[]): Error {
  const message = errors
    .map((error) => (error instanceof Error ? error.message : String(error)))
    .filter(Boolean)
    .join(" | ");
  return new Error(message);
}

function getParallelLimit(): number {
  if (!Number.isFinite(PARALLEL_CHUNK_LIMIT)) return 2;
  return Math.max(1, Math.min(6, Math.floor(PARALLEL_CHUNK_LIMIT)));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      }
    })
  );

  return results;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function withChunkContext<T>(
  phase: string,
  chunkIndex: number,
  chunkTotal: number,
  promise: Promise<T>
): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${phase}阶段第 ${chunkIndex + 1}/${chunkTotal} 段失败：${message}`);
  }
}

function sendApiError(res: express.Response, error: unknown): void {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: "请求数据格式不正确。", details: error.issues });
    return;
  }

  const message = formatApiError(error);
  const status = /OPENAI_API_KEY|模型|model|权限|configured|Base URL|HTML|OpenAI-compatible|502|Upstream|instructions|input|非 JSON|JSON/i.test(message) ? 400 : 500;
  res.status(status).json({ error: message });
}

function formatApiError(error: unknown): string {
  if (error instanceof z.ZodError) return "请求数据格式不正确。";
  const message = error instanceof Error ? error.message : String(error);
  return message;
}

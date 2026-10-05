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
  EvidenceQuote,
  GenerationStreamEvent,
  LanguageMode,
  SceneProfile,
  StorySettings,
  StoryboardPlan,
  StoryboardResult,
  StoryboardShot
} from "../src/shared/types";
import { countCompletedStoryboardShots, createStoryboardPlaceholders, failStoryboardChunkShots, replaceStoryboardChunkShots } from "../src/shared/generation";
import { DEFAULT_MODEL } from "../src/shared/models";
import { buildChunks, buildStoryboardChunks, buildStoryboardPlan, buildTranslationChunks, calculateShotDurationSeconds } from "../src/shared/text";
import {
  ANALYSIS_PROMPT_SKILLS,
  STORYBOARD_PROMPT_SKILLS,
  renderPromptSkillSet
} from "./promptSkills";

const PORT = Number(process.env.PORT ?? 8787);
const CONFIGURED_DEFAULT_MODEL = process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
const DEFAULT_BASE_URL = process.env.OPENAI_BASE_URL ?? "";
const PARALLEL_CHUNK_LIMIT = Number(process.env.PARALLEL_CHUNK_LIMIT ?? 1);
const TRANSIENT_REQUEST_RETRIES = Number(process.env.TRANSIENT_REQUEST_RETRIES ?? 3);
const TRANSIENT_RETRY_BASE_DELAY_MS = Number(process.env.TRANSIENT_RETRY_BASE_DELAY_MS ?? 1000);
const MODEL_REQUEST_TIMEOUT_MS = Number(process.env.MODEL_REQUEST_TIMEOUT_MS ?? 90000);
const MODEL_PROBE_TIMEOUT_MS = Number(process.env.MODEL_PROBE_TIMEOUT_MS ?? 15000);
const TRANSLATION_BASE_URL = process.env.TRANSLATION_BASE_URL ?? "https://translate.googleapis.com/translate_a/single";
const TRANSLATION_FALLBACK_URL = process.env.TRANSLATION_FALLBACK_URL ?? "https://api.mymemory.translated.net/get";
const TRANSLATION_REQUEST_TIMEOUT_MS = Number(process.env.TRANSLATION_REQUEST_TIMEOUT_MS ?? 30000);
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
  model: CONFIGURED_DEFAULT_MODEL,
  apiKey: envApiKey ?? "",
  baseURL: DEFAULT_BASE_URL
};

const evidenceQuoteSchema = z.object({
  quote: z.string(),
  chunkIndex: z.number().int().nonnegative().optional(),
  field: z.string().optional()
});

const modelEvidenceQuoteSchema = z.object({
  quote: z.string(),
  chunkIndex: z.number().int().nonnegative().nullable(),
  field: z.string().nullable()
});

const verificationStatusSchema = z.enum(["verified", "partial", "unsupported", "conflict"]);

const characterSchema = z.object({
  name: z.string(),
  role: z.string(),
  appearance: z.string(),
  costume: z.string(),
  continuityNote: z.string(),
  evidence: z.array(evidenceQuoteSchema).optional(),
  verificationStatus: verificationStatusSchema.optional()
});

const sceneSchema = z.object({
  name: z.string(),
  location: z.string(),
  mood: z.string(),
  visualAnchor: z.string(),
  evidence: z.array(evidenceQuoteSchema).optional(),
  verificationStatus: verificationStatusSchema.optional()
});

const modelCharacterSchema = z.object({
  name: z.string(),
  role: z.string(),
  appearance: z.string(),
  costume: z.string(),
  continuityNote: z.string(),
  evidence: z.array(modelEvidenceQuoteSchema).nullable(),
  verificationStatus: verificationStatusSchema.nullable()
});

const modelSceneSchema = z.object({
  name: z.string(),
  location: z.string(),
  mood: z.string(),
  visualAnchor: z.string(),
  evidence: z.array(modelEvidenceQuoteSchema).nullable(),
  verificationStatus: verificationStatusSchema.nullable()
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

const modelAnalysisSchema = z.object({
  logline: z.string(),
  characters: z.array(modelCharacterSchema).max(12),
  scenes: z.array(modelSceneSchema).max(16),
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
    durationSeconds: z.number().nonnegative(),
    generationStatus: z.enum(["pending", "generating", "completed", "failed"]).optional(),
    generationError: z.string().optional(),
    generationChunkIndex: z.number().int().nonnegative().optional()
  })),
  startChunkIndex: z.number().int().min(0)
});
const storyboardUnitRegenerateRequestSchema = z.object({
  sourceText: z.string().trim().min(1),
  settings: settingsSchema,
  analysis: analysisSchema,
  generationChunkIndex: z.number().int().nonnegative().default(0)
});

const configUpdateSchema = z.object({
  model: z.string().trim().min(1),
  apiKey: z.string().trim().optional(),
  baseURL: z.string().trim().optional()
});
const modelProbeRequestSchema = z.object({
  model: z.string().trim().min(1).optional()
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

app.post("/api/models/check", async (req, res) => {
  try {
    ensureOpenAI();
    const { model } = modelProbeRequestSchema.parse(req.body ?? {});
    res.json(await probeModelConnection(model ?? runtimeConfig.model));
  } catch (error) {
    sendApiError(res, error);
  }
});

app.post("/api/translate", async (req, res) => {
  try {
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
  let heartbeatPhase: "analysis" | "storyboard" = "analysis";
  sendEvent({ type: "heartbeat", phase: "connected", elapsedSeconds: 0 });
  const heartbeat = setInterval(() => {
    if (!closed) sendEvent({ type: "heartbeat", phase: heartbeatPhase, elapsedSeconds: Math.round((Date.now() - startedAt) / 1000) });
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
    const storyboardPlan = buildStoryboardPlan(text, settings.language, settings.readingRate, settings.readingRateUnit);
    const storyboardChunks = storyboardPlan.chunks;
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
    heartbeatPhase = "storyboard";
    sendEvent({ type: "storyboard_started", chunkTotal: storyboardChunks.length });

    const storyboard = await generateStoryboardStream(storyboardPlan, settings, analysis, (event) => {
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
  const startedAt = Date.now();
  let closed = false;
  const heartbeat = setInterval(() => {
    if (!closed) sendEvent({ type: "heartbeat", phase: "storyboard", elapsedSeconds: Math.round((Date.now() - startedAt) / 1000) });
  }, 10000);
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
    const storyboardPlan = buildStoryboardPlan(text, settings.language, settings.readingRate, settings.readingRateUnit);
    const storyboardChunks = storyboardPlan.chunks;
    if (startChunkIndex >= storyboardChunks.length) {
      sendEvent({ type: "done", totalShots: existingShots.length, notes: [], shots: assignEpisodeNumbers(existingShots, settings.episodeCount) });
      return;
    }

    sendEvent({
      type: "storyboard_started",
      chunkTotal: storyboardChunks.length,
      startChunkIndex,
      completedChunks: startChunkIndex,
      completedShots: countCompletedStoryboardShots(existingShots)
    });

    const storyboard = await resumeStoryboardStream(
      storyboardPlan,
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
    clearInterval(heartbeat);
    if (!closed) res.end();
  }
});

app.post("/api/storyboard/regenerate", async (req, res) => {
  try {
    ensureOpenAI();
    const { sourceText, settings, analysis, generationChunkIndex } = storyboardUnitRegenerateRequestSchema.parse(req.body);
    const shots = await regenerateStoryboardUnit(sourceText, settings, analysis, generationChunkIndex);
    res.json({ shots, notes: [] });
  } catch (error) {
    sendApiError(res, error);
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
        modelAnalysisSchema,
        "novel_analysis",
        buildAnalysisPrompt(chunk, settings, index + 1, chunks.length),
        hooks.signal,
        "analysis"
      );
      throwIfAborted(hooks.signal, hooks.isClosed);
      completedChunks += 1;
      hooks.onChunk?.(index, chunks.length, completedChunks);
      return validateAnalysisResultAgainstSource(normalizeModelAnalysisResult(result), chunk, index);
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

function normalizeModelAnalysisResult(analysis: z.infer<typeof modelAnalysisSchema>): AnalysisResult {
  return {
    logline: analysis.logline,
    characters: analysis.characters.map((character) => ({
      name: character.name,
      role: character.role,
      appearance: character.appearance,
      costume: character.costume,
      continuityNote: character.continuityNote,
      evidence: normalizeModelEvidence(character.evidence),
      verificationStatus: character.verificationStatus ?? undefined
    })),
    scenes: analysis.scenes.map((scene) => ({
      name: scene.name,
      location: scene.location,
      mood: scene.mood,
      visualAnchor: scene.visualAnchor,
      evidence: normalizeModelEvidence(scene.evidence),
      verificationStatus: scene.verificationStatus ?? undefined
    })),
    keyEvents: analysis.keyEvents,
    emotionalRhythm: analysis.emotionalRhythm,
    continuityNotes: analysis.continuityNotes
  };
}

function normalizeModelEvidence(evidence: z.infer<typeof modelEvidenceQuoteSchema>[] | null): EvidenceQuote[] | undefined {
  if (!evidence || evidence.length === 0) return undefined;
  return evidence.map((item) => ({
    quote: item.quote,
    chunkIndex: item.chunkIndex ?? undefined,
    field: item.field ?? undefined
  }));
}

function validateAnalysisResultAgainstSource(
  analysis: AnalysisResult,
  sourceText: string,
  chunkIndex = 0
): AnalysisResult {
  const characters = uniqueByName(
    analysis.characters
      .map((character) => validateCharacterProfileAgainstSource(character, sourceText, chunkIndex))
      .filter((character): character is CharacterProfile => Boolean(character)),
    12
  );
  const scenes = uniqueByName(
    analysis.scenes
      .map((scene) => validateSceneProfileAgainstSource(scene, sourceText, chunkIndex))
      .filter((scene): scene is SceneProfile => Boolean(scene)),
    16
  );

  return {
    ...analysis,
    characters,
    scenes,
    keyEvents: uniqueStrings(analysis.keyEvents.filter((event) => isAnalysisStringSupported(event, sourceText)), 24),
    emotionalRhythm: uniqueStrings(analysis.emotionalRhythm.filter((rhythm) => isAnalysisStringSupported(rhythm, sourceText)), 18),
    continuityNotes: uniqueStrings(analysis.continuityNotes.filter((note) => isAnalysisStringSupported(note, sourceText)), 24)
  };
}

function validateCharacterProfileAgainstSource(
  character: CharacterProfile,
  sourceText: string,
  chunkIndex: number
): CharacterProfile | null {
  const name = character.name.trim();
  if (!name || isPronounCharacterName(name) || isLikelySceneOrTitleName(name) || isLikelyFunctionWordOrTitleToken(name)) {
    return null;
  }
  if (!isTermSupportedBySource(name, sourceText)) return null;

  const evidence = collectEvidenceQuotes(name, sourceText, chunkIndex, "name", character.evidence);
  const role = supportedAnalysisFieldOrPlaceholder(character.role, sourceText);
  const appearance = supportedAnalysisFieldOrPlaceholder(character.appearance, sourceText);
  const costume = supportedAnalysisFieldOrPlaceholder(character.costume, sourceText);
  const continuityNote = supportedAnalysisFieldOrPlaceholder(character.continuityNote, sourceText);
  const hasUnsupportedField = [role, appearance, costume, continuityNote].some((field) => field === "未在原文证实");

  return {
    ...character,
    name,
    role,
    appearance,
    costume,
    continuityNote,
    evidence,
    verificationStatus: hasUnsupportedField ? "partial" : "verified"
  };
}

function validateSceneProfileAgainstSource(
  scene: SceneProfile,
  sourceText: string,
  chunkIndex: number
): SceneProfile | null {
  const name = scene.name.trim();
  const location = scene.location.trim();
  if ((!name && !location) || isLikelyNonVisualSceneLabel(name || location)) return null;

  const nameSupported = isSceneFieldSupportedBySource(name, sourceText);
  const locationSupported = isSceneFieldSupportedBySource(location, sourceText);
  if (!nameSupported && !locationSupported) return null;

  const evidenceValue = nameSupported ? name : location;
  const evidence = collectEvidenceQuotes(evidenceValue, sourceText, chunkIndex, nameSupported ? "name" : "location", scene.evidence);
  const mood = supportedAnalysisFieldOrPlaceholder(scene.mood, sourceText);
  const visualAnchor = supportedAnalysisFieldOrPlaceholder(scene.visualAnchor, sourceText);

  return {
    ...scene,
    name: name || location,
    location: location || name,
    mood,
    visualAnchor,
    evidence,
    verificationStatus: mood === "未在原文证实" || visualAnchor === "未在原文证实" ? "partial" : "verified"
  };
}

function supportedAnalysisFieldOrPlaceholder(value: string, sourceText: string): string {
  const clean = value.trim();
  if (!clean) return "未在原文证实";
  return isAnalysisStringSupported(clean, sourceText) ? clean : "未在原文证实";
}

function collectEvidenceQuotes(
  value: string,
  sourceText: string,
  chunkIndex: number,
  field: string,
  modelEvidence?: EvidenceQuote[]
): EvidenceQuote[] {
  const supportedModelEvidence = (modelEvidence ?? []).filter((evidence) =>
    evidence.quote.trim() && normalizedTextIncludes(sourceText, evidence.quote)
  );
  if (supportedModelEvidence.length > 0) return supportedModelEvidence;

  const quote = findSupportedQuote(value, sourceText);
  return quote ? [{ quote, chunkIndex, field }] : [];
}

function findSupportedQuote(value: string, sourceText: string): string {
  const clean = value.trim();
  if (!clean) return "";
  if (normalizedTextIncludes(sourceText, clean)) return clean;
  const tokens = extractEvidenceTokens(clean).filter((token) => isTermSupportedBySource(token, sourceText));
  return tokens[0] ?? "";
}

function isAnalysisStringSupported(value: string, sourceText: string): boolean {
  const tokens = extractEvidenceTokens(value);
  if (tokens.length === 0) return false;
  if (normalizedTextIncludes(sourceText, value)) return true;
  const unsupportedProperNames = extractLikelyCharacterNames(value, [])
    .filter((name) => !isTermSupportedBySource(name, sourceText));
  if (unsupportedProperNames.length > 0) return false;
  const supportedCount = tokens.filter((token) => isTermSupportedBySource(token, sourceText)).length;
  return supportedCount >= 2 && supportedCount / tokens.length >= 0.6;
}

function isSceneFieldSupportedBySource(value: string, sourceText: string): boolean {
  const clean = value.trim();
  if (!clean) return false;
  if (normalizedTextIncludes(sourceText, clean)) return true;
  const tokens = extractEvidenceTokens(clean).filter((token) => !isWeakSceneEvidenceToken(token));
  if (tokens.length === 0) return false;
  return tokens.every((token) => isTermSupportedBySource(token, sourceText));
}

function normalizedTextIncludes(sourceText: string, value: string): boolean {
  const cleanValue = normalizeForCoverage(value);
  if (!cleanValue) return false;
  return normalizeForCoverage(sourceText).includes(cleanValue);
}

function isTermSupportedBySource(term: string, sourceText: string): boolean {
  const cleanTerm = normalizeForCoverage(term);
  if (!cleanTerm || isWeakSceneEvidenceToken(cleanTerm)) return false;
  const cleanSource = normalizeForCoverage(sourceText);
  if (/^[a-z0-9][a-z0-9'-]*$/i.test(cleanTerm)) {
    return new RegExp(`(^|[^a-z0-9])${escapeRegExp(cleanTerm)}([^a-z0-9]|$)`, "i").test(cleanSource);
  }
  return cleanSource.includes(cleanTerm);
}

function extractEvidenceTokens(text: string): string[] {
  return extractRelevanceTokens(text)
    .filter((token) => token.length >= 2)
    .filter((token) => !isLikelyFunctionWordOrTitleToken(token))
    .filter((token) => !isWeakSceneEvidenceToken(token));
}

function isWeakSceneEvidenceToken(token: string): boolean {
  return /^(?:silver|necklace|photo|photos|light|lights|sound|voice|mood|tense|gloomy|压抑|紧张|灯光|项链|照片|声音|风声)$/.test(token.trim().toLowerCase());
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
    allShots.push(...assignRuntimeFieldsForStoryboardChunk(result.shots, {
      existingShotCount: allShots.length,
      episodeCount: settings.episodeCount,
      language: settings.language
    }));
  }

  return { shots: assignEpisodeNumbers(allShots, settings.episodeCount), notes };
}

async function generateStoryboardStream(
  plan: StoryboardPlan,
  settings: StorySettings,
  analysis: AnalysisResult,
  onEvent: (event: Extract<GenerationStreamEvent, { type: "storyboard_chunk_started" | "storyboard_retrying" | "storyboard_chunk_failed" | "storyboard_chunk" | "storyboard_progress" }>) => void,
  signal?: AbortSignal,
  isClosed?: () => boolean
): Promise<StoryboardResult> {
  const shots = createStoryboardPlaceholders(plan, settings);
  const notes: string[] = [];
  let completedChunks = 0;
  await runChunksIndependently(plan.chunks, async (chunk, chunkIndex) => {
    throwIfAborted(signal, isClosed);
    onEvent({ type: "storyboard_chunk_started", chunkIndex, chunkTotal: plan.chunks.length, completedChunks });
    return generateStoryboardChunkAdaptive(chunk, plan.chunks, settings, analysis, chunkIndex, signal, 0, (event) => {
      onEvent(event);
    });
  }, (outcome, chunkIndex) => {
    completedChunks += 1;
    if (outcome.status === "completed") {
      const existingShotCount = shots.filter((shot) => (shot.generationChunkIndex ?? -1) < chunkIndex).length;
      const chunkShots = assignRuntimeFieldsForStoryboardChunk(outcome.value.shots, {
        existingShotCount,
        episodeCount: settings.episodeCount,
        language: settings.language,
        generationChunkIndex: chunkIndex
      });
      shots.splice(0, shots.length, ...replaceStoryboardChunkShots(shots, chunkIndex, chunkShots));
      notes.push(...outcome.value.notes);
      onEvent({
        type: "storyboard_chunk",
        chunkIndex,
        chunkTotal: plan.chunks.length,
        completedChunks,
        completedShots: countCompletedStoryboardShots(shots),
        shots: chunkShots,
        notes: outcome.value.notes
      });
    } else {
      shots.splice(0, shots.length, ...failStoryboardChunkShots(shots, chunkIndex, outcome.error));
      onEvent({
        type: "storyboard_chunk_failed",
        chunkIndex,
        chunkTotal: plan.chunks.length,
        completedChunks,
        error: outcome.error
      });
    }
    onEvent({
      type: "storyboard_progress",
      chunkIndex,
      chunkTotal: plan.chunks.length,
      finishedChunks: completedChunks,
      displayedChunks: completedChunks
    });
  }, signal);

  return { shots: assignEpisodeNumbers(shots, settings.episodeCount), notes };
}

async function resumeStoryboardStream(
  plan: StoryboardPlan,
  settings: StorySettings,
  analysis: AnalysisResult,
  existingShots: StoryboardShot[],
  startChunkIndex: number,
  onChunk: (event: Extract<GenerationStreamEvent, { type: "storyboard_chunk_started" | "storyboard_retrying" | "storyboard_chunk_failed" | "storyboard_chunk" | "storyboard_progress" }>) => void,
  signal?: AbortSignal,
  isClosed?: () => boolean
): Promise<StoryboardResult> {
  let completedShots = existingShots.map((shot) => ({ ...shot }));
  const notes: string[] = [];
  const chunkIndexes = plan.chunks
    .map((_, index) => index)
    .filter((index) => index >= startChunkIndex && completedShots.some((shot) =>
      shot.generationChunkIndex === index && (shot.generationStatus === "pending" || shot.generationStatus === "generating")
    ));
  let completedChunks = startChunkIndex;
  await runChunksIndependently(chunkIndexes, async (chunkIndex) => {
    throwIfAborted(signal, isClosed);
    onChunk({ type: "storyboard_chunk_started", chunkIndex, chunkTotal: plan.chunks.length, completedChunks });
    return generateStoryboardChunkAdaptive(plan.chunks[chunkIndex], plan.chunks, settings, analysis, chunkIndex, signal, 0, (event) => {
      onChunk(event);
    });
  }, (outcome, chunkIndex) => {
    completedChunks += 1;
    if (outcome.status === "completed") {
      const existingShotCount = completedShots.filter((shot) => (shot.generationChunkIndex ?? -1) < chunkIndex).length;
      const chunkShots = assignRuntimeFieldsForStoryboardChunk(outcome.value.shots, {
        existingShotCount,
        episodeCount: settings.episodeCount,
        language: settings.language,
        generationChunkIndex: chunkIndex
      });
      completedShots = replaceStoryboardChunkShots(completedShots, chunkIndex, chunkShots);
      notes.push(...outcome.value.notes);
      onChunk({
        type: "storyboard_chunk",
        chunkIndex,
        chunkTotal: plan.chunks.length,
        completedChunks,
        completedShots: countCompletedStoryboardShots(completedShots),
        shots: chunkShots,
        notes: outcome.value.notes
      });
    } else {
      completedShots = failStoryboardChunkShots(completedShots, chunkIndex, outcome.error);
      onChunk({ type: "storyboard_chunk_failed", chunkIndex, chunkTotal: plan.chunks.length, completedChunks, error: outcome.error });
    }
    onChunk({ type: "storyboard_progress", chunkIndex, chunkTotal: plan.chunks.length, finishedChunks: completedChunks, displayedChunks: completedChunks });
  }, signal);
  return { shots: assignEpisodeNumbers(completedShots, settings.episodeCount), notes };
}

async function regenerateStoryboardUnit(
  sourceText: string,
  settings: StorySettings,
  analysis: AnalysisResult,
  generationChunkIndex: number
): Promise<StoryboardShot[]> {
  const chunk = `【分镜单元 1】${sourceText}`;
  const result = await generateStoryboardChunkAdaptive(chunk, [chunk], settings, analysis, 0);
  return assignRuntimeFieldsForStoryboardChunk(result.shots, {
    existingShotCount: 0,
    episodeCount: settings.episodeCount,
    language: settings.language,
    generationChunkIndex
  });
}

async function generateStoryboardChunkAdaptive(
  chunk: string,
  allChunks: string[],
  settings: StorySettings,
  analysis: AnalysisResult,
  chunkIndex: number,
  signal?: AbortSignal,
  depth = 0,
  onRetry?: (event: Extract<GenerationStreamEvent, { type: "storyboard_retrying" }>) => void
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
    for (const [partIndex, subChunk] of subChunks.entries()) {
      throwIfAborted(signal);
      onRetry?.({
        type: "storyboard_retrying",
        chunkIndex,
        chunkTotal,
        depth: depth + 1,
        partIndex: partIndex + 1,
        partTotal: subChunks.length,
        reason: error instanceof Error ? error.message : String(error)
      });
      partials.push(await generateStoryboardChunkAdaptive(subChunk, allChunks, settings, analysis, chunkIndex, signal, depth + 1, onRetry));
    }

    return mergeStoryboardPartials(partials);
  }
}

function shouldSplitStoryboardChunk(error: unknown, chunk: string, depth: number): boolean {
  if (isContentFilterError(error)) return false;
  if (depth >= getMaxStoryboardAdaptiveSplitDepth()) return false;
  if (splitStoryboardChunkForRetry(chunk).length <= 1) return false;
  if (isRateLimitError(error)) return false;
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
  const matchedShots: RawStoryboardResult["shots"] = [];
  const narratorSpeaker = inferNarratorSpeakerName(analysis);
  let fallbackPreviousSpokenSpeaker = "";
  unitTexts.forEach((unitText, unitIndex) => {
    const shotIndex = findBestShotIndexForUnit(availableShots, unitText, unitIndex);
    const modelDialogueLines = shotIndex >= 0 ? availableShots[shotIndex].dialogueLines : [];
    const previousContextShot = selectPreviousShotForFallbackContext(unitText, matchedShots);
    const previousContextSpeaker = hasThirdPersonAttributionAfterQuote(unitText)
      ? getNearestNonNarratorCharacter(matchedShots) || getPrimaryContextCharacter(previousContextShot) || fallbackPreviousSpokenSpeaker
      : fallbackPreviousSpokenSpeaker || getPrimaryContextCharacter(previousContextShot);
    const sourceSpeech = deriveSpeechPartsFromSource(
      unitText,
      modelDialogueLines,
      previousContextSpeaker,
      narratorSpeaker
    );
    const matchedShot = shotIndex >= 0
      ? availableShots.splice(shotIndex, 1)[0]
      : createFallbackShot(unitText, {
        previousUnitText: unitTexts[unitIndex - 1],
        nextUnitText: unitTexts[unitIndex + 1],
        sceneAnchorText: buildNearbySceneAnchorText(unitTexts, unitIndex),
        previousShot: previousContextShot,
        dialogueLines: sourceSpeech.dialogueLines,
        directorNote: "保底修复镜头，用于补齐模型遗漏的原文分镜单元。"
      });
    matchedShots.push(matchedShot);
    fallbackPreviousSpokenSpeaker = getLastKnownDialogueSpeaker({
      ...matchedShot,
      dialogueLines: sourceSpeech.dialogueLines
    }) || fallbackPreviousSpokenSpeaker;
  });
  let previousSpokenSpeaker = "";
  const normalizedShots = matchedShots.map((shot, unitIndex) => {
    const unitText = unitTexts[unitIndex];
    const repairedShot = normalizeShotTextFields(shot, unitText, analysis, previousSpokenSpeaker);
    previousSpokenSpeaker = getLastKnownDialogueSpeaker(repairedShot) || previousSpokenSpeaker;
    return repairedShot;
  });
  const qualityIssues: QualityIssue[] = [];
  const repairedShots: RawStoryboardResult["shots"] = [];

  normalizedShots.forEach((shot, unitIndex) => {
    const reliability = assessShotReliability(shot, {
        unitText: unitTexts[unitIndex],
        previousUnitText: unitTexts[unitIndex - 1],
        nextUnitText: unitTexts[unitIndex + 1],
        sceneAnchorText: buildNearbySceneAnchorText(unitTexts, unitIndex),
        previousShot: selectPreviousShotForFallbackContext(unitTexts[unitIndex], repairedShots),
        analysis
      });
    qualityIssues.push(...reliability.issues);
    const reliableShot = reliability.shouldRewrite
      ? rewriteUnreliableShotWithFallbackContext(shot, {
        unitText: unitTexts[unitIndex],
        previousUnitText: unitTexts[unitIndex - 1],
        nextUnitText: unitTexts[unitIndex + 1],
        sceneAnchorText: buildNearbySceneAnchorText(unitTexts, unitIndex),
        previousShot: selectPreviousShotForFallbackContext(unitTexts[unitIndex], repairedShots),
        analysis,
        reasons: reliability.issues
      })
      : reliability.shouldRepairLocally
        ? repairShotWithLocalReliabilityCleanup(shot, {
          unitText: unitTexts[unitIndex],
          previousUnitText: unitTexts[unitIndex - 1],
          nextUnitText: unitTexts[unitIndex + 1],
          sceneAnchorText: buildNearbySceneAnchorText(unitTexts, unitIndex),
          previousShot: selectPreviousShotForFallbackContext(unitTexts[unitIndex], repairedShots),
          analysis,
          reasons: reliability.issues
        })
      : ensureCompletePromptForReliableShot(shot);
    repairedShots.push(cleanFinalVisualPlaceholderTerms(reliableShot));
  });

  return {
    shots: repairedShots,
    notes: qualityIssues.length > 0
      ? [...result.notes, renderQualityReportNote(qualityIssues)]
      : result.notes
  };
}

function selectPreviousShotForFallbackContext(
  unitText: string,
  matchedShots: RawStoryboardResult["shots"]
): RawStoryboardResult["shots"][number] | undefined {
  const immediatePreviousShot = matchedShots[matchedShots.length - 1];
  if (!/^(?:it|its)\b/i.test(unitText.trim())) return immediatePreviousShot;
  if (isCreatureOrObjectPronounAction(unitText)) {
    const previousCreatureShot = [...matchedShots].reverse().find((shot) => isLikelyCreatureOrObjectContinuationShot(shot));
    if (previousCreatureShot) return previousCreatureShot;
  }
  const previousNonNarratorSubject = [...matchedShots].reverse().find((shot) =>
    shot.characters.some((character) => !/第一人称主角|未指明说话者/i.test(character))
  );
  return previousNonNarratorSubject ?? immediatePreviousShot;
}

function isCreatureOrObjectPronounAction(text: string): boolean {
  return /^(?:it|its)\b/i.test(text.trim()) &&
    /(?:devour|devoured|feed|feeding|bite|bit|swallow|swallowed|scale|scales|mist|bone|scroll|dragon|beast|creature|core|crystal|egg)/i.test(text);
}

function isLikelyCreatureOrObjectContinuationShot(shot: RawStoryboardResult["shots"][number]): boolean {
  const text = `${shot.sourceText} ${shot.anchorSentence} ${shot.imageDescription} ${shot.characters.join(" ")}`;
  return /(?:Rage|dragon|beast|creature|gryphon|lizard|stag|egg|core|crystal|scroll|bone|marrow|scales?)/i.test(text) &&
    !/(?:Victoria|Elena|Arthur|Adam|Chloe|Vivian)\b/.test(shot.characters.join(" "));
}

function getPrimaryContextCharacter(shot: RawStoryboardResult["shots"][number] | undefined): string {
  return shot?.characters.find((character) =>
    !/第一人称主角|未指明说话者/i.test(character) &&
    !isPronounCharacterName(character) &&
    !isLikelySceneOrTitleName(character) &&
    !isLikelyFunctionWordOrTitleToken(character)
  ) ?? "";
}

function getNearestNonNarratorCharacter(shots: RawStoryboardResult["shots"]): string {
  for (const shot of [...shots].reverse()) {
    const character = getPrimaryContextCharacter(shot);
    if (character) return character;
  }
  return "";
}

function hasThirdPersonAttributionAfterQuote(text: string): boolean {
  return /["”’]\s*(?:he|she|they)\s+(?:said|asked|whispered|shouted|murmured|replied|cried|sobbed|snapped|answered|continued|added|barked|screamed|yelled|called|growled|hissed|demanded|ordered|muttered|gasped|pleaded|warned|insisted)\b/i.test(text);
}

function buildNearbySceneAnchorText(unitTexts: string[], unitIndex: number): string {
  const windowStart = Math.max(0, unitIndex - 2);
  const windowEnd = Math.min(unitTexts.length - 1, unitIndex + 6);
  const explicitSceneIndexes = unitTexts
    .map((unitText, index) => ({ unitText, index }))
    .filter(({ index }) => index >= windowStart && index <= windowEnd)
    .filter(({ unitText }) => inferStrongExplicitSceneNameFromText(unitText))
    .sort((left, right) => Math.abs(left.index - unitIndex) - Math.abs(right.index - unitIndex) || left.index - right.index)
    .slice(0, 2)
    .map(({ index }) => index);

  if (explicitSceneIndexes.length === 0) return "";

  const selectedIndexes = new Set<number>();
  explicitSceneIndexes.forEach((index) => {
    for (let nearbyIndex = Math.max(windowStart, index - 1); nearbyIndex <= Math.min(windowEnd, index + 2); nearbyIndex += 1) {
      selectedIndexes.add(nearbyIndex);
    }
  });

  return Array.from(selectedIndexes)
    .sort((left, right) => left - right)
    .map((index) => unitTexts[index])
    .join(" ");
}

interface ShotReliabilityContext {
  unitText: string;
  previousUnitText?: string;
  nextUnitText?: string;
  sceneAnchorText?: string;
  previousShot?: RawStoryboardResult["shots"][number];
  nextShot?: RawStoryboardResult["shots"][number];
  analysis?: AnalysisResult;
}

interface ShotReliabilityResult {
  shouldRewrite: boolean;
  shouldRepairLocally: boolean;
  issues: QualityIssue[];
}

function assessShotReliability(
  shot: RawStoryboardResult["shots"][number],
  context: ShotReliabilityContext
): ShotReliabilityResult {
  const issues: QualityIssue[] = [];
  const shotIndex = 1;
  const visualText = getShotVisualText(shot);
  const sourceText = context.unitText;
  const unsupportedSceneReason = getUnsupportedSceneReason(shot.scene, context);
  if (unsupportedSceneReason) {
    issues.push({
      code: "shot_scene_unreliable",
      severity: "auto_fixed",
      shotIndex,
      field: "scene",
      message: unsupportedSceneReason,
      evidence: { sourceText, offendingText: shot.scene },
      fixApplied: "使用当前分镜单元和相邻镜头重写场景。"
    });
  }

  const unsupportedCharacters = shot.characters.filter((character) =>
    !isCharacterSupportedByShotContext(character, context) && !isCharacterDialogueSpeakerInShot(character, shot)
  );
  if (unsupportedCharacters.length > 0) {
    issues.push({
      code: "shot_character_unreliable",
      severity: "auto_fixed",
      shotIndex,
      field: "characters",
      message: `角色缺少当前或相邻文本证据：${unsupportedCharacters.join("、")}。`,
      evidence: { sourceText, offendingText: unsupportedCharacters.join("、") },
      fixApplied: "移除无证据角色并重写画面主体。"
    });
  }

  const unsupportedNamedClaims = extractLikelyCharacterNames(visualText, [])
    .filter((name) => /[A-Za-z]/.test(name))
    .filter((name) => !isCharacterSupportedByShotContext(name, context) && !isCharacterDialogueSpeakerInShot(name, shot));
  unsupportedNamedClaims.push(...extractUnsupportedChineseNameClaims(visualText, context));
  if (unsupportedNamedClaims.length > 0) {
    issues.push({
      code: "shot_visual_named_claim_unreliable",
      severity: "auto_fixed",
      shotIndex,
      field: "imageDescription",
      message: `视觉行出现无证据命名人物：${unsupportedNamedClaims.join("、")}。`,
      evidence: { sourceText, offendingText: unsupportedNamedClaims.join("、") },
      fixApplied: "移除无证据命名人物并重写画面。"
    });
  }

  const unsupportedVisualSceneClaims = extractUnsupportedVisualSceneClaims(visualText, context);
  if (unsupportedVisualSceneClaims.length > 0) {
    issues.push({
      code: "shot_visual_scene_unreliable",
      severity: "auto_fixed",
      shotIndex,
      field: "imageDescription",
      message: `视觉行出现无证据具体场景：${unsupportedVisualSceneClaims.join("、")}。`,
      evidence: { sourceText, offendingText: unsupportedVisualSceneClaims.join("、") },
      fixApplied: "使用当前分镜单元和相邻镜头重写视觉场景。"
    });
  }

  const unsupportedEntityClaims = extractUnsupportedVisualEntityClaims(visualText, context);
  if (unsupportedEntityClaims.length > 0) {
    issues.push({
      code: "shot_visual_entity_unreliable",
      severity: "auto_fixed",
      shotIndex,
      field: "imageDescription",
      message: `视觉行出现无证据实体：${unsupportedEntityClaims.join("、")}。`,
      evidence: { sourceText, offendingText: unsupportedEntityClaims.join("、") },
      fixApplied: "用当前原文和相邻镜头重写视觉实体。"
    });
  }

  if (/基于原文的保守人物画面|执行当前句动作|空白背景|中，From\b|From承接/i.test(visualText)) {
    issues.push({
      code: "shot_visual_placeholder",
      severity: "auto_fixed",
      shotIndex,
      field: "imageDescription",
      message: "视觉字段包含占位、空白或标题词误识别表达。",
      evidence: { sourceText, offendingText: visualText.slice(0, 220) },
      fixApplied: "重写为具体可拍画面。"
    });
  }

  const shouldRewrite = issues.some((issue) => isHardReliabilityRewriteIssue(issue, shot, context));
  return {
    shouldRewrite,
    shouldRepairLocally: issues.length > 0 && !shouldRewrite,
    issues
  };
}

function isHardReliabilityRewriteIssue(
  issue: QualityIssue,
  shot?: RawStoryboardResult["shots"][number],
  context?: ShotReliabilityContext
): boolean {
  if (issue.code === "shot_visual_placeholder") return true;
  if (issue.code === "shot_scene_unreliable" || issue.code === "shot_visual_scene_unreliable") {
    const offendingText = issue.evidence?.offendingText ?? "";
    if (isLikelyNonVisualSceneLabel(offendingText)) return true;
    if (/医院|急救室|手术台|手术空间|operating table|operating room|hospital|emergency room/i.test(offendingText)) return true;
    if (!shot || !context) return true;
    return !hasLocallyUsableVisualAfterSceneCleanup(shot, context);
  }
  if (issue.code === "shot_visual_entity_unreliable" && /医院|手术空间/.test(issue.evidence?.offendingText ?? "")) return true;
  return false;
}

function hasLocallyUsableVisualAfterSceneCleanup(
  shot: RawStoryboardResult["shots"][number],
  context: ShotReliabilityContext
): boolean {
  if (isWorldbuildingFragment(context.unitText)) return false;
  const unsupportedSceneClaims = extractUnsupportedVisualSceneClaims(getShotVisualText(shot), context);
  const cleaned = stripUnsupportedVisualClaims(shot.imageDescription, {
    unsupportedNames: [],
    unsupportedSceneClaims,
    unsupportedEntityClaims: extractUnsupportedVisualEntityClaims(getShotVisualText(shot), context),
    removeGenericPeople: false,
    removeMedicalStaff: false
  });
  return hasMeaningfulVisualDescription(cleaned) &&
    visualDescriptionKeepsSourceAction(cleaned, context.unitText) &&
    !/空白背景|基于原文的保守人物画面|执行当前句动作|当前句动作/i.test(cleaned);
}

function visualDescriptionKeepsSourceAction(visualText: string, sourceText: string): boolean {
  const visual = normalizeForCoverage(visualText);
  const source = normalizeForCoverage(sourceText);
  const supportedTerms = [
    ...extractLikelyCharacterNames(sourceText, []),
    ...extractFirstPersonContextCharacters(sourceText),
    ...extractSourceVisualActionTerms(sourceText)
  ]
    .map(normalizeForCoverage)
    .filter((term) => term.length >= 2);
  if (supportedTerms.length === 0) return true;
  const hits = supportedTerms.filter((term) => visual.includes(term) || source.includes(term));
  return hits.some((term) => visual.includes(term)) && hits.length >= Math.min(2, supportedTerms.length);
}

function extractSourceVisualActionTerms(sourceText: string): string[] {
  const terms: string[] = [];
  const patterns = [
    { pattern: /silver necklace|银色项链|项链/i, term: /银色项链|项链/.test(sourceText) ? "银色项链" : "silver necklace" },
    { pattern: /look(?:ed|ing)?|stare(?:d)?|watch(?:ed)?|看|盯|凝视/i, term: /看|盯|凝视/.test(sourceText) ? "看" : "look" },
    { pattern: /silent|silence|沉默|没有说话/i, term: /沉默|没有说话/.test(sourceText) ? "沉默" : "silent" },
    { pattern: /photo|photos|照片/i, term: /照片/.test(sourceText) ? "照片" : "photo" },
    { pattern: /stand|stood|站/i, term: /站/.test(sourceText) ? "站" : "stand" },
    { pattern: /hand|palm|finger|手|掌心|手指/i, term: /手|掌心|手指/.test(sourceText) ? "手" : "hand" }
  ];
  for (const item of patterns) {
    if (item.pattern.test(sourceText)) terms.push(item.term);
  }
  return terms;
}

function repairShotWithLocalReliabilityCleanup(
  shot: RawStoryboardResult["shots"][number],
  context: ShotReliabilityContext & { reasons: QualityIssue[] }
): RawStoryboardResult["shots"][number] {
  const unsupportedCharacters = shot.characters.filter((character) =>
    !isCharacterSupportedByShotContext(character, context) && !isCharacterDialogueSpeakerInShot(character, shot)
  );
  const unsupportedNamedClaims = context.reasons
    .filter((issue) => issue.code === "shot_visual_named_claim_unreliable")
    .flatMap((issue) => splitOffendingTerms(issue.evidence?.offendingText ?? ""));
  const unsupportedEntityClaims = context.reasons
    .filter((issue) => issue.code === "shot_visual_entity_unreliable")
    .flatMap((issue) => splitOffendingTerms(issue.evidence?.offendingText ?? ""));
  const unsupportedSceneClaims = context.reasons
    .filter((issue) => issue.code === "shot_visual_scene_unreliable")
    .flatMap((issue) => splitOffendingTerms(issue.evidence?.offendingText ?? ""));
  const cleanupOptions = {
    unsupportedNames: Array.from(new Set([...unsupportedCharacters, ...unsupportedNamedClaims])),
    unsupportedSceneClaims: Array.from(new Set(unsupportedSceneClaims)),
    unsupportedEntityClaims: Array.from(new Set(unsupportedEntityClaims)),
    removeGenericPeople: unsupportedEntityClaims.some((claim) => /泛称人物/.test(claim)),
    removeMedicalStaff: unsupportedEntityClaims.some((claim) => /医生|医护人员/.test(claim))
  };
  const cleanedCharacters = shot.characters.filter((character) =>
    isCharacterSupportedByShotContext(character, context) || isCharacterDialogueSpeakerInShot(character, shot)
  );
  const cleanedImageDescription = stripUnsupportedVisualClaims(shot.imageDescription, cleanupOptions);
  const cleanedPrompt = stripUnsupportedVisualClaimsFromPrompt(shot.prompt, cleanupOptions);
  const cleanedScene = context.reasons.some((issue) => issue.code === "shot_scene_unreliable")
    ? inferLocalReliableScene(shot.scene, context)
    : shot.scene;

  if (!hasMeaningfulVisualDescription(cleanedImageDescription) || visualTextStillHasUnsupportedClaims(cleanedImageDescription, cleanupOptions)) {
    const fallback = createFallbackShot(context.unitText, {
      previousUnitText: context.previousUnitText,
      nextUnitText: context.nextUnitText,
      sceneAnchorText: context.sceneAnchorText,
      previousShot: context.previousShot,
      nextShot: context.nextShot,
      directorNote: "视觉局部修复镜头，移除无证据人物或实体后补齐可拍画面。"
    });
    return normalizeShotTextFields({
      ...fallback,
      narration: shot.narration,
      dialogueLines: shot.dialogueLines,
      emotion: shot.emotion || fallback.emotion
    }, context.unitText, context.analysis);
  }

  const completeShot = ensureCompletePromptForReliableShot({
    ...shot,
    characters: cleanedCharacters,
    scene: cleanedScene,
    imageDescription: cleanedImageDescription,
    prompt: cleanedPrompt
  });
  return {
    ...completeShot,
    prompt: appendDirectorNote(completeShot.prompt, "视觉局部修复：移除无证据人物或实体，保留模型原有可用画面。")
  };
}

function splitOffendingTerms(value: string): string[] {
  return value
    .split(/[、,，;]/)
    .map((term) => term.trim())
    .filter(Boolean);
}

function stripUnsupportedVisualClaimsFromPrompt(
  prompt: string,
  options: {
    unsupportedNames: string[];
    unsupportedSceneClaims: string[];
    unsupportedEntityClaims: string[];
    removeGenericPeople: boolean;
    removeMedicalStaff: boolean;
  }
): string {
  return prompt
    .split("\n")
    .map((line) => line.trimStart().startsWith("[台词/旁白]") ? line : stripUnsupportedVisualClaims(line, options))
    .join("\n");
}

function stripUnsupportedVisualClaims(
  value: string,
  options: {
    unsupportedNames: string[];
    unsupportedSceneClaims: string[];
    unsupportedEntityClaims: string[];
    removeGenericPeople: boolean;
    removeMedicalStaff: boolean;
  }
): string {
  let text = value;
  for (const name of options.unsupportedNames) {
    text = stripUnsupportedNamedClaim(text, name);
  }
  for (const scene of options.unsupportedSceneClaims) {
    text = stripUnsupportedSceneClaim(text, scene);
  }
  for (const entity of options.unsupportedEntityClaims) {
    text = stripUnsupportedEntityClaim(text, entity);
  }
  if (options.removeGenericPeople) text = stripUnsupportedGenericPeopleClaims(text);
  if (options.removeMedicalStaff) text = stripUnsupportedMedicalStaffClaims(text);
  return cleanupVisualClaimRemoval(text);
}

function stripUnsupportedSceneClaim(value: string, scene: string): string {
  if (/顶层公寓|penthouse/i.test(scene)) {
    return value
      .replace(/(?:顶层公寓|penthouse apartment)(?:里|中|内|inside|in)?[，,\s]*/gi, "")
      .replace(/(?:坐在|坐到|站在|靠在)?(?:沙发|sofa)(?:边|上|旁|旁边|附近)?[，,\s]*/gi, "");
  }
  const cleanScene = scene.trim();
  if (!cleanScene) return value;
  return stripUnsupportedNamedClaim(value, cleanScene);
}

function stripUnsupportedEntityClaim(value: string, entity: string): string {
  if (/沙发|sofa/i.test(entity)) {
    return value.replace(/(?:坐在|坐到|站在|靠在)?(?:沙发|sofa)(?:边|上|旁|旁边|附近)?[，,\s]*/gi, "");
  }
  return value;
}

function stripUnsupportedNamedClaim(value: string, name: string): string {
  const cleanName = name.trim();
  if (!cleanName) return value;
  const escaped = escapeRegExp(cleanName);
  const hasLatin = /[A-Za-z]/.test(cleanName);
  const pattern = hasLatin
    ? new RegExp(`(?:[，,；;]\\s*)?[^，。；;,.\\n]*\\b${escaped}\\b[^，。；;,.\\n]*(?=[，。；;,.\\n]|$)`, "gi")
    : new RegExp(`(?:[，,；;]\\s*)?[^，。；;,.\\n]*${escaped}[^，。；;,.\\n]*(?=[，。；;,.\\n]|$)`, "g");
  return value.replace(pattern, "");
}

function stripUnsupportedGenericPeopleClaims(value: string): string {
  return value
    .replace(/\s+(?:while|as|and)\s+(?:someone|somebody|a person|another person|a stranger|a passer-?by|a man|a woman|a boy|a girl|an observer)\b[^，。；;,. \n]*(?:\s+[^，。；;,. \n]+)*/gi, "")
    .replace(/(?:^|[，,；;]\s*)(?:一个|一名|几名|多名)?(?:女孩|女人|男人|男孩|陌生人|路人|行人|旁观者)[^，。；;,.]*(?=[，。；;,.]|$)/g, "")
    .replace(/(?:^|[,;]\s*)(?:someone|somebody|a person|another person|a stranger|a passer-?by|a man|a woman|a boy|a girl|an observer)\b[^，。；;,.]*(?=[，。；;,.]|$)/gi, "");
}

function stripUnsupportedMedicalStaffClaims(value: string): string {
  return value
    .replace(/\s+(?:while|as|and)\s+(?:a\s+)?(?:doctor|nurse|medical worker|medical staff)\b[^，。；;,.]*(?=[，。；;,.]|$)/gi, "")
    .replace(/(?:^|[，,；;]\s*)(?:一个|一名|几名|多名)?(?:医生|护士|医护人员)[^，。；;,.]*(?=[，。；;,.]|$)/g, "")
    .replace(/(?:^|[,;]\s*)(?:a\s+)?(?:doctor|nurse|medical worker|medical staff)\b[^，。；;,.]*(?=[，。；;,.]|$)/gi, "");
}

function cleanupVisualClaimRemoval(value: string): string {
  return value
    .replace(/\s+([，。；;,.])/g, "$1")
    .replace(/[，,；;]\s*([。,.])/g, "$1")
    .replace(/[，,；;]\s*$/g, "")
    .replace(/([：:])\s*[。,.；;]?$/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function hasMeaningfulVisualDescription(value: string): boolean {
  const clean = value
    .replace(/\[[^\]]+\]/g, "")
    .replace(/[：:，,。.;；\s]/g, "")
    .trim();
  return clean.length >= 8;
}

function visualTextStillHasUnsupportedClaims(
  value: string,
  options: {
    unsupportedNames: string[];
    unsupportedSceneClaims: string[];
    unsupportedEntityClaims: string[];
    removeGenericPeople: boolean;
    removeMedicalStaff: boolean;
  }
): boolean {
  return options.unsupportedNames.some((name) => name && value.includes(name)) ||
    options.unsupportedSceneClaims.some((scene) => scene && sceneClaimStillPresent(value, scene)) ||
    options.unsupportedEntityClaims.some((entity) => entity && entityClaimStillPresent(value, entity)) ||
    (options.removeGenericPeople && /女孩|girl|女人|woman|男人|man|boy|男孩|旁观者|observer|一个人|陌生人|路人|行人|someone|somebody|person|stranger|passerby|passer-by|another person/i.test(value)) ||
    (options.removeMedicalStaff && /医生|doctor|doctors|nurse|护士|医护人员/i.test(value));
}

function sceneClaimStillPresent(value: string, scene: string): boolean {
  if (/顶层公寓|penthouse/i.test(scene)) return /顶层公寓|penthouse|沙发|sofa/i.test(value);
  return value.includes(scene);
}

function entityClaimStillPresent(value: string, entity: string): boolean {
  if (/沙发|sofa/i.test(entity)) return /沙发|sofa/i.test(value);
  return value.includes(entity);
}

function inferLocalReliableScene(scene: string, context: ShotReliabilityContext): string {
  const inherited = selectFallbackInheritedScene(context);
  if (inherited) return inherited;
  const fallback = inferFallbackScene(context.unitText);
  return /当前连续场景|世界观建立画面|未(?:明确|指明)场景/.test(scene) ? fallback : "当前连续场景";
}

function appendDirectorNote(prompt: string, note: string): string {
  if (prompt.includes(note)) return prompt;
  const lines = prompt.split("\n");
  const directorIndex = lines.findIndex((line) => line.trimStart().startsWith("[导演批注]"));
  if (directorIndex >= 0) {
    lines[directorIndex] = `${lines[directorIndex].replace(/[；;。.\s]*$/g, "")}；${note}`;
    return lines.join("\n");
  }
  return [...lines, `[导演批注] ${note}`].join("\n");
}

function rewriteUnreliableShotWithFallbackContext(
  shot: RawStoryboardResult["shots"][number],
  context: ShotReliabilityContext & { reasons: QualityIssue[] }
): RawStoryboardResult["shots"][number] {
  const fallback = createFallbackShot(context.unitText, {
    previousUnitText: context.previousUnitText,
    nextUnitText: context.nextUnitText,
    sceneAnchorText: context.sceneAnchorText,
    previousShot: context.previousShot,
    nextShot: context.nextShot,
    dialogueLines: shot.dialogueLines,
    directorNote: "可靠性修复镜头，依据当前分镜单元与相邻镜头重写，移除无证据人物、场景或动作。"
  });
  return normalizeShotTextFields({
    ...fallback,
    narration: shot.narration,
    dialogueLines: shot.dialogueLines,
    emotion: shot.emotion || fallback.emotion
  }, context.unitText, context.analysis);
}

function ensureCompletePromptForReliableShot(
  shot: RawStoryboardResult["shots"][number]
): RawStoryboardResult["shots"][number] {
  if (hasRequiredPromptLines(shot.prompt) && promptHasCinematicCompleteness(shot.prompt, shot)) return shot;
  const imageDescription = enrichImageDescriptionForCinematicPrompt(shot);
  const shotGrammarLine = `[镜头语法 / ${inferFallbackShotGrammar(shot.sourceText, shot.shotType)}]`;
  const imageLine = `[画面细节] ${imageDescription}`;
  const cameraFocusSubject = inferFallbackFocusSubject(shot.sourceText, shot.characters);
  const cameraLine = `[摄影机补充状态] ${inferFallbackCameraState(shot.sourceText, cameraFocusSubject, shot.scene || "当前连续场景")}`;
  const prompt = hasRequiredPromptLines(shot.prompt)
    ? replacePromptVisualProductionLines(shot.prompt, {
      shotGrammarLine,
      imageLine,
      cameraLine
    })
    : buildCompletePromptFromScratch(shot, {
      shotGrammarLine,
      imageLine,
      cameraLine
    });
  return {
    ...shot,
    imageDescription,
    prompt
  };
}

function replacePromptVisualProductionLines(
  prompt: string,
  replacements: {
    shotGrammarLine: string;
    imageLine: string;
    cameraLine: string;
  }
): string {
  return prompt.split("\n").map((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("[镜头语法")) return replacements.shotGrammarLine;
    if (trimmed.startsWith("[画面细节]")) return replacements.imageLine;
    if (trimmed.startsWith("[摄影机补充状态]")) return replacements.cameraLine;
    return line;
  }).join("\n");
}

function buildCompletePromptFromScratch(
  shot: RawStoryboardResult["shots"][number],
  replacements: {
    shotGrammarLine: string;
    imageLine: string;
    cameraLine: string;
  }
): string {
  const speechLine = shot.prompt
    .split("\n")
    .find((line) => line.trimStart().startsWith("[台词/旁白]"))
    ?.trim() || renderSpeechLine(shot.narration, shot.dialogueLines);
  return [
    "[00:00-00:04s]",
    replacements.shotGrammarLine,
    replacements.imageLine,
    replacements.cameraLine,
    "[声音设计] 环境声低铺，跟随旁白节奏。",
    speechLine,
    "[导演批注] 提示词格式修复，补齐固定结构与当前场景光源描述。"
  ].join("\n");
}

function promptHasCinematicCompleteness(
  prompt: string,
  shot: RawStoryboardResult["shots"][number]
): boolean {
  const visualLine = prompt
    .split("\n")
    .find((line) => line.trimStart().startsWith("[画面细节]")) ?? "";
  const cameraLine = prompt
    .split("\n")
    .find((line) => line.trimStart().startsWith("[摄影机补充状态]")) ?? "";
  return promptImageDescriptionHasLight(visualLine) &&
    promptVisualLineHasSpatialDepth(visualLine) &&
    promptVisualLineHasSubjectPerformance(visualLine, shot) &&
    promptCameraLineHasDepthAndLens(cameraLine, prompt);
}

function promptVisualLineHasSpatialDepth(value: string): boolean {
  return /前景.*(?:中景|背景|后景)|中景.*背景|空间层次|纵深|景深|虚化|入口.*背景|门框.*背景|走廊深处|地面延伸|背景.*轻微虚化/.test(value);
}

function promptVisualLineHasSubjectPerformance(
  value: string,
  shot: RawStoryboardResult["shots"][number]
): boolean {
  if (isWideOrWorldbuildingShot(shot.sourceText, shot.shotType)) {
    return /站位|动线|空间|入口|环境|道具|符号|墙面|地面|前景|背景/.test(value);
  }
  if (isCloseShot(shot.sourceText, shot.shotType)) {
    const detailHits = [
      /嘴角|下颌|唇/.test(value),
      /眼部|眼神|眼眶|瞳孔|眉/.test(value),
      /面部|脸侧|面部肌肉/.test(value),
      /视线/.test(value)
    ].filter(Boolean).length;
    return detailHits >= 3;
  }
  return /动作|站位|身体|姿态|朝向|手部|视线|移动|停住|握|抬起|低头|看/.test(value);
}

function promptCameraLineHasDepthAndLens(cameraLine: string, prompt: string): boolean {
  return /(?:24mm|35mm|50mm|70mm|85mm)/i.test(prompt) &&
    /景深|虚化|跟焦|焦平面|焦点从|焦点锁定|背景压缩/i.test(cameraLine);
}

function enrichImageDescriptionForCinematicPrompt(shot: RawStoryboardResult["shots"][number]): string {
  const scene = normalizePromptSceneName(shot.scene, shot.sourceText);
  const focusSubject = inferFallbackFocusSubject(shot.sourceText, shot.characters);
  const actionPhrase = summarizeFallbackAction(shot.sourceText, focusSubject, scene);
  const base = hasMeaningfulVisualDescription(shot.imageDescription)
    ? normalizeVisualDescriptionSegment(shot.imageDescription)
    : `${scene}中，${actionPhrase}`;
  const hasSpatialDepth = promptVisualLineHasSpatialDepth(base);
  const hasSubjectPerformance = promptVisualLineHasSubjectPerformance(base, shot);
  const hasLight = promptImageDescriptionHasLight(base);
  return dedupeVisualDescriptionSegments([
    base,
    hasSpatialDepth ? "" : inferSceneDepthPhrase(scene, shot.sourceText, focusSubject),
    hasSubjectPerformance ? "" : inferPerformancePhrase(shot.sourceText, shot.shotType, focusSubject),
    hasLight ? "" : inferFallbackLight(scene, shot.sourceText)
  ]);
}

function dedupeVisualDescriptionSegments(segments: string[]): string {
  const seen = new Set<string>();
  const uniqueSegments = segments
    .flatMap((segment) => normalizeVisualDescriptionSegment(segment).split(/[；;]+/))
    .map((segment) => normalizeVisualDescriptionSegment(segment))
    .filter((segment) => {
      if (!segment) return false;
      const key = normalizeForCoverage(segment);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return `${uniqueSegments.join("；")}。`;
}

function normalizeVisualDescriptionSegment(value: string): string {
  return stripTrailingPunctuation(value)
    .replace(/^[，,；;。.\s]+/g, "")
    .trim();
}

function normalizePromptSceneName(scene: string, sourceText: string): string {
  const cleanScene = scene.trim();
  if (cleanScene && !/未(?:明确|指明)场景/.test(cleanScene)) return cleanScene;
  return inferStrongExplicitSceneNameFromText(sourceText) || inferFallbackScene(sourceText);
}

function stripTrailingPunctuation(value: string): string {
  return value.trim().replace(/[。.;；\s]+$/g, "");
}

function normalizeExistingLightPhrase(value: string): string {
  const clean = stripTrailingPunctuation(value);
  if (/主光|阴影|轮廓|高光|边光|逆光/.test(clean)) return "";
  return "当前场景主光源从侧上方落下，人物脸侧和可见道具边缘形成柔和高光，背景阴影保留层次";
}

function inferPerformancePhrase(sourceText: string, shotType: string, focusSubject: string): string {
  const sceneTarget = inferSceneInteractionTarget("", sourceText);
  if (isNonHumanFallbackSubject(focusSubject)) {
    return `${focusSubject}作为静态视觉元素呈现，表面纹理、亮度变化和邻近物件距离关系保持清楚`;
  }
  if (isWideOrWorldbuildingShot(sourceText, shotType)) {
    return "空间入口、环境符号和可见道具保持清楚，画面纵深支撑旁白信息";
  }
  if (isCloseShot(sourceText, shotType)) {
    return `${focusSubject}嘴角绷紧，眼部停在对方或${sceneTarget}上，面部肌肉保持压抑状态，视线方向明确`;
  }
  return `${focusSubject}身体朝向对方或${sceneTarget}，手部动作、站位距离和视线关系保持清楚`;
}

function inferSceneDepthPhrase(scene: string, sourceText: string, focusSubject: string): string {
  if (isWorldbuildingFragment(sourceText)) {
    return `${scene}以建立镜头呈现，前景保留空间入口，中景落在环境符号，背景墙面和通道保持纵深`;
  }
  if (isNonHumanFallbackSubject(focusSubject)) {
    return `${scene}里前景保留空间边缘，中景落在${focusSubject}的纹理或铭牌信息，背景陈列轻微虚化`;
  }
  if (/vault|treasury|宝库|altar|core crystal/i.test(`${scene} ${sourceText}`)) {
    return `${scene}里前景保留厚重门框或陈列台边缘，中景落在${focusSubject}，背景的封印架、祭坛和藏品轮廓轻微虚化`;
  }
  if (/走廊|门口|corridor|hallway|door/i.test(`${scene} ${sourceText}`)) {
    return `${scene}里前景保留门框或墙面边缘，中景落在${focusSubject}，背景走廊深处轻微虚化`;
  }
  if (/室外|街|street|outside/i.test(`${scene} ${sourceText}`)) {
    return `${scene}里前景保留地面或街边轮廓，中景落在${focusSubject}，背景建筑和路灯形成纵深`;
  }
  return `${scene}里前景保留地面纹理、桌沿或墙面边缘，中景落在${focusSubject}，背景陈设轻微虚化`;
}

function isCloseShot(sourceText: string, shotType: string): boolean {
  return /近景|特写|close|close-up|face|eyes|look|stare|whisper|低声|眼|脸|看/i.test(`${sourceText} ${shotType}`);
}

function isWideOrWorldbuildingShot(sourceText: string, shotType: string): boolean {
  return isWorldbuildingFragment(sourceText) || /空镜|建立|全景|远景|wide|establishing/i.test(shotType);
}

function inferFallbackShotGrammar(sourceText: string, shotType: string): string {
  if (isWideOrWorldbuildingShot(sourceText, shotType)) {
    return `客观视角 / ${shotType || "建立镜头"} / 24mm / 深景深，焦点覆盖前中后景 // 稳定横移或缓慢推进`;
  }
  if (isCloseShot(sourceText, shotType)) {
    const lens = /eyes|眼|脸|face|特写/i.test(`${sourceText} ${shotType}`) ? "85mm" : "70mm";
    return `客观视角 / ${shotType || "近景"} / ${lens} / 浅景深，焦点锁定人物眼部或场景锚点 // 稳定缓慢推进`;
  }
  if (/(?:walk|run|stagger|storm|走|跑|冲|踉跄|移动)/i.test(sourceText)) {
    return `客观视角 / ${shotType || "中景"} / 35mm -> 50mm / 跟焦主体动作，背景轻微虚化 // 稳定跟拍推进`;
  }
  if (/(?:reach|grab|hold|clench|grip|伸手|抓|握|攥|拿)/i.test(sourceText)) {
    return `客观视角 / ${shotType || "中景"} / 50mm / 浅景深，焦点从手部动作压到场景锚点 // 稳定短推进`;
  }
  return `客观视角 / ${shotType || "中景"} / 50mm / 中等景深，焦点锁定主体动作，背景轻微虚化 // 稳定推进`;
}

function getShotVisualText(shot: RawStoryboardResult["shots"][number]): string {
  return [
    shot.scene,
    shot.imageDescription,
    shot.shotType,
    shot.emotion,
    shot.prompt
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("[台词/旁白]"))
      .join(" ")
  ].join(" ");
}

function getUnsupportedSceneReason(scene: string, context: ShotReliabilityContext): string {
  const cleanScene = scene.trim();
  if (!cleanScene || /未(?:明确|指明)场景/.test(cleanScene)) return "";
  if (/空白背景/.test(cleanScene) || isLikelyNonVisualSceneLabel(cleanScene)) {
    return "场景为空、未明确或像标题词，不能作为可靠画面场景。";
  }
  const inheritedScene = selectFallbackInheritedScene(context);
  const nearbyAnchoredScene = shouldUseNearbySceneAnchorForFallback(context.unitText)
    ? inferStrongExplicitSceneNameFromText(context.sceneAnchorText ?? "")
    : "";
  if (/当前连续场景|世界观建立画面/.test(cleanScene)) {
    const supportedReplacement = inheritedScene || nearbyAnchoredScene;
    return supportedReplacement
      ? `附近原文或相邻镜头已有明确场景锚点“${supportedReplacement}”，但模型场景仍是泛化场景“${cleanScene}”。`
      : "";
  }
  if (/前世记忆画面/.test(cleanScene) && nearbyAnchoredScene) {
    return `当前分镜单元是抽象世界观信息，附近原文已有明确场景锚点“${nearbyAnchoredScene}”，不应降级为泛化记忆场景。`;
  }

  const currentSceneKey = inferExplicitSceneKeyFromText(context.unitText);
  const shotSceneKey = getSceneKey(cleanScene);
  if (currentSceneKey && shotSceneKey && !areSceneKeysCompatible(currentSceneKey, shotSceneKey)) {
    return `当前分镜单元明确指向 ${currentSceneKey}，但模型场景为 ${cleanScene}。`;
  }
  if (currentSceneKey && (!shotSceneKey || currentSceneKey === shotSceneKey)) return "";
  if (isSceneSupportedByValidatedAnalysis(cleanScene, context)) return "";
  if (isInheritedSceneSupported(cleanScene, context.previousShot, context.previousUnitText)) return "";
  if (isInheritedSceneSupported(cleanScene, context.nextShot, context.nextUnitText)) return "";
  if (isSceneFieldSupportedBySource(cleanScene, getShotEvidenceText(context))) return "";
  return `场景“${cleanScene}”缺少当前分镜单元、相邻单元或已验证理解档案支撑。`;
}

function isSceneSupportedByValidatedAnalysis(scene: string, context: ShotReliabilityContext): boolean {
  if (!context.analysis) return false;
  const validated = validateAnalysisResultAgainstSource(context.analysis, getShotEvidenceText(context), 0);
  const sceneKey = getSceneKey(scene);
  return validated.scenes.some((item) => {
    const itemKey = getSceneKey(`${item.name} ${item.location}`);
    return itemKey && sceneKey && itemKey === sceneKey;
  });
}

function isInheritedSceneSupported(
  scene: string,
  adjacentShot: RawStoryboardResult["shots"][number] | undefined,
  adjacentUnitText: string | undefined
): boolean {
  if (!adjacentShot?.scene || !sceneCanBeInheritedFromAdjacent(adjacentShot.scene, adjacentUnitText)) return false;
  const sceneKey = getSceneKey(scene);
  const adjacentSceneKey = getSceneKey(adjacentShot.scene);
    return Boolean(sceneKey && adjacentSceneKey && areSceneKeysCompatible(sceneKey, adjacentSceneKey));
}

function isCharacterSupportedByShotContext(character: string, context: ShotReliabilityContext): boolean {
  const name = character.trim();
  if (!name || isPronounCharacterName(name) || isLikelyFunctionWordOrTitleToken(name) || isLikelySceneOrTitleName(name)) return false;
  const evidenceText = getCharacterEvidenceText(context);
  if (name === "第一人称主角" && /\b(?:i|me|my|mine|we|us|our|ours)\b|我|我们|我的/i.test(evidenceText)) return true;
  if (isTermSupportedBySource(name, evidenceText)) return true;
  if (context.previousShot?.characters.some((item) => sameEntityName(item, name)) && startsWithPronoun(context.unitText)) return true;
  if (context.analysis) {
    const validated = validateAnalysisResultAgainstSource(context.analysis, evidenceText, 0);
    return validated.characters.some((item) => sameEntityName(item.name, name));
  }
  return false;
}

function isCharacterDialogueSpeakerInShot(
  character: string,
  shot: RawStoryboardResult["shots"][number]
): boolean {
  const name = normalizeSpeakerName(character);
  if (!name || name === "未指明说话者") return false;
  return shot.dialogueLines.some((line) => sameEntityName(normalizeSpeakerName(line.speaker), name));
}

function sameEntityName(left: string, right: string): boolean {
  return normalizeForCoverage(left) === normalizeForCoverage(right);
}

function startsWithPronoun(text: string): boolean {
  return /^(?:he|his|him|she|her|they|their|them|it|its|他|她|它)\b/i.test(text.trim());
}

function getCharacterEvidenceText(context: ShotReliabilityContext): string {
  return context.unitText;
}

function getShotEvidenceText(context: ShotReliabilityContext): string {
  return [
    context.previousUnitText,
    context.unitText,
    context.nextUnitText
  ].filter(Boolean).join(" ");
}

function extractUnsupportedVisualSceneClaims(visualText: string, context: ShotReliabilityContext): string[] {
  const claims = extractConcreteSceneClaimsFromText(visualText);
  return claims.filter((scene) => getUnsupportedSceneReason(scene, context));
}

function extractConcreteSceneClaimsFromText(text: string): string[] {
  const sceneHints = [
    { pattern: /penthouse apartment|顶层公寓/i, scene: "顶层公寓" },
    { pattern: /summoning hall|召唤大厅|aurelia academy|binding rite/i, scene: "Summoning Hall" },
    { pattern: /corridor|hallway|走廊|楼道/i, scene: "走廊" },
    { pattern: /basement|地下室/i, scene: "地下室" },
    { pattern: /hospital|emergency room|急救室|医院|手术台|operating table|operating room/i, scene: "医院急救室" },
    { pattern: /street|road|outside|街|路边|室外/i, scene: "室外街道" },
    { pattern: /bedroom|卧室/i, scene: "卧室" },
    { pattern: /\broom\b|apartment|房间|公寓|室内/i, scene: "室内房间" }
  ];
  const claims: string[] = [];
  for (const hint of sceneHints) {
    if (hint.pattern.test(text)) claims.push(hint.scene);
  }
  return Array.from(new Set(claims));
}

function extractUnsupportedVisualEntityClaims(visualText: string, context: ShotReliabilityContext): string[] {
  const claims: string[] = [];
  const evidenceText = getShotEvidenceText(context);
  const sceneKey = inferExplicitSceneKeyFromText(evidenceText);
  const hasMedicalStaffEvidence = /doctor|doctors|nurse|nurses|医生|护士|医护/i.test(evidenceText);
  const hasHospitalSpaceEvidence = sceneKey === "hospital" || /急救|医院|emergency room|hospital|operating table|operating room|surgery room|手术台|手术室/i.test(evidenceText);
  if (/(?:医生|doctor|doctors|nurse|护士)/i.test(visualText) && !hasMedicalStaffEvidence) claims.push("医生/医护人员");
  if (/(?:医院|急救室|手术台|operating table|operating room|hospital|emergency room)/i.test(visualText) && !hasHospitalSpaceEvidence) claims.push("医院/手术空间");
  if (/(?:女孩|girl|女人|woman|男人|man|boy|男孩|旁观者|observer|一个人|陌生人|路人|行人|someone|somebody|person|stranger|passerby|passer-by|another person)/i.test(visualText) &&
    !/(?:女孩|girl|女人|woman|男人|man|boy|男孩|旁观者|observer|一个人|陌生人|路人|行人|someone|somebody|person|stranger|passerby|passer-by|another person)/i.test(evidenceText)) {
    claims.push("泛称人物");
  }
  return Array.from(new Set(claims));
}

function extractUnsupportedChineseNameClaims(visualText: string, context: ShotReliabilityContext): string[] {
  const candidates = new Set<string>();
  const patterns = [
    /(?<![\u4e00-\u9fa5])([\u4e00-\u9fa5]{2,4})(?=站|坐|走|跑|看|盯|冷笑|哭|喊|说|低声|沉默|后退|靠近|伸手|跪|躲|转身)/g,
    /(?<![\u4e00-\u9fa5])([\u4e00-\u9fa5]{2,4})(?:站在|坐在|走到|看着|盯着|靠近|后退|冷笑|沉默)/g,
    /(?:旁边|身边|门口|角落)([\u4e00-\u9fa5]{2,3})(?:站|坐|看|冷笑|记录)/g
  ];
  for (const pattern of patterns) {
    for (const match of visualText.matchAll(pattern)) {
      const candidate = match[1]?.trim();
      if (!candidate || isLikelyChineseNonNameClaim(candidate)) continue;
      candidates.add(candidate);
    }
  }
  return Array.from(candidates).filter((candidate) => !isCharacterSupportedByShotContext(candidate, context));
}

function isLikelyChineseNonNameClaim(value: string): boolean {
  if (/(?:没有|不是|不会|不能|已经|还是|正在|一直|久久|突然|缓慢|轻轻|慢慢|桌上|银色|当前|关键|空间|人物|主角|对白|平稳|停顿|方向|镜头|视觉|身体|手部|眼部|面部|嘴角|低头|抬头|掌心|肩膀|手指|边缘|背景|保持|柔和|主光|阴影|亮度|项链)/.test(value)) return true;
  return /^(?:走廊|楼道|门边|门口|房间|室内|公寓|顶层|医院|急救|医生|女孩|女人|男人|男孩|旁边|身边|画面|镜头|光线|灯光|阴影|项链|照片|手术|空间|主体|道具|身体|视线|情绪|背景|桌上|银色)$/.test(value);
}

function promptVisualLineHasLight(prompt: string): boolean {
  const visualLine = prompt
    .split("\n")
    .find((line) => line.trimStart().startsWith("[画面细节]")) ?? "";
  return promptImageDescriptionHasLight(visualLine);
}

function promptImageDescriptionHasLight(value: string): boolean {
  return /(?:主光|侧上方|侧后方|顶灯|吊灯|窗外|屏幕光|边光|逆光|高光|阴影|轮廓|冷白光|柔光|硬光|key light|rim light|shadow)/i.test(value);
}

function qualityCheckStoryboardChunkResult(result: RawStoryboardResult, chunk: string): QualityCheckedStoryboardResult {
  const unitTexts = parseStoryboardUnitTexts(chunk);
  const qualityReport: QualityIssue[] = [];
  let previousSpokenSpeaker = "";

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
    const sourceSpeech = deriveSpeechPartsFromSource(sourceText, shot.dialogueLines, previousSpokenSpeaker);
    const hasSourceDialogue = sourceSpeech.dialogueLines.length > 0;
    const expectedSpeechLine = hasSourceDialogue
      ? renderOrderedSpeechLine(sourceSpeech.orderedSpeechParts)
      : renderSpeechLine(shot.narration, shot.dialogueLines);
    previousSpokenSpeaker = getLastKnownDialogueSpeaker({
      ...shot,
      dialogueLines: hasSourceDialogue ? sourceSpeech.dialogueLines : shot.dialogueLines
    }) || previousSpokenSpeaker;
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
  return normalizeForCoverage(stripSpeechControlMarks(speechLine)) === normalizeForCoverage(stripSpeechControlMarks(expectedSpeechLine));
}

function stripSpeechControlMarks(value: string): string {
  return value.replace(/；?【停顿0\.(?:4|8)s(?:，[^】]+)?】；?/g, "；");
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

  const scoredIndex = shots
    .map((shot, index) => ({
      index,
      score: getShotUnitMatchTexts(shot).reduce((best, candidate) => {
        return Math.max(best, scoreNormalizedTextOverlap(unitText, candidate));
      }, 0)
    }))
    .sort((left, right) => right.score - left.score)[0];
  if (scoredIndex && scoredIndex.score >= 0.72) return scoredIndex.index;

  const sequentialShot = shots[fallbackIndex];
  if (sequentialShot) {
    const sequentialScore = getShotUnitMatchTexts(sequentialShot).reduce((best, candidate) => {
      return Math.max(best, scoreNormalizedTextOverlap(unitText, candidate));
    }, 0);
    if (sequentialScore >= 0.55) return fallbackIndex;
  }

  return -1;
}

function getShotUnitMatchTexts(shot: RawStoryboardResult["shots"][number]): string[] {
  return [
    shot.sourceText,
    shot.anchorSentence,
    shot.narration,
    ...shot.dialogueLines.map((line) => line.text)
  ].filter(Boolean);
}

function scoreNormalizedTextOverlap(left: string, right: string): number {
  const leftTokens = tokenizeForShotMatching(left);
  const rightTokens = tokenizeForShotMatching(right);
  if (leftTokens.length === 0 || rightTokens.length === 0) return 0;
  const rightSet = new Set(rightTokens);
  const hitCount = new Set(leftTokens.filter((token) => rightSet.has(token))).size;
  const coverage = hitCount / Math.min(new Set(leftTokens).size, rightSet.size);
  const balance = hitCount / Math.max(new Set(leftTokens).size, rightSet.size);
  return coverage * 0.7 + balance * 0.3;
}

function tokenizeForShotMatching(value: string): string[] {
  const stopwords = new Set(["the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "at", "for", "with", "by", "from"]);
  return normalizeForCoverage(value)
    .match(/[a-z0-9]+|[\u4e00-\u9fa5]/gi)
    ?.map((token) => token.toLowerCase())
    .filter((token) => token.length > 1 && !stopwords.has(token)) ?? [];
}

function createFallbackShot(
  sourceText: string,
  context: {
    previousUnitText?: string;
    nextUnitText?: string;
    sceneAnchorText?: string;
    previousShot?: RawStoryboardResult["shots"][number];
    nextShot?: RawStoryboardResult["shots"][number];
    dialogueLines?: RawStoryboardResult["shots"][number]["dialogueLines"];
    directorNote?: string;
  } = {}
): RawStoryboardResult["shots"][number] {
  const fallbackContext = buildFallbackContext(sourceText, context);
  return {
    sourceText,
    anchorSentence: sourceText,
    narration: sourceText,
    dialogueLines: context.dialogueLines ?? [],
    imageDescription: fallbackContext.imageDescription,
    shotType: fallbackContext.shotType,
    characters: fallbackContext.characters,
    scene: fallbackContext.scene,
    emotion: "承接原文情绪",
    prompt: [
      "[00:00-00:04s]",
      `[镜头语法 / ${inferFallbackShotGrammar(sourceText, fallbackContext.shotType)}]`,
      `[画面细节] ${fallbackContext.imageDescription}`,
      `[摄影机补充状态] ${fallbackContext.cameraState}`,
      "[声音设计] 环境声低铺，跟随旁白节奏。",
      renderSpeechLine(sourceText, []),
      `[导演批注] ${context.directorNote || "保底修复镜头，用于补齐模型遗漏的原文分镜单元。"}`
    ].join("\n")
  };
}

function buildFallbackContext(
  sourceText: string,
  context: {
    previousUnitText?: string;
    nextUnitText?: string;
    sceneAnchorText?: string;
    previousShot?: RawStoryboardResult["shots"][number];
    nextShot?: RawStoryboardResult["shots"][number];
    dialogueLines?: RawStoryboardResult["shots"][number]["dialogueLines"];
  }
): {
  imageDescription: string;
  shotType: string;
  characters: string[];
  scene: string;
  focusSubject: string;
  cameraState: string;
} {
  const contextText = [context.previousUnitText, sourceText, context.nextUnitText].filter(Boolean).join(" ");
  const lightEvidenceText = sourceText;
  const sourceIsWorldbuilding = isWorldbuildingFragment(sourceText);
  const inheritedCharacters = [
    ...(context.previousShot?.characters ?? []),
    ...(context.nextShot?.characters ?? [])
  ];
  const dialogueCharacters = normalizeShotCharacters((context.dialogueLines ?? [])
    .map((line) => normalizeSpeakerName(line.speaker))
    .filter((speaker) => speaker !== "未指明说话者"));
  const sourceCharacters = normalizeShotCharacters([
    ...extractLikelyCharacterNames(sourceText, []),
    ...extractFirstPersonContextCharacters(sourceText)
  ]);
  const characters = sourceIsWorldbuilding
    ? []
    : normalizeShotCharacters([
      ...sourceCharacters,
      ...dialogueCharacters,
      ...(shouldInheritCharactersForUnit(sourceText) ? inheritedCharacters : [])
    ]);
  const nearbyAnchoredScene = shouldUseNearbySceneAnchorForFallback(sourceText)
    ? inferStrongExplicitSceneNameFromText(context.sceneAnchorText ?? "")
    : "";
  const inheritedScene = selectFallbackInheritedScene(context);
  const scene = inferExplicitSceneNameForFallbackSource(sourceText)
    || inheritedScene
    || nearbyAnchoredScene
    || inferFallbackScene(sourceText, inheritedScene);
  const focusSubject = inferFallbackFocusSubject(sourceText, characters);
  const actionPhrase = summarizeFallbackAction(sourceText, focusSubject, scene);
  const lightPhrase = inferFallbackLight(scene, lightEvidenceText);
  const cameraState = inferFallbackCameraState(sourceText, focusSubject, scene);
  const rawImageDescription = isWorldbuildingFragment(sourceText)
    ? buildWorldbuildingFallbackImageDescription(scene, lightPhrase)
    : isNonHumanFallbackSubject(focusSubject)
      ? `${scene}中，${actionPhrase}；${lightPhrase}；前景保留陈列台、地面纹路或空间边缘形成层次，中景锁定${focusSubject}的纹理、亮度变化和位置关系，背景藏品或墙面结构轻微虚化。`
      : `${scene}中，${actionPhrase}；${lightPhrase}；前景保留地面、桌沿或人群边缘形成空间层次，中景锁定${focusSubject}与主要反应，背景氛围保持轻微虚化并延续前后镜头。`;
  const imageDescription = appendFaceClarityInstruction(rawImageDescription, focusSubject, characters);

  return {
    imageDescription,
    shotType: /face|eyes|look|stare|whisper|低声|眼|脸|看/i.test(sourceText) ? "近景" : "中景",
    characters,
    scene,
    focusSubject,
    cameraState
  };
}

function shouldInheritCharactersForUnit(sourceText: string): boolean {
  return /^(?:he|his|him|she|her|they|them|their|it|its|i|my|me|we|our|us)\b|^(?:他|她|它|他们|她们|我|我们|我的)/i.test(sourceText.trim());
}

function inferExplicitSceneNameForFallbackSource(sourceText: string): string {
  const outsideQuotedSpeech = stripQuotedAndBracketedTextForCharacterInference(sourceText);
  const outsideScene = inferStrongExplicitSceneNameFromText(outsideQuotedSpeech);
  if (/医院急救室|hospital/i.test(outsideScene) && isNonSceneHospitalReference(outsideQuotedSpeech)) return "";
  if (outsideScene) return outsideScene;
  if (/(?:last life|previous life|back then|stood in line|critically ill|waited an entire night)/i.test(sourceText)) {
    const memoryScene = inferStrongExplicitSceneNameFromText(sourceText);
    return /医院急救室|hospital/i.test(memoryScene) ? "医院回忆画面" : memoryScene;
  }
  return "";
}

function isNonSceneHospitalReference(text: string): boolean {
  return /(?:maintains?|barrier|budget|budget cuts|noble council|removed|law|record|purpose|saved many lives|pay the price|hospitals?\?)/i.test(text);
}

function extractLikelyCharacterNames(text: string, inheritedCharacters: string[]): string[] {
  const inferenceText = stripQuotedAndBracketedTextForCharacterInference(text);
  const candidates = [
    ...inheritedCharacters,
    ...extractDialogueAttributionSpeakerNames(text),
    ...(inferenceText.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/g) ?? []),
    ...extractLikelyChineseCharacterNames(inferenceText)
  ].map(normalizeLikelyCharacterCandidate).filter(Boolean);
  const blocked = new Set([
    "the", "this", "that", "he", "she", "it", "they", "then", "back", "when", "where", "what", "why", "how", "i", "you", "and",
    "in", "from", "to", "of", "for", "at", "on", "by", "with", "without", "before", "after", "during", "under", "over",
    "world", "fate", "written", "bloodline", "bloodlines", "moment", "pact", "familiars", "chapter", "return", "rite", "hall", "academy",
    "one", "star", "reject", "star reject", "god", "devourer", "god devourer", "aether", "beast", "aether beast",
    "abandoned", "the abandoned", "egg", "hatchery", "basin", "hatchery basin", "there", "its", "even", "since", "defective",
    "radiant gryphon", "redtail lizard", "rank", "tier", "rank tier", "and",
    "royal", "vault", "royal vault", "empire", "augustine empire", "imperial capital", "capital",
    "take", "eat", "not", "inside", "space", "consumed", "passive", "rows", "seven", "half", "hour", "later",
    "beastmaster grand", "tournament", "holy see", "core crystal", "core crystals", "divine matter",
    "titan behemoth", "earth elemental", "thunder roc", "ruinous thunder", "armor", "lifebloom stag"
  ]);
  return normalizeShotCharacters(candidates)
    .filter((name) => !blocked.has(name.toLowerCase()))
    .filter((name) => !isLikelySceneOrTitleName(name))
    .filter((name) => !isLikelyFunctionWordOrTitleToken(name))
    .filter((name) => !isLikelyNonCharacterConceptName(name))
    .slice(0, 4);
}

function normalizeLikelyCharacterCandidate(candidate: string): string {
  let clean = candidate.replace(/[’]/g, "'").replace(/\s+/g, " ").trim();
  clean = clean.replace(/^(?:The|A|An|This|That|These|Those|Since|Even|There|Its|His|Her|Their|My|Our|Your|Before|After|Inside)\s+/i, "");
  clean = clean.replace(/\s+(?:Bloodline|Rank|Tier|Egg|Basin|Defective)$/i, "");
  return clean.trim();
}

function stripQuotedAndBracketedTextForCharacterInference(text: string): string {
  return text
    .replace(/“[^”]*”/g, " ")
    .replace(/‘[^’]*’/g, " ")
    .replace(/"[^"]*"/g, " ")
    .replace(/\[[^\]]*\]/g, " ");
}

function extractDialogueAttributionSpeakerNames(text: string): string[] {
  const names = new Set<string>();
  const patterns = [
    /[“"][^”"]+[”"]\s+([A-Z][A-Za-z0-9_-]*|I)\s+(?:said|asked|whispered|shouted|murmured|replied|cried|sobbed|snapped|answered|continued|added|barked|screamed|yelled|called|growled|hissed|demanded|ordered|muttered|gasped|pleaded|warned|insisted)\b/gi,
    /\b([A-Z][A-Za-z0-9_-]*|I)\s+(?:said|asked|whispered|shouted|murmured|replied|cried|sobbed|snapped|answered|continued|added|barked|screamed|yelled|called|growled|hissed|demanded|ordered|muttered|gasped|pleaded|warned|insisted)\s*[:：]\s*[“"]/gi
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const speaker = normalizeSpeakerName(match[1] ?? "");
      if (speaker && speaker !== "未指明说话者") names.add(speaker);
    }
  }
  return Array.from(names);
}

function extractFirstPersonContextCharacters(text: string): string[] {
  const inferenceText = stripQuotedAndBracketedTextForCharacterInference(text);
  return /\b(?:i|me|my|mine|we|us|our|ours)\b|我|我们|我的/i.test(inferenceText)
    ? ["第一人称主角"]
    : [];
}

function extractLikelyChineseCharacterNames(text: string): string[] {
  const candidates = new Set<string>();
  const patterns = [
    /(?<![\u4e00-\u9fa5])([\u4e00-\u9fa5]{2,4})(?=说|看|盯|望|站|坐|走|跑|哭|喊|叫|低声|沉默|后退|靠近|伸手|跪|躲|转身|推开|握住|拿起|放下)/g,
    /(?<![\u4e00-\u9fa5])([\u4e00-\u9fa5]{2,4})(?:站在|坐在|走到|看着|盯着|望着|靠近|后退|冷笑|沉默|低声|喊道|说道|哭着)/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const candidate = match[1]?.trim();
      if (!candidate || isLikelyChineseNonNameClaim(candidate)) continue;
      candidates.add(candidate);
    }
  }
  return Array.from(candidates);
}

function isLikelySceneOrTitleName(name: string): boolean {
  return /\b(?:academy|hall|rite|corridor|hallway|room|bedroom|apartment|basement|street|road|hospital|emergency|mansion|lake|cemetery|library|river|underworld|gate|chapter|world|fate|bloodline|bloodlines|hatchery|basin|altar|vault|treasury|empire|capital|tournament|holy see)\b/i.test(name);
}

function isLikelyFunctionWordOrTitleToken(name: string): boolean {
  return /^(?:in|from|to|of|for|at|on|by|with|without|before|after|during|under|over|inside|world|fate|written|bloodline|bloodlines|moment|since|even|there|its|one|star|reject|god|devourer|defective|and|take|eat|not|consumed|passive|rows|space|seven)$/i.test(name.trim());
}

function isLikelyNonCharacterConceptName(name: string): boolean {
  return /\b(?:beast|behemoth|stag|roc|elemental|egg|lizard|gryphon|dragon|bloodline|rank|tier|pact|basin|altar|reject|devourer|star|creature|defective|crystal|crystals|matter|relic|relics|armor|affinity|core)\b/i.test(name);
}

function selectFallbackInheritedScene(context: {
  previousUnitText?: string;
  nextUnitText?: string;
  previousShot?: RawStoryboardResult["shots"][number];
  nextShot?: RawStoryboardResult["shots"][number];
}): string | undefined {
  if (sceneCanBeInheritedFromAdjacent(context.previousShot?.scene, context.previousUnitText)) return context.previousShot?.scene;
  const nextExplicitScene = context.nextUnitText ? inferStrongExplicitSceneNameFromText(context.nextUnitText) : "";
  if (nextExplicitScene) return nextExplicitScene;
  if (sceneCanBeInheritedFromAdjacent(context.nextShot?.scene, context.nextUnitText)) return context.nextShot?.scene;
  return undefined;
}

function sceneCanBeInheritedFromAdjacent(scene: string | undefined, adjacentUnitText: string | undefined): boolean {
  if (!scene || /未(?:明确|指明)场景|当前连续场景/.test(scene) || isLikelyNonVisualSceneLabel(scene)) return false;
  if (/世界观建立画面|前世记忆画面/.test(scene)) return false;
  const adjacentSceneKey = adjacentUnitText ? inferExplicitSceneKeyFromText(adjacentUnitText) : "";
  const sceneKey = getSceneKey(scene);
  if (sceneKey === "worldbuilding" && !isWorldbuildingFragment(adjacentUnitText ?? "")) return false;
  return !adjacentSceneKey || !sceneKey || areSceneKeysCompatible(adjacentSceneKey, sceneKey);
}

function inferFallbackScene(text: string, inheritedScene?: string): string {
  if (isNonSceneHospitalReference(text)) return inheritedScene || "当前连续场景";
  const sceneHints = [
    { pattern: /pact backlash|gryphon turned|契约反噬/i, scene: "契约反噬记忆画面" },
    { pattern: /previous life|last life|past life|前世/i, scene: "前世记忆画面" },
    { pattern: /penthouse apartment|顶层公寓/i, scene: "顶层公寓" },
    { pattern: /summoning hall|召唤大厅|aurelia academy|binding rite/i, scene: "Summoning Hall" },
    { pattern: /royal vault|vault|treasury|core crystals?|lifebloom stag(?:’s|'s)? core|divine matter|ancient remains|relics?|silver altar|barriers?|seven-star mages?|地下宝库|宝库/i, scene: "Royal Vault" },
    { pattern: /front hall/i, scene: "Royal Vault front hall" },
    { pattern: /corridor|hallway|走廊|楼道/i, scene: "走廊" },
    { pattern: /\b(?:doorway|door handle|locked door|at the door)\b|门口|门把手/i, scene: "门口" },
    { pattern: /room|bedroom|apartment|房间|卧室|公寓/i, scene: "室内房间" },
    { pattern: /basement|地下室/i, scene: "地下室" },
    { pattern: /street|road|outside|街|路边|室外/i, scene: "室外街道" },
    { pattern: /hospital|emergency|手术|医院|急救室/i, scene: "医院回忆画面" }
  ];
  const explicitScene = sceneHints.find((hint) => hint.pattern.test(text))?.scene;
  if (explicitScene) return explicitScene;
  if (inheritedScene && !/未(?:明确|指明)场景/.test(inheritedScene) && !isLikelyNonVisualSceneLabel(inheritedScene)) return inheritedScene;
  return isWorldbuildingFragment(text) ? "世界观建立画面" : "当前连续场景";
}

function inferExplicitSceneKeyFromText(text: string): string {
  const clean = text.toLowerCase();
  if (isNonSceneHospitalReference(text)) {
    const withoutHospitalReference = clean.replace(/hospitals?|hospital|emergency room|急救室|医院|手术/g, " ");
    if (!/hospital|emergency room|急救室|医院|手术/.test(withoutHospitalReference)) {
      if (/royal vault|vault|treasury|core crystals?|lifebloom stag(?:’s|'s)? core|divine matter|ancient remains|relics?|silver altar|barriers?|seven-star mages?|front hall|地下宝库|宝库/.test(withoutHospitalReference)) return "vault";
      return "";
    }
  }
  if (/penthouse apartment|顶层公寓/.test(clean)) return "penthouse";
  if (/summoning hall|召唤大厅|aurelia academy|binding rite/.test(clean)) return "summoning_hall";
  if (/royal vault|vault|treasury|core crystals?|lifebloom stag(?:’s|'s)? core|divine matter|ancient remains|relics?|silver altar|barriers?|seven-star mages?|front hall|地下宝库|宝库/.test(clean)) return "vault";
  if (/corridor|hallway|走廊|楼道/.test(clean)) return "hallway";
  if (/basement|地下室/.test(clean)) return "basement";
  if (/hospital|emergency room|急救室|医院|手术/.test(clean)) return "hospital";
  if (/street|road|outside|街|路边|室外/.test(clean)) return "outdoor";
  if (/bedroom|卧室/.test(clean)) return "bedroom";
  if (/\broom\b|apartment|房间|公寓/.test(clean)) return "room";
  if (/\b(?:doorway|door handle|locked door|at the door)\b|门口|门把手/.test(clean)) return "doorway";
  return "";
}

function inferStrongExplicitSceneNameFromText(text: string): string {
  const key = inferExplicitSceneKeyFromText(text);
  const names: Record<string, string> = {
    penthouse: "顶层公寓",
    summoning_hall: "Summoning Hall",
    vault: "Royal Vault",
    hallway: "走廊",
    basement: "地下室",
    hospital: "医院急救室",
    outdoor: "室外街道",
    bedroom: "卧室",
    room: "室内房间"
  };
  return key && key !== "doorway" ? names[key] ?? "" : "";
}

function getSceneKey(scene: string): string {
  const clean = scene.toLowerCase();
  if (/penthouse|顶层公寓/.test(clean)) return "penthouse";
  if (/summoning hall|召唤大厅|aurelia|binding rite/.test(clean)) return "summoning_hall";
  if (/royal vault|vault|treasury|宝库|front hall/.test(clean)) return "vault";
  if (/corridor|hallway|走廊|楼道/.test(clean)) return "hallway";
  if (/basement|地下室/.test(clean)) return "basement";
  if (/hospital|emergency|急救|医院|手术/.test(clean)) return "hospital";
  if (/street|road|outside|室外|街|路边/.test(clean)) return "outdoor";
  if (/bedroom|卧室/.test(clean)) return "bedroom";
  if (/\broom\b|apartment|房间|公寓|室内/.test(clean)) return "room";
  if (/\b(?:doorway|door handle|locked door|at the door)\b|门口|门把手/.test(clean)) return "doorway";
  if (/世界观|worldbuilding|in this world/.test(clean)) return "worldbuilding";
  return "";
}

function areSceneKeysCompatible(left: string, right: string): boolean {
  if (!left || !right) return true;
  if (left === right) return true;
  const compatiblePairs = new Set([
    "hallway:doorway",
    "doorway:hallway",
    "room:doorway",
    "doorway:room",
    "penthouse:room",
    "room:penthouse",
    "vault:doorway",
    "doorway:vault"
  ]);
  return compatiblePairs.has(`${left}:${right}`);
}

function isLikelyNonVisualSceneLabel(scene: string): boolean {
  const clean = scene.trim();
  if (!clean) return true;
  if (/未(?:明确|指明)场景/.test(clean)) return true;
  if (/^(?:Fate Written in Bloodline|Return to the Binding Rite)$/i.test(clean)) return true;
  const words = clean.match(/[A-Za-z]+/g) ?? [];
  return words.length >= 3 && words.every((word) => /^[A-Z]/.test(word));
}

function isWorldbuildingFragment(text: string): boolean {
  return /\b(?:in this world|bloodline|rank tier|aether beast|creature|evolution|forbidden path|fate|contract|inherited name)\b/i.test(text);
}

function shouldUseNearbySceneAnchorForFallback(text: string): boolean {
  if (inferStrongExplicitSceneNameFromText(text)) return false;
  if (/\b(?:previous life|past life|pact backlash|sold me out|turned on me|opened my eyes|back at the day|fianc|rival)\b/i.test(text)) return false;
  return /\b(?:in this world|bloodline|rank tier|aether beast|creature|evolution|forbidden path|fate|inherited name|one-star reject|god devourer|world-destroying black dragon)\b/i.test(text);
}

function inferFallbackFocusSubject(sourceText: string, characters: string[]): string {
  if (isWorldbuildingFragment(sourceText) && characters.length === 0) return "世界观信息";
  if (/(?:royal vault|augustine empire|imperial capital|地下宝库|宝库)/i.test(sourceText)) return "Royal Vault地下宝库空间";
  if (/^\s*\[[^\]]*(?:consumed|passive|affinity|defense increased|unlocked)/i.test(sourceText)) return "系统提示与能量变化";
  if (/(?:core crystals?|divine matter|ancient remains|relics?)/i.test(sourceText)) return "宝库藏品";
  if (/(?:seven-star lifebloom stag|lifebloom stag|soft green glow|seal)/i.test(sourceText)) return "七星Lifebloom Stag核心";
  if (/(?:massive doors opened|dense mana|heat of a furnace)/i.test(sourceText)) return "宝库巨门与魔力涌流";
  if (/(?:barriers?|seven-star mages?)/i.test(sourceText)) return "宝库屏障与守卫法师";
  if (/^(?:i|my)\b|my previous life|my name was|i came from|i formed|opened my eyes/i.test(sourceText.trim())) return characters[0] ?? "第一人称主角";
  if (/(?:dull gray egg|redtail lizard|plaque read|life force|灰色蛋|铭牌|红尾蜥蜴)/i.test(sourceText)) return "灰色兽卵和铭牌";
  if (/(?:gryphon turned|pact backlash|契约反噬)/i.test(sourceText)) return "辉光狮鹫与契约反噬";
  if (/(?:radiant gryphon|five-star.*egg|center altar|中央祭坛|五星.*蛋)/i.test(sourceText)) return "五星辉光狮鹫兽卵";
  const explicitName = characters.find((name) => new RegExp(`\\b${escapeRegExp(name)}\\b`, "i").test(sourceText));
  if (explicitName) return explicitName;
  if (/^it\b|^its\b/i.test(sourceText.trim())) return characters[0] ?? inferEnvironmentalFocusSubject(sourceText);
  if (/^he\b|^his\b|他/.test(sourceText.trim())) return characters[0] ?? "上一镜头延续人物";
  if (/^she\b|^her\b|她/.test(sourceText.trim())) return characters[0] ?? "上一镜头延续人物";
  return characters[0] ?? inferEnvironmentalFocusSubject(sourceText);
}

function inferEnvironmentalFocusSubject(sourceText: string): string {
  if (/(?:tone|mockery|deal|silence|air|atmosphere|moment)/i.test(sourceText)) return "环境气氛与人物关系变化";
  if (/(?:law|budget|council|record|scribe|purpose)/i.test(sourceText)) return "记录员、法令卷轴与祭坛标记";
  if (/(?:mist|mana|patterns|scales|corner|vault)/i.test(sourceText)) return "魔力雾气、鳞片纹路与宝库角落";
  return "环境变化与空间秩序";
}

function summarizeFallbackAction(sourceText: string, focusSubject: string, scene: string): string {
  const clean = sourceText.replace(/\s+/g, " ").trim();
  const sceneTarget = inferSceneInteractionTarget(scene, sourceText);
  if (hasDirectSpeech(clean) && !isNonHumanFallbackSubject(focusSubject) && !isFallbackPlaceholderSubject(focusSubject)) {
    const reactionPhrase = /noble students.*snicker|students.*snicker|贵族学生.*(?:窃笑|嘲笑|嗤笑)/i.test(clean)
      ? "背景里的贵族学生互相侧身窃笑，有人压低下巴看向说话者，肩线轻微抖动形成嘲讽氛围"
      : "背景人物保持短暂停顿或低声反应，环境压力通过视线方向和站位距离呈现";
    return `${focusSubject}说出对白时站在画面中景，肩颈保持克制，嘴角压低，眼部平稳盯向对方，面部微表情带着冷淡判断；${reactionPhrase}`;
  }
  if (isNonHumanFallbackSubject(focusSubject)) {
    if (/Royal Vault地下宝库空间/i.test(focusSubject)) {
      return `${focusSubject}以建立镜头呈现，厚重穹顶、封印墙面和通向地下的宝库结构清楚可见，空间尺度压出帝国禁地的庄严感`;
    }
    if (/pact backlash|契约反噬|gryphon turned/i.test(clean)) {
      return `${focusSubject}以符文逆流和光晕失控呈现，狮鹫轮廓被强光压成剪影，空间秩序出现裂痕，不展示人物化动作`;
    }
    if (/plaque read|redtail lizard|defective|铭牌|红尾蜥蜴|残次/i.test(clean)) {
      return `${focusSubject}静置在孵化池边缘，镜头压到铭牌文字和蛋壳黯淡纹理，周围更明亮的兽卵形成对比`;
    }
    return `${focusSubject}以静态视觉元素呈现，表面纹理、光晕强弱和空间距离关系清楚，不安排人物化动作`;
  }
  if (/(?:open(?:ed)? my eyes|睁开眼|睁眼|醒来|苏醒)/i.test(clean)) {
    return `${focusSubject}缓慢睁开眼，视线从近处虚焦过渡到${scene}的空间轮廓，身体停在刚苏醒的姿态`;
  }
  if (isWorldbuildingFragment(clean)) {
    return `${focusSubject}以建立镜头呈现，画面落在环境秩序、阶层象征或关键纹章上，人物不强行出镜`;
  }
  if (/(?:found myself|发现自己|回过神)/i.test(clean)) {
    return `${focusSubject}回过神后确认自己所在的位置，视线沿${scene}的地面纹理、墙面标识或通道轮廓移动，姿态带着短暂迟疑`;
  }
  if (/(?:reach(?:ed|ing)?|伸手|探手|够向|handle|door|门把手|门)/i.test(clean)) {
    return `${focusSubject}靠近${sceneTarget}，手伸向动作方向前短暂停住，身体朝动作方向微微前倾`;
  }
  if (/(?:look(?:ed|ing)?|glance(?:d)?|stare(?:d)?|watch(?:ed)?|看|望|盯|凝视)/i.test(clean)) {
    return `${focusSubject}抬起视线看向对方或${sceneTarget}，眼部状态和面部紧绷感清楚可见，身体保持原位`;
  }
  if (/(?:stand(?:ing|s|ood)?|stood|站|立)/i.test(clean)) {
    return `${focusSubject}停在${scene}的主要动线上，身体朝向对方或${sceneTarget}，站位与上一镜头保持连续`;
  }
  if (/(?:walk(?:ed|ing)?|run(?:ning)?|ran|stagger(?:ed|ing)?|storm(?:ed)?|走|跑|冲|踉跄)/i.test(clean)) {
    return `${focusSubject}沿${scene}的空间动线移动，脚步方向、身体重心和前后景距离关系清楚`;
  }
  if (/(?:grab(?:bed|bing)?|hold(?:ing)?|clench(?:ed)?|grip(?:ped)?|抓|握|攥|拿)/i.test(clean) || /\bheld\b(?!\s+the\s+key\b)/i.test(clean)) {
    return `${focusSubject}把手部动作落在${sceneTarget}或衣物边缘，手指用力状态和身体朝向形成清楚动作线`;
  }
  if (/(?:sit(?:ting)?|sat|kneel(?:ed|ing)?|坐|跪)/i.test(clean)) {
    return `${focusSubject}处在低位姿态，身体重心贴近地面或座位，周围空间压迫感与视线方向保持清楚`;
  }
  if (/(?:cry(?:ing|ied)?|sob(?:bing|bed)?|tear(?:s)?|scream(?:ed|ing)?|喊|哭|泪|尖叫)/i.test(clean)) {
    return `${focusSubject}情绪外露，肩颈和面部状态收紧，视线落向当前冲突来源或空处`;
  }
  if (/\b(?:phone|call|ring(?:ing)?|answer(?:ed)?)\b|手机|电话|来电/i.test(clean)) {
    return `${focusSubject}把注意力转向响起的通讯设备，手部靠近手机，画面焦点从人物转向道具`;
  }
  if (isFallbackPlaceholderSubject(focusSubject)) {
    return `环境变化与空间秩序通过地面痕迹、光线变化和前后景距离承接这一句，前后景关系保持清楚`;
  }
  return `${focusSubject}承接上一镜头的动作和情绪，身体朝向对方或${sceneTarget}，手部、视线与邻近空间锚点的关系保持清楚`;
}

function inferSceneInteractionTarget(scene: string, sourceText: string): string {
  if (/altar|inscription|core|crystal|relic|vault|treasury|宝库/i.test(`${scene} ${sourceText}`)) return "祭坛、铭文或宝库藏品";
  if (/summoning|rite|academy|hall|召唤|仪式/i.test(`${scene} ${sourceText}`)) return "祭坛符文或兽卵陈列";
  if (/hospital|emergency|医院|急救/i.test(`${scene} ${sourceText}`)) return "病床边缘、候诊队列或医疗灯下的空间";
  if (/door|corridor|hallway|走廊|门口/i.test(`${scene} ${sourceText}`)) return "门框、走廊尽头或墙面边缘";
  return "地面纹理、桌沿或墙面标识";
}

function hasDirectSpeech(text: string): boolean {
  return /["“”]/.test(text) ||
    /‘[^’]+’/.test(text) ||
    /(^|[\s([{])'[^']+'(?=$|[\s,.;:!?)}\]])/.test(text);
}

function appendFaceClarityInstruction(
  imageDescription: string,
  focusSubject: string,
  characters: string[]
): string {
  if (characters.length === 0 || isNonHumanFallbackSubject(focusSubject) || isFallbackPlaceholderSubject(focusSubject)) {
    return imageDescription;
  }
  const clean = stripTrailingPunctuation(imageDescription);
  if (/保持人物面部清晰，自然柔和瞳孔聚焦/.test(clean)) return `${clean}。`;
  return `${clean}；保持人物面部清晰，自然柔和瞳孔聚焦。`;
}

function isFallbackPlaceholderSubject(subject: string): boolean {
  return /^(?:画面主体|镜头视觉中心|当前叙事重点|关键道具|当前连续场景|画面叙事焦点|目标物|周围道具|主体|人物|空间结构|空间延续环境)$/i.test(subject.trim());
}

function buildWorldbuildingFallbackImageDescription(scene: string, lightPhrase: string): string {
  if (getSceneKey(scene) === "summoning_hall") {
    return `Aurelia Academy的Summoning Hall中，前景保留石质地面上的仪式符文，中景落在中央祭坛与分层陈列的兽卵，背景墙面刻着血脉等级纹章和学院大厅纵深；${lightPhrase}；画面用祭坛、兽卵亮度差和墙面纹章承接世界规则旁白，不安排人物开口或无证据动作。`;
  }
  return `${scene}中以前中后景清楚的环境建立镜头承接旁白，前景保留可读的空间边缘，中景落在墙面纹章或规则符号，背景保持纵深和轻微虚化；${lightPhrase}；画面用于承接世界规则信息，不强行安排人物开口或无证据动作。`;
}

function inferFallbackLight(scene: string, text: string): string {
  if (/召唤|仪式|Summoning Hall|Binding Rite|Aurelia/i.test(`${scene} ${text}`)) return "大厅高窗与仪式符文形成侧上方柔光，石质地面留下浅淡阴影，人物轮廓被冷金色边光勾出";
  if (/vault|treasury|宝库|core crystals?|divine matter|silver altar|relics?/i.test(`${scene} ${text}`)) return "宝库上方的封印纹路和水晶辉光交织成冷金色主光，陈列台边缘留下清晰阴影，藏品轮廓被微弱边光勾出";
  if (/世界观|in this world|bloodline|rank tier|aether beast|fate|contract|inherited name/i.test(`${scene} ${text}`)) return "侧上方柔和主光掠过空间入口和墙面标识，背景阴影保留层次，环境符号边缘带出清晰轮廓";
  if (/走廊|门口|corridor|hallway|door/i.test(`${scene} ${text}`)) return "走廊顶灯从上方投下冷白光，门缝处形成窄条阴影";
  if (/地下室|basement/i.test(`${scene} ${text}`)) return "单盏吊灯从上方形成硬光，背景边缘落入暗影";
  if (/医院|急救|hospital|emergency/i.test(`${scene} ${text}`)) return "冷色医疗灯从顶部均匀压下，金属和白墙反射出偏蓝高光";
  if (/室外|街|street|outside/i.test(`${scene} ${text}`)) return "街边环境光从侧后方斜射，地面反射出低亮度轮廓";
  return "侧上方柔和主光落在人物脸侧与肩线边缘上，背景阴影保持层次，人物轮廓清楚";
}

function inferFallbackCameraState(sourceText: string, focusSubject: string, scene: string): string {
  if (isWorldbuildingFragment(sourceText)) {
    return `稳定建立镜头，24mm 深景深缓慢扫过${scene}中的环境符号和空间层次，前景入口、中景符号和背景通道都保持可读。`;
  }
  if (isNonHumanFallbackSubject(focusSubject)) {
    return `稳定机位，70mm 浅景深锁定${focusSubject}的纹理和铭牌信息，背景兽卵与空间边缘轻微虚化，焦点不发生人物化移动。`;
  }
  if (/(?:open(?:ed)? my eyes|睁开眼|睁眼|醒来|苏醒)/i.test(sourceText)) {
    return `稳定近景，70mm 浅景深，焦点从${focusSubject}眼前的轻微虚焦过渡到${scene}的空间轮廓，保持苏醒瞬间的连续感。`;
  }
  if (/(?:reach(?:ed|ing)?|伸手|探手|够向|handle|door|门把手|门)/i.test(sourceText)) {
    return `稳定机位，50mm 浅景深顺着${focusSubject}的手部动作轻微推进，焦点从手部移到场景锚点，背景边缘轻微虚化。`;
  }
  if (/(?:walk(?:ed|ing)?|run(?:ning)?|ran|stagger(?:ed|ing)?|storm(?:ed)?|走|跑|冲|踉跄)/i.test(sourceText)) {
    return `稳定跟拍，35mm 到 50mm 轻微压缩空间，跟焦${focusSubject}的移动方向，背景保持运动中的浅层虚化。`;
  }
  return `稳定机位，50mm 中等景深沿着${focusSubject}的动作方向轻微推进，焦点锁定${focusSubject}的动作和面部反应，背景轻微虚化以保持空间连续。`;
}

function isNonHumanFallbackSubject(subject: string): boolean {
  return /世界观信息|系统提示|能量变化|Royal Vault地下宝库空间|宝库藏品|核心|魔力涌流|屏障|守卫法师|兽卵|铭牌|蛋|纹章|道具|环境符号|狮鹫|契约反噬/i.test(subject);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function translateToChinese(text: string): Promise<string> {
  const chunks = buildTranslationChunks(text);
  const translatedChunks = await mapWithConcurrency(chunks, getParallelLimit(), (chunk, index) =>
    withChunkContext(
      "翻译",
      index,
      chunks.length,
      translateMachineChunk(chunk)
    )
  );

  return joinTranslatedChunks(chunks, translatedChunks);
}

function joinTranslatedChunks(sourceChunks: string[], translatedChunks: string[]): string {
  return translatedChunks.reduce((result, translatedChunk, index) => {
    if (index === 0) return translatedChunk;
    const previousSource = sourceChunks[index - 1] ?? "";
    const currentSource = sourceChunks[index] ?? "";
    const separator = previousSource.match(/\s+$/)?.[0] ?? currentSource.match(/^\s+/)?.[0] ?? "";
    return `${result}${separator}${translatedChunk}`;
  }, "");
}

function buildMachineTranslationUrl(text: string): string {
  const url = new URL(TRANSLATION_BASE_URL);
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", "auto");
  url.searchParams.set("tl", "zh-CN");
  url.searchParams.set("dt", "t");
  url.searchParams.set("q", text);
  return url.toString();
}

function buildFallbackMachineTranslationUrl(text: string): string {
  const url = new URL(TRANSLATION_FALLBACK_URL);
  url.searchParams.set("q", text);
  url.searchParams.set("langpair", "en|zh-CN");
  return url.toString();
}

function parseMachineTranslationResponse(payload: unknown): string {
  if (!Array.isArray(payload) || !Array.isArray(payload[0])) {
    throw new Error("机器翻译服务返回了无法识别的结果。");
  }
  const translatedText = payload[0]
    .filter((segment): segment is unknown[] => Array.isArray(segment))
    .map((segment) => typeof segment[0] === "string" ? segment[0] : "")
    .join("")
    .trim();
  if (!translatedText) throw new Error("机器翻译服务没有返回译文。");
  return translatedText;
}

function parseFallbackMachineTranslationResponse(payload: unknown): string {
  if (!payload || typeof payload !== "object") throw new Error("备用机器翻译服务返回了无法识别的结果。");
  const result = payload as { responseData?: { translatedText?: unknown }; responseStatus?: unknown; responseDetails?: unknown };
  if (typeof result.responseData?.translatedText === "string" && result.responseData.translatedText.trim()) {
    return result.responseData.translatedText.trim();
  }
  const details = typeof result.responseDetails === "string" ? result.responseDetails : "没有返回译文";
  throw new Error(`备用机器翻译服务失败：${details}（状态 ${String(result.responseStatus ?? "未知")}）。`);
}

function describeMachineTranslationFailure(providerUrl: string, error: unknown): string {
  const host = new URL(providerUrl).host;
  const message = error instanceof Error ? error.message : String(error);
  let cause: unknown = error instanceof Error ? error.cause : undefined;
  const details = [message];
  while (cause && cause !== error) {
    const item = cause instanceof Error ? cause : new Error(String(cause));
    details.push(item.message);
    cause = item.cause;
  }
  const combined = details.join(" ");
  const codeMatch = combined.match(/\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|CERT_[A-Z_]+)\b/i);
  const code = codeMatch?.[1]?.toUpperCase();
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `${host} DNS 解析失败`;
  if (code === "ECONNREFUSED") return `${host} 拒绝连接`;
  if (code === "ECONNRESET") return `${host} 连接被重置`;
  if (code === "ETIMEDOUT") return `${host} 连接超时`;
  if (code?.startsWith("CERT_")) return `${host} TLS 证书校验失败`;
  if (/fetch failed|network error|failed to fetch/i.test(message)) return `${host} 网络连接失败`;
  return `${host}：${message}`;
}

async function translateMachineChunk(text: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const timeoutMs = getTranslationRequestTimeoutMs();
  const providers = [
    { url: buildMachineTranslationUrl(text), parse: parseMachineTranslationResponse },
    { url: buildFallbackMachineTranslationUrl(text), parse: parseFallbackMachineTranslationResponse }
  ];
  const failures: string[] = [];

  for (const provider of providers) {
    const requestSignal = createRequestSignal(undefined, timeoutMs);
    try {
      const response = await fetchImpl(provider.url, {
        headers: { Accept: "application/json" },
        signal: requestSignal.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return provider.parse(await response.json());
    } catch (error) {
      failures.push(requestSignal.didTimeout()
        ? `${new URL(provider.url).host} 请求超时（${timeoutMs}ms）`
        : describeMachineTranslationFailure(provider.url, error));
    } finally {
      requestSignal.dispose();
    }
  }

  throw new Error(`机器翻译服务均不可用：${failures.join("；")}。请检查本机网络、DNS 或代理设置；也可配置 TRANSLATION_BASE_URL 更换主服务。`);
}

function getTranslationRequestTimeoutMs(): number {
  return normalizeTimeoutMs(TRANSLATION_REQUEST_TIMEOUT_MS, 30000);
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
      if (requestSignal.didTimeout()) throw createModelTimeoutError(requestKind, input.length);
      throwIfAborted(signal);
      if (!shouldFallbackToChat(error)) throw normalizeOpenAIError(error);
      return createStructuredChatResponse(openai, schema, name, input, error, signal, requestKind);
    } finally {
      requestSignal.dispose();
    }
  }, getTransientRetryCount(), signal, requestKind);
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
    if (requestSignal.didTimeout()) throw createModelTimeoutError(requestKind, input.length);
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
    if (requestSignal.didTimeout()) throw createModelTimeoutError(requestKind, input.length);
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
        {
          name: "模拟角色",
          role: "主角",
          appearance: "轮廓清晰",
          costume: "深色外套",
          continuityNote: "保持同一服装和警觉状态",
          evidence: null,
          verificationStatus: null
        }
      ],
      scenes: [
        {
          name: "模拟场景",
          location: "室内与走廊",
          mood: "紧张",
          visualAnchor: "昏黄灯光",
          evidence: null,
          verificationStatus: null
        }
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

async function listAvailableModels(): Promise<string[]> {
  const openai = createOpenAIClient();

  try {
    const page = await openai.models.list();
    return page.data.map((model) => model.id).sort((a, b) => a.localeCompare(b));
  } catch (error) {
    throw normalizeOpenAIError(error);
  }
}

async function probeModelConnection(model: string): Promise<ModelConnectionProbe> {
  return probeModelConnectionWithClient(createOpenAIClient(), model, getModelProbeTimeoutMs());
}

interface ModelConnectionProbe {
  model: string;
  api: "responses" | "chat_completions";
  elapsedMs: number;
}

async function probeModelConnectionWithClient(
  openai: OpenAI,
  model: string,
  timeoutMs: number
): Promise<ModelConnectionProbe> {
  const startedAt = Date.now();
  const requestSignal = createRequestSignal(undefined, timeoutMs);
  try {
    try {
      await openai.responses.create({
        model,
        instructions: "只回复 OK。",
        input: buildResponseInput("连通性测试。请只回复 OK，不要解释。")
      }, { signal: requestSignal.signal });
      return { model, api: "responses", elapsedMs: Date.now() - startedAt };
    } catch (responsesError) {
      if (requestSignal.didTimeout()) throw new Error(`模型连通测试超时（${timeoutMs}ms）。`);
      if (!shouldFallbackToChat(responsesError)) throw normalizeOpenAIError(responsesError);
      await openai.chat.completions.create({
        model,
        messages: buildChatMessages("连通性测试。请只回复 OK，不要解释。")
      }, { signal: requestSignal.signal });
      return { model, api: "chat_completions", elapsedMs: Date.now() - startedAt };
    }
  } catch (error) {
    if (requestSignal.didTimeout()) throw new Error(`模型连通测试超时（${timeoutMs}ms）。`);
    throw normalizeOpenAIError(error);
  } finally {
    requestSignal.dispose();
  }
}

function buildAnalysisPrompt(text: string, settings: StorySettings, chunkIndex: number, chunkTotal: number): string {
  return [
    "你是解说剧小说理解专家，专门为旁白通读小说的分镜生成做前置理解。",
    "请只返回符合 schema 的 JSON，不要输出解释。",
    renderPromptSkillSet("analysis", ANALYSIS_PROMPT_SKILLS),
    `语言：${settings.language === "zh" ? "中文" : "英文"}`,
    "理解档案字段输出使用中文；原文证据 quote 保留原文，人物名和专有名词可保留原文写法。",
    "输出语言：中文。logline、role、appearance、costume、continuityNote、location、mood、visualAnchor、keyEvents、emotionalRhythm、continuityNotes 都用中文。",
    `剧本风格：${settings.scriptStyle}`,
    `视觉风格：${renderVisualStyle(settings.visualStyle)}`,
    `目标分集数：${settings.episodeCount} 集。`,
    `这是第 ${chunkIndex}/${chunkTotal} 段。`,
    "目标：提取能支撑后续逐句画面化的角色、场景、关键事件、情绪节奏和连续性约束。",
    "注意：这是解说剧，不是对白剧；旁白每一句都需要画面承接。",
    "证据要求：人物、场景、关键事件和连续性提示都必须来自本段原文；能提供 evidence 时，quote 必须是原文中的短句或词组。没有原文证据的人物、场景、外貌、服装、道具或全局连续性不要输出。",
    "场景要求：visualAnchor 只能作为道具/氛围证据，不能单独证明地点；例如只出现项链，不能据此断定顶层公寓或医院。",
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
    renderPromptSkillSet("storyboard", STORYBOARD_PROMPT_SKILLS),
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
    "2. 输入已经预先拆成【分镜单元】。短句会在上下文连续、场景/动作/人物关系清楚时合并，每个分镜单元的旁白朗读估算不超过 12 秒；原则上一个分镜单元对应一个镜头。",
    "3. durationSeconds 表示镜头画面时长，不是旁白阅读时长。单个普通镜头建议 4-8 秒；同一场景内连续动作、情绪推进或环境描写可以到 8-12 秒；反应镜头 2-3 秒，场景空镜/建立镜头 2-4 秒。",
    "4. 单个镜头覆盖的 narration 朗读估算不能超过 12 秒；超过时必须按完整句或完整直接引语拆成多个镜头，不能把一句话切成不完整片段。",
    "5. 不要跨【分镜单元】合并 sourceText、anchorSentence、narration 或 dialogueLines；每个镜头只能覆盖一个分镜单元，除非该单元内部已经包含完整对白和归属语。",
    "6. 英文或中文直接引语是硬边界：以引号开头的句子必须优先独立成对白镜头，或只和同一句里的 said/asked 等归属语保持在同一镜头；不得和前一句叙述尾部拼接。",
    "7. 不要把已经合并好的短句再拆得过碎；除非人物、动作、视角、场景、时间或直接引语边界发生明显切换，否则保持一个分镜单元一个镜头。合并后的每个句子仍要在 narration、dialogueLines 和 [台词/旁白] 中完整保留，不能省略任何一句。",
    "8. 当人物、动作、视角或场景发生切换时，不要直接跨切换合并；需要用第三方反应镜头或场景空镜承接。",
    "9. 人物切换时，补一个反应镜头：让观察者、旁观者、对立角色或被影响者成为画面主体，shotType 写“反应镜头”或“第三方反应镜头”。",
    "10. 动作从发起进入结果/当事人反应/旁人确认时，拆成动作镜头和反应镜头，中间可加入短反应镜头承接因果。",
    "11. 场景、地点、时间或氛围切换时，插入场景空镜/建立镜头/转场镜头；characters 可以为空数组，prompt 的 [台词/旁白] 写无。",
    "12. 反应镜头或空镜不能续写未提供剧情，只能视觉化已有切换、情绪余波、环境压力或人物反应。",
    "13. 原文里凡是被中文引号 “”、‘’、书名式对话引号，或英文引号 \"\"、'' 包裹的直接发言，都必须识别为角色对话，不能写进 narration 当旁白。",
    "14. 一个完整引号对白如果因为长度被拆成多个分镜单元，每个拆分片段仍然是角色对白，必须进入 dialogueLines，不能写进 narration；speaker 需要继承同一段直接发言的说话人。",
    "15. 如果直接发言前后没有明确写说话人，必须根据上下文、相邻对白片段和理解档案推断 speaker；确实无法确定时 speaker 写“未指明说话者”，不要把这句话降级成旁白。",
    "16. dialogueLines 必须列出本镜头所有角色直接发言；speaker 写角色完整称谓，delivery 写“情绪+发声方式”，text 只写引号内原文内容且保持原文语言。如果这是被拆分的长对白片段，speaker 和 delivery 应延续同一段发言的语气。不能使用代称作为人物名或 speaker，例如他/她/它/he/she/it/they；确实无法确定时写“未指明说话者”。",
    "17. narration 只保留非直接发言的叙述文本；如果这一镜头只有角色对话没有旁白，narration 写无。",
    "18. 每个镜头的画面重点必须落在覆盖分镜单元的最后一句，即 anchorSentence。",
    "19. 反应镜头/空镜如果没有对应旁白和对白，narration 写无，dialogueLines 为空数组。",
    "20. prompt 必须使用下方“镜头提示词格式”，不是普通散文提示词，不要绑定具体平台参数；除 [台词/旁白] 的引用内容外，其余全部用中文。[台词/旁白] 的引用内容必须保持原文语言和原文表述，不做安全改写。",
    "21. 必须参考已验证理解档案，保持人物外貌、服装、场景和时间线一致；scene、characters、imageDescription 和 prompt 的视觉行只能结合当前分镜单元、相邻段锚点和本段相关已验证理解档案推断，不能把未验证内容当成画面事实。",
    "21a. 不要因为场景或人物没有在当前单句中重复出现就降级为空白表达；如果上下文连续且已验证理解档案或相邻镜头提供合理依据，可以沿用或推断场景、人物和道具，并让画面仍然具体可拍。",
    "21b. 每条 prompt 的画面细节必须包含明确主体、可拍摄动作或状态、情绪落点和镜头目的；即使信息较少，也要输出有质感、可执行的画面提示词，而不是泛泛写“未明确”。",
    "21c. 每条 prompt 的 [画面细节] 必须包含当前场景光源描述，至少写清主光源来源、光线方向、光线质感，例如走廊顶灯从上方打下冷白光、窗外夕阳从左侧斜射、手机屏幕光映在人物脸侧、地下室单盏吊灯形成硬阴影。",
    "22. 分集拆分由系统按镜头顺序写入 episodeNumber；你只需要在 notes 中提示适合断集的剧情节点。",
    "23. 任何涉及旁白或角色对话的镜头，都必须在 [台词/旁白] 行使用标准引用格式。",
    "24. 如果同一镜头的 [台词/旁白] 行同时包含角色对白和旁白，必须在两段阅读之间插入停顿标记；角色对白切到旁白时写【停顿0.4s，角色名静默无发声】，旁白切到角色对白时写【停顿0.4s】。停顿标记不能放进双引号内，不能改变引号内原文。画面上应在停顿处切到闭口反应、旁观者、手部动作或环境物件，避免角色说完对白后继续张嘴承接旁白造成穿帮。",
    `25. 本段最多生成 ${MAX_STORYBOARD_SHOTS_PER_CHUNK} 个镜头；如果分镜单元很多，优先保持系统提供的合并单元，不要为了增加镜头数量把上下文连续的短句拆碎。`,
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
  const verifiedAnalysis = validateAnalysisResultAgainstSource(analysis, chunkText, chunkIndex);
  const relevantCharacters = rankRelevantItems(
    verifiedAnalysis.characters,
    chunkText,
    (character) => [character.name, character.role, character.appearance, character.costume, character.continuityNote]
  ).slice(0, 8);
  const relevantScenes = rankRelevantItems(
    verifiedAnalysis.scenes,
    chunkText,
    (scene) => [scene.name, scene.location, scene.mood, scene.visualAnchor]
  ).slice(0, 8);
  const relevantEvents = rankRelevantStrings(verifiedAnalysis.keyEvents, chunkText).slice(0, 10);
  const relevantRhythm = rankRelevantStrings(verifiedAnalysis.emotionalRhythm, chunkText).slice(0, 8);
  const relevantContinuity = rankRelevantStrings(verifiedAnalysis.continuityNotes, chunkText).slice(0, 10);
  const adjacentAnchors = renderAdjacentChunkAnchors(allChunks, chunkIndex);

  return [
    `故事钩子（仅作主题，不作为画面事实）：${analysis.logline}`,
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
    "1. 画面、镜头、声音和导演批注采用克制、非具象、非操作性的表达；避免细节化呈现令人不适或可能引导模仿的内容。",
    "2. 遇到高风险情节，优先呈现结果、环境变化、道具状态、人物反应、遮挡、剪影、远景或转场空镜，不展开过程。",
    "3. 亲密、冲突或边界紧张的场面，聚焦人物站位、距离、视线、衣着和环境，不写身体细节。",
    "4. 不美化、鼓励或提供可执行的高风险行为信息；导演批注只描述剧情功能、情绪压力和剪辑处理。",
    "5. 安全画面化规则只约束视觉和声音表达；[台词/旁白] 行中的阅读内容必须保留原文，不得因安全规则改写。"
  ].join("\n");
}

function buildCinematicExpressionInstruction(): string {
  return [
    "镜头语言和人物表演润色规则：",
    "1. 默认保持单一景别、单一焦距和稳定焦点；不要为了显得丰富而频繁写“中景 -> 近景”。只有同一分镜单元内部确实存在情绪升级、动作结果、视线转移、信息揭示或叙事落点变化时，才使用景别切换。",
    "2. 使用景别切换时必须说明原因和节奏，例如“中景观察两人距离 -> 近景压到眼神，因为角色听见关键台词后情绪转折”；没有明确叙事原因时，只写一个最合适的景别。",
    "3. 焦距和焦点默认稳定；只有需要引导观众注意力时才描述变化逻辑，例如“35mm 中景跟随 -> 70mm 近景压缩空间，焦点从门口红色液体转到人物眼神”。",
    "4. 近景、特写、面部或细节镜头才重点强化人物表情细节，必须包含：嘴角状态、眼部状态、面部状态、视线方向；情绪要落到可见肌肉和眼神变化上。",
    "5. 中景、全景、远景、全身、半身或多人同框不要堆叠过细微表情；这类镜头优先写清楚动作路径、人物站位、距离关系、身体姿态/朝向、手部动作和视线关系，表情只保留能支撑剧情的关键情绪。",
    "6. 视觉质感采用高级动画感：不是越真实越好，而是把真实的空间、光影和材质，控制在一个更有审美的动画世界里；可以写克制的材质、轮廓光、空气透视、色彩层次和动画电影感表演。"
  ].join("\n");
}

function buildPromptFormatInstruction(): string {
  return [
    "镜头提示词格式：",
    "每个 prompt 必须严格使用 7 行结构，每一行都用方括号标签开头：",
    "[00:00-00:00s]",
    "[镜头语法 / 视角 / 景别 / 焦距 / 焦点变化 // 运动或强度] 默认只写一个最合适的景别、焦距和焦点；只有同一分镜单元确实需要情绪推进、动作结果、视线转移或信息揭示时，才写“中景 -> 近景”这类切换，并说明切换原因。",
    "[画面细节] 主体、动作、空间、构图、光线、色彩、关键道具、视觉风格；必须写当前场景光源，至少包含主光源来源、光线方向、光线质感；近景、特写、面部或细节镜头要补足嘴角状态、眼部状态、面部状态、视线方向；中景、全景、远景、全身、半身或多人同框要优先写清动作路径、人物站位、距离关系、身体姿态/朝向、手部动作和视线关系，避免堆叠过细微表情；如果是主观视角，要明确是谁的视角；视觉风格遵循高级动画感，不是越真实越好，而是把真实的空间、光影和材质，控制在一个更有审美的动画世界里。",
    "[摄影机补充状态] 机位高度、运动方式、稳定程度、推拉摇移、景深、畸变或遮挡；默认保持稳定，需要时才写清楚焦距变化、焦点转移和跟焦节奏。",
    "[声音设计] BGM、环境声、拟音、情绪推进、音量或节奏变化。",
    "[台词/旁白] 旁白必须写成：旁白：“对应内容”。角色对话必须写成：角色名（情绪+发声方式）：“对应内容”。所有原文引号内的直接发言都必须作为角色对话输出；没有说话人时写：未指明说话者（情绪+发声方式）：“对应内容”。双引号里的内容必须保持原文语言和原文表述，不要翻译、改写、删减或净化；英文原文保持英文，中文原文保持中文。如果同一镜头同时有旁白和对话，必须在两段阅读之间插入停顿标记；角色对白切到旁白时写：角色名（紧张+低声）：“原文对白”；【停顿0.4s，角色名静默无发声】；旁白：“原文旁白”。旁白切到角色对白时写：旁白：“原文旁白”；【停顿0.4s】；角色名（紧张+低声）：“原文对白”。没有旁白或对话时写：无。",
    "[导演批注] 说明这个镜头的戏剧目的、紧张感/悬念/爽感等观众感受，以及剪辑或同框重点，表达保持克制。",
    "时间段表示本镜头画面时长，不是旁白阅读时长；普通镜头通常 4-8 秒，同一场景内连续动作、情绪推进或环境描写可以到 8-12 秒；反应镜头 2-3 秒，场景空镜/建立镜头 2-4 秒。不要跨镜头累计到全片时间，只写本镜头内部时间范围。"
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
    baseURL: runtimeConfig.baseURL || undefined,
    // Retries are coordinated by withTransientRetry so content-policy failures
    // are never retried by the SDK behind the application's back.
    maxRetries: 0
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

function assignRuntimeFieldsForStoryboardChunk(
  shots: RawStoryboardResult["shots"],
  options: {
    existingShotCount: number;
    episodeCount: number;
    language: StorySettings["language"];
    generationChunkIndex?: number;
  }
): StoryboardShot[] {
  return shots.map((shot, offset) => {
    const index = options.existingShotCount + offset + 1;
    const cleanShot = normalizeShotTextFields(shot);
    return {
      ...cleanShot,
      id: `shot-${index}`,
      index,
      episodeNumber: calculateEpisodeNumber(index, options.episodeCount, Math.max(index, options.existingShotCount + shots.length)),
      durationSeconds: calculateShotDurationSeconds(cleanShot, options.language),
      generationStatus: "completed",
      generationChunkIndex: options.generationChunkIndex
    };
  });
}

function normalizeShotTextFields(
  shot: RawStoryboardResult["shots"][number],
  originalUnitText?: string,
  analysis?: AnalysisResult,
  previousSpokenSpeaker = ""
): RawStoryboardResult["shots"][number] {
  const cleanSourceText = originalUnitText ? stripStoryboardUnitLabels(originalUnitText) : stripStoryboardUnitLabels(shot.sourceText);
  const cleanAnchorSentence = originalUnitText ? cleanSourceText : stripStoryboardUnitLabels(shot.anchorSentence);
  const narratorSpeaker = inferNarratorSpeakerName(analysis);
  const originalSpeech = originalUnitText ? deriveSpeechPartsFromSource(cleanSourceText, shot.dialogueLines, previousSpokenSpeaker, narratorSpeaker) : undefined;
  const cleanNarration = originalSpeech ? originalSpeech.narration : stripStoryboardUnitLabels(shot.narration);
  const cleanDialogueLines = originalSpeech
    ? originalSpeech.dialogueLines
    : shot.dialogueLines.map((line) => ({
      ...line,
      speaker: normalizeSpeakerName(line.speaker, narratorSpeaker),
      text: stripStoryboardUnitLabels(line.text)
    }));
  const shouldRebuildSpeechLine = Boolean(originalSpeech) || shot.dialogueLines.some((line) =>
    normalizeSpeakerName(line.speaker, narratorSpeaker) !== stripStoryboardUnitLabels(line.speaker).trim()
  );
  const speechLine = originalSpeech?.orderedSpeechParts
    ? renderOrderedSpeechLine(originalSpeech.orderedSpeechParts)
    : renderSpeechLine(cleanNarration, cleanDialogueLines);
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
    prompt: shouldRebuildSpeechLine
      ? buildPromptWithSpeechLine(
        visualRepair.prompt,
        speechLine,
        cleanNarration,
        cleanDialogueLines
      )
      : ensureNarrationDialoguePause(
        visualRepair.prompt,
        cleanNarration,
        cleanDialogueLines
      ),
    characters: normalizeShotCharacters([
      ...shot.characters,
      ...cleanDialogueLines
        .map((line) => normalizeSpeakerName(line.speaker, narratorSpeaker))
        .filter((speaker) => speaker !== "未指明说话者")
    ]),
    scene: visualRepair.scene,
    dialogueLines: cleanDialogueLines
  };
}

function normalizeShotCharacters(characters: string[]): string[] {
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const character of characters) {
    const name = stripStoryboardUnitLabels(character).trim();
    if (!name || isPronounCharacterName(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(name);
  }
  return cleaned;
}

function normalizeSpeakerName(speaker: string, narratorSpeaker = ""): string {
  const cleanSpeaker = stripStoryboardUnitLabels(speaker).trim();
  if (isFirstPersonPronounName(cleanSpeaker)) return narratorSpeaker || "第一人称主角";
  if (!cleanSpeaker || isPronounCharacterName(cleanSpeaker)) return "未指明说话者";
  return cleanSpeaker;
}

function inferNarratorSpeakerName(analysis?: AnalysisResult): string {
  const characters = analysis?.characters ?? [];
  const evidenceMatched = characters.find((character) =>
    character.name?.trim()
    && character.name !== "未在原文证实"
    && [
      character.role,
      character.continuityNote,
      ...(character.evidence ?? []).map((evidence) => evidence.quote)
    ].some((value) => /第一人称|主角|my name was|my previous life|我(?:的名字|叫|名叫)/i.test(value ?? ""))
  );
  return evidenceMatched?.name.trim() || "";
}

function isFirstPersonPronounName(value: string): boolean {
  return /^(?:我|我们|咱们|俺|本人|i|me|my|mine|we|us|our|ours)$/i.test(value.trim());
}

function isPronounCharacterName(value: string): boolean {
  return /^(?:我|我们|咱们|俺|本人|他|她|它|ta|i|me|my|mine|we|us|our|ours|he|she|it|they|them|him|her|his|hers|their|theirs|对方|那个人|这个人)$/i.test(value.trim());
}

function getLastKnownDialogueSpeaker(shot: RawStoryboardResult["shots"][number]): string {
  for (let index = shot.dialogueLines.length - 1; index >= 0; index -= 1) {
    const speaker = normalizeSpeakerName(shot.dialogueLines[index].speaker);
    if (speaker && speaker !== "未指明说话者") return speaker;
  }
  return "";
}

function sanitizeVisualGenerationText(value: string): string {
  const safetyCleaned = VISUAL_SAFETY_REPLACEMENTS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
  return cleanVisualPlaceholderTerms(safetyCleaned);
}

function sanitizePromptVisualLines(value: string): string {
  return normalizePromptTagLines(value)
    .split("\n")
    .map((line) => line.trimStart().startsWith("[台词/旁白]") ? line : sanitizeVisualGenerationText(line))
    .join("\n");
}

function cleanFinalVisualPlaceholderTerms(shot: RawStoryboardResult["shots"][number]): RawStoryboardResult["shots"][number] {
  return {
    ...shot,
    scene: cleanVisualPlaceholderTerms(shot.scene),
    imageDescription: cleanVisualPlaceholderTerms(shot.imageDescription),
    shotType: cleanVisualPlaceholderTerms(shot.shotType),
    emotion: cleanVisualPlaceholderTerms(shot.emotion),
    prompt: sanitizePromptVisualLines(shot.prompt)
  };
}

function cleanVisualPlaceholderTerms(value: string): string {
  return value
    .replace(/画面主体/g, "主要人物或环境变化")
    .replace(/镜头视觉中心/g, "镜头焦点")
    .replace(/当前叙事重点/g, "当前动作结果")
    .replace(/关键道具/g, "原文证实道具")
    .replace(/当前连续场景/g, "前后镜头已证实场景")
    .replace(/画面叙事焦点/g, "镜头焦点")
    .replace(/目标物/g, "原文证实道具")
    .replace(/目标道具/g, "原文证实道具")
    .replace(/周围道具/g, "邻近陈设")
    .replace(/当前画面重点/g, "当前动作结果");
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
  modelDialogueLines: RawStoryboardResult["shots"][number]["dialogueLines"],
  previousSpokenSpeaker = "",
  narratorSpeaker = ""
): Pick<RawStoryboardResult["shots"][number], "narration" | "dialogueLines"> & {
  orderedSpeechParts: OrderedSpeechPart[];
} {
  const directSpeechParts = extractQuotedSpeechParts(sourceText);
  if (directSpeechParts.length === 0) {
    return {
      narration: sourceText,
      dialogueLines: [],
      orderedSpeechParts: hasReadableNarration(sourceText)
        ? [{ type: "narration", text: sourceText }]
        : []
    };
  }

  const validDialogueLines = directSpeechParts.map((part) => {
    const matchedLine = modelDialogueLines.find((line) => sameReadableText(line.text, part.text));
    const attributedSpeaker = inferEnglishAttributionSpeaker(sourceText, part.end);
    const speaker = resolveDialogueSpeaker(attributedSpeaker, matchedLine?.speaker, previousSpokenSpeaker, narratorSpeaker);
    return {
      speaker,
      delivery: matchedLine?.delivery?.trim() || "平静+清晰",
      text: part.text
    };
  });
  const orderedSpeechParts = buildOrderedSpeechPartsFromSource(sourceText, directSpeechParts, validDialogueLines);

  return {
    narration: removeQuotedRanges(sourceText, directSpeechParts).trim() || "无",
    dialogueLines: validDialogueLines,
    orderedSpeechParts
  };
}

type OrderedSpeechPart =
  | { type: "narration"; text: string }
  | { type: "dialogue"; line: RawStoryboardResult["shots"][number]["dialogueLines"][number] };

function buildOrderedSpeechPartsFromSource(
  sourceText: string,
  directSpeechParts: Array<{ text: string; start: number; end: number }>,
  dialogueLines: RawStoryboardResult["shots"][number]["dialogueLines"]
): OrderedSpeechPart[] {
  const parts: OrderedSpeechPart[] = [];
  let cursor = 0;

  directSpeechParts.forEach((part, index) => {
    const narrationBefore = normalizeAttributionNarration(sourceText.slice(cursor, part.start));
    if (hasReadableNarration(narrationBefore)) parts.push({ type: "narration", text: narrationBefore });
    parts.push({ type: "dialogue", line: dialogueLines[index] });
    cursor = part.end;
  });

  const narrationAfter = normalizeAttributionNarration(sourceText.slice(cursor));
  if (hasReadableNarration(narrationAfter)) parts.push({ type: "narration", text: narrationAfter });
  return parts;
}

function normalizeAttributionNarration(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim();
}

function inferEnglishAttributionSpeaker(sourceText: string, quoteEnd: number): string {
  const rest = sourceText.slice(quoteEnd);
  const match = rest.match(/^\s*([A-Z][A-Za-z0-9_-]*)\s+(?:said|asked|whispered|shouted|murmured|replied|cried|sobbed|snapped|answered|continued|added|barked|screamed|yelled|called|growled|hissed|demanded|ordered|muttered|gasped|pleaded|warned|insisted)\b/i);
  return match?.[1] ?? "";
}

function resolveDialogueSpeaker(
  attributedSpeaker: string | undefined,
  modelSpeaker: string | undefined,
  previousSpokenSpeaker: string,
  narratorSpeaker = ""
): string {
  const candidates = [attributedSpeaker, modelSpeaker, previousSpokenSpeaker];
  for (const candidate of candidates) {
    const speaker = normalizeSpeakerName(candidate ?? "", narratorSpeaker);
    if (speaker && speaker !== "未指明说话者") return speaker;
  }
  return "未指明说话者";
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

function renderOrderedSpeechLine(parts: OrderedSpeechPart[]): string {
  const renderedParts = parts.map((part) => {
    if (part.type === "narration") return `旁白：“${part.text}”`;
    const speaker = part.line.speaker.trim() || "未指明说话者";
    const delivery = part.line.delivery.trim() || "平静+清晰";
    return `${speaker}（${delivery}）：“${part.line.text}”`;
  });
  return `[台词/旁白] ${joinOrderedSpeechPartsWithPauses(renderedParts) || "无"}`;
}

function joinOrderedSpeechPartsWithPauses(parts: string[]): string {
  if (parts.length === 0) return "";
  const output: string[] = [parts[0]];
  for (let index = 1; index < parts.length; index += 1) {
    const previous = parts[index - 1];
    const current = parts[index];
    const isDialogueToNarration = !previous.startsWith("旁白：") && current.startsWith("旁白：");
    output.push(isDialogueToNarration ? "【停顿0.8s】" : "【停顿0.4s】", current);
  }
  return output.join("；");
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
  const status = getOpenAIErrorStatus(error, message);
  const details = getOpenAIErrorDetails(error, message);
  if (isContentFilterError(error)) {
    return new Error(
      `上游模型将本次请求标记为内容安全策略拦截，系统不会自动重试或拆分相同内容。若文本本身符合预期且属于误判，请向模型服务商排查 request id。错误详情：${details}`
    );
  }
  if (status === 429) {
    return new Error(
      `上游接口返回 429：请求频率过高、额度不足或供应商限制。系统会自动退避重试；持续失败时请把分段并发降到 1，检查模型网关额度/限流规则，或更换模型与 Base URL。错误详情：${details}`
    );
  }
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
  if (isContentFilterError(error)) return false;
  const message = error instanceof Error ? error.message : String(error);
  return /instructions are required|input must be a list|responses api|responses endpoint|response_format|text\.format|json_schema|invalid request/i.test(message) || isGatewayNonJsonError(message);
}

function shouldFallbackToManualJson(error: unknown): boolean {
  if (isContentFilterError(error)) return false;
  const message = error instanceof Error ? error.message : String(error);
  return /response_format|json_schema|schema|parse|unsupported|invalid request/i.test(message) || isGatewayNonJsonError(message);
}

function isGatewayNonJsonError(message: string): boolean {
  return /invalid character .+ looking for beginning of value|unexpected token .+ json|not valid json|json parse|failed to parse json/i.test(message);
}

function isTransientGatewayError(error: unknown): boolean {
  if (isContentFilterError(error)) return false;
  const message = error instanceof Error ? error.message : String(error);
  return isRateLimitError(error) || /500|502|503|504|bad gateway|upstream|overloaded|service unavailable|timeout|timed out|socket hang up|econnreset/i.test(message) || isConnectionErrorMessage(message) || isGatewayNonJsonError(message);
}

function isContentFilterError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const details = getOpenAIErrorDetails(error, message);
  return /sensitive[_ -]?words?[_ -]?detected|content[_ -]?filter|safety[_ -]?(?:policy|violation|filter)|policy[_ -]?violation/i.test(details);
}

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return getOpenAIErrorStatus(error, message) === 429 || /\b429\b|rate[_ -]?limit|too many requests/i.test(message);
}

function getOpenAIErrorStatus(error: unknown, message: string): number | undefined {
  if (error && typeof error === "object" && typeof (error as { status?: unknown }).status === "number") {
    return (error as { status: number }).status;
  }
  const statusMatch = message.match(/\b(\d{3})\b/);
  return statusMatch ? Number(statusMatch[1]) : undefined;
}

function getOpenAIErrorDetails(error: unknown, message: string): string {
  const details: string[] = [message];
  if (error && typeof error === "object") {
    const payload = error as { error?: unknown; code?: unknown; type?: unknown; param?: unknown; requestID?: unknown };
    const nested = payload.error;
    if (nested && typeof nested === "object") {
      const nestedPayload = nested as { message?: unknown; code?: unknown; type?: unknown };
      [nestedPayload.message, nestedPayload.type, nestedPayload.code]
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .forEach((value) => details.push(value));
    } else if (typeof nested === "string" && nested.trim()) {
      details.push(nested);
    }
    [payload.type, payload.code, payload.param, payload.requestID]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .forEach((value) => details.push(value));
  }
  return [...new Set(details)].join("；");
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
  signal?: AbortSignal,
  requestKind: ModelRequestKind = "default"
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      throwIfAborted(signal);
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !shouldRetryModelRequest(error, requestKind)) break;
      await delay(getTransientRetryDelayMs(attempt));
    }
  }
  throw lastError;
}

function shouldRetryModelRequest(error: unknown, requestKind: ModelRequestKind): boolean {
  if (isModelTimeoutError(error)) return requestKind !== "storyboard";
  if (!isTransientGatewayError(error)) return false;
  return true;
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

function getModelProbeTimeoutMs(): number {
  return normalizeTimeoutMs(MODEL_PROBE_TIMEOUT_MS, 15000);
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

function createModelTimeoutError(requestKind: ModelRequestKind, inputChars = 0): Error {
  const phase = renderRequestKindLabel(requestKind);
  const timeoutMs = getModelRequestTimeoutMs(requestKind);
  console.warn("[model-request-timeout]", {
    phase: requestKind,
    model: runtimeConfig.model,
    baseURL: getSafeBaseUrlForDiagnostics(),
    timeoutMs,
    inputChars
  });
  const reason = "超时前未收到模型响应，可能与上游排队/拥塞、网关阻塞、模型推理耗时或网络延迟有关";
  const recovery = requestKind === "storyboard"
    ? "分镜阶段将跳过重复的整段等待并尝试自动拆小段继续。"
    : "系统会按临时错误策略重试。";
  return new Error(`${phase}模型请求超时（${timeoutMs}ms，模型 ${runtimeConfig.model}，请求内容约 ${inputChars} 字符）。${reason}。${recovery}`);
}

function getSafeBaseUrlForDiagnostics(): string {
  if (!runtimeConfig.baseURL) return "default";
  try {
    const url = new URL(runtimeConfig.baseURL);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return "custom";
  }
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

function createAnalysisTextFormatForTest() {
  return zodTextFormat(modelAnalysisSchema, "novel_analysis");
}

export const __test__ = {
  runChunksIndependently,
  normalizeOpenAIError,
  isContentFilterError,
  shouldFallbackToChat,
  shouldSplitStoryboardChunk,
  shouldFallbackToManualJson,
  isGatewayNonJsonError,
  isTransientGatewayError,
  isRateLimitError,
  getParallelLimit,
  getTransientRetryCount,
  getTransientRetryBaseDelayMs,
  getTransientRetryDelayMs,
  getModelRequestTimeoutMs,
  getModelProbeTimeoutMs,
  getTranslationRequestTimeoutMs,
  buildMachineTranslationUrl,
  buildFallbackMachineTranslationUrl,
  buildTranslationChunks,
  joinTranslatedChunks,
  parseMachineTranslationResponse,
  parseFallbackMachineTranslationResponse,
  describeMachineTranslationFailure,
  translateMachineChunk,
  shouldRetryModelRequest,
  probeModelConnectionWithClient,
  createModelTimeoutError,
  getMaxStoryboardAdaptiveSplitDepth,
  mergeAnalysisPartialsLocally,
  splitStoryboardChunkForRetry,
  repairStoryboardChunkResult,
  assessShotReliability,
  qualityCheckStoryboardChunkResult,
  renderRelevantAnalysisContext,
  buildAnalysisPrompt,
  buildStoryboardPrompt,
  analyzeNovel,
  generateStoryboardStream,
  resumeStoryboardStream,
  regenerateStoryboardUnit,
  renderPromptSkillSet,
  normalizeShotTextFields,
  assignRuntimeFieldsForStoryboardChunk,
  createAnalysisTextFormatForTest
};

function mergeFallbackErrors(...errors: unknown[]): Error {
  const message = errors
    .map((error) => (error instanceof Error ? error.message : String(error)))
    .filter(Boolean)
    .join(" | ");
  return new Error(message);
}

function getParallelLimit(): number {
  if (!Number.isFinite(PARALLEL_CHUNK_LIMIT)) return 1;
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

type IndependentChunkOutcome<T> =
  | { status: "completed"; value: T }
  | { status: "failed"; error: string };

async function runChunksIndependently<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  onSettled: (outcome: IndependentChunkOutcome<R>, index: number) => void,
  signal?: AbortSignal
): Promise<IndependentChunkOutcome<R>[]> {
  const outcomes: IndependentChunkOutcome<R>[] = [];
  for (let index = 0; index < items.length; index += 1) {
    throwIfAborted(signal);
    let outcome: IndependentChunkOutcome<R>;
    try {
      const value = await worker(items[index], index);
      throwIfAborted(signal);
      outcome = { status: "completed", value };
    } catch (error) {
      throwIfAborted(signal);
      outcome = { status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
    outcomes.push(outcome);
    onSettled(outcome, index);
  }
  return outcomes;
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

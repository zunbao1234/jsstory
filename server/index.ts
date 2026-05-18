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
  ScriptStyle,
  StorySettings,
  StoryboardResult,
  StoryboardShot,
  VisualStyle
} from "../src/shared/types";
import { buildChunks, calculateDurationSeconds } from "../src/shared/text";

const PORT = Number(process.env.PORT ?? 8787);
const DEFAULT_MODEL = process.env.OPENAI_MODEL ?? "gpt-5.4";
const DEFAULT_BASE_URL = process.env.OPENAI_BASE_URL ?? "";
const PARALLEL_CHUNK_LIMIT = Number(process.env.PARALLEL_CHUNK_LIMIT ?? 2);
const ANALYSIS_MERGE_BATCH_SIZE = 4;
const TRANSIENT_REQUEST_RETRIES = 1;
const RESPONSE_INSTRUCTIONS = "You are a structured generation engine. Follow the user input exactly and return the requested content. For structured outputs, return only data that matches the provided schema.";
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
  imageDescription: z.string(),
  shotType: z.string(),
  characters: z.array(z.string()),
  scene: z.string(),
  emotion: z.string(),
  prompt: z.string()
});

const storyboardSchema = z.object({
  shots: z.array(shotSchema),
  notes: z.array(z.string()).max(12)
});
type RawStoryboardResult = z.infer<typeof storyboardSchema>;

const settingsSchema = z.object({
  visualStyle: z.enum(["2D", "3D", "photoreal"]),
  scriptStyle: z.enum(["爽文", "悬疑", "言情", "玄幻", "都市", "恐怖"]),
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
    const chunks = buildChunks(text);
    const shots = await generateStoryboard(chunks, settings, analysis);
    res.json(shots);
  } catch (error) {
    sendApiError(res, error);
  }
});

app.post("/api/generate/stream", async (req, res) => {
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
    const { text, settings } = analyzeRequestSchema.parse(req.body);
    const chunks = buildChunks(text);
    sendEvent({ type: "started", chunkTotal: chunks.length });
    sendEvent({ type: "analysis_started", chunkTotal: chunks.length });

    const analysis = await analyzeNovel(chunks, settings, {
      signal: abortController.signal,
      isClosed: () => closed,
      onChunk: (chunkIndex, chunkTotal, completedChunks) => {
        if (!closed) sendEvent({ type: "analysis_chunk", chunkIndex, chunkTotal, completedChunks });
      },
      onMerge: (completedBatches, totalBatches) => {
        if (!closed) sendEvent({ type: "analysis_merge", completedBatches, totalBatches });
      }
    });
    if (closed) return;

    sendEvent({ type: "analysis_completed", analysis });
    sendEvent({ type: "storyboard_started", chunkTotal: chunks.length });

    const storyboard = await generateStoryboardStream(chunks, settings, analysis, (event) => {
      if (!closed) sendEvent(event);
    }, abortController.signal, () => closed);
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
        hooks.signal
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
  let current = partials;

  while (current.length > 1) {
    const batches = chunkArray(current, ANALYSIS_MERGE_BATCH_SIZE);
    let completedBatches = 0;
    current = await mapWithConcurrency(batches, getParallelLimit(), (batch, index) =>
      withChunkContext("理解合并", index, batches.length, (async () => {
        throwIfAborted(hooks.signal, hooks.isClosed);
        const result = await createStructuredResponse(
          analysisSchema,
          "novel_analysis_merged",
          buildAnalysisMergePrompt(batch),
          hooks.signal
        );
        throwIfAborted(hooks.signal, hooks.isClosed);
        completedBatches += 1;
        hooks.onMerge?.(completedBatches, batches.length);
        return result;
      })())
    );
  }

  return current[0];
}

function buildAnalysisMergePrompt(partials: AnalysisResult[]): string {
  return [
    "请把以下分段理解结果合并为小说级别的解说剧理解档案。",
    "保留最重要的人物、场景、事件和连续性约束；去重同一人物、同一场景和重复事件。",
    "如果信息冲突，优先保留更具体、更能支撑后续分镜连续性的描述。",
    "请只返回符合 schema 的 JSON，不要输出解释。",
    `分段理解结果：\n${JSON.stringify(partials, null, 2)}`
  ].join("\n\n");
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
        buildStoryboardPrompt(chunk, settings, analysis, chunkIndex + 1, chunks.length)
      )
    )
  );

  const allShots: StoryboardShot[] = [];
  const notes: string[] = [];

  for (const result of results) {
    notes.push(...result.notes);
    result.shots.forEach((shot) => {
      const index = allShots.length + 1;
      allShots.push({
        ...shot,
        id: `shot-${index}`,
        index,
        episodeNumber: calculateEpisodeNumber(index, settings.episodeCount, allShots.length + result.shots.length),
        durationSeconds: calculateDurationSeconds(
          shot.narration || shot.sourceText,
          settings.language,
          settings.readingRate,
          settings.readingRateUnit
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
  onChunk: (event: Extract<GenerationStreamEvent, { type: "storyboard_chunk" }>) => void,
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
        return {
          ...shot,
          id: `shot-${index}`,
          index,
          episodeNumber: calculateEpisodeNumber(index, settings.episodeCount, index),
          durationSeconds: calculateDurationSeconds(
            shot.narration || shot.sourceText,
            settings.language,
            settings.readingRate,
            settings.readingRateUnit
          )
        };
      });
      allShots.push(...chunkShots);
      notes.push(...result.notes);
      onChunk({
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
    const result = await withChunkContext(
      "分镜",
      chunkIndex,
      chunks.length,
      createStructuredResponse(
        storyboardSchema,
        "storyboard_shots",
        buildStoryboardPrompt(chunk, settings, analysis, chunkIndex + 1, chunks.length),
        signal
      )
    );
    throwIfAborted(signal, isClosed);
    completedChunks += 1;
    results[chunkIndex] = result;
    flushReadyChunks();
    return result;
  });

  return { shots: assignEpisodeNumbers(allShots, settings.episodeCount), notes };
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
  signal?: AbortSignal
): Promise<z.infer<T>> {
  if (!runtimeConfig.apiKey) throw new Error("OPENAI_API_KEY is not configured.");
  const openai = createOpenAIClient();

  return withTransientRetry(async () => {
    throwIfAborted(signal);
    try {
      const response = await openai.responses.parse({
        model: runtimeConfig.model,
        instructions: RESPONSE_INSTRUCTIONS,
        input: buildResponseInput(input),
        text: {
          format: zodTextFormat(schema, name)
        }
      }, { signal });

      const parsed = response.output_parsed;
      if (!parsed) throw new Error("模型没有返回符合 JSON Schema 的结构化结果。");
      return parsed;
    } catch (error) {
      throwIfAborted(signal);
      if (!shouldFallbackToChat(error)) throw normalizeOpenAIError(error);
      return createStructuredChatResponse(openai, schema, name, input, error, signal);
    }
  }, TRANSIENT_REQUEST_RETRIES, signal);
}

async function createTextResponse(input: string, signal?: AbortSignal): Promise<string> {
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
  }, TRANSIENT_REQUEST_RETRIES, signal);
}

async function createStructuredChatResponse<T extends z.ZodTypeAny>(
  openai: OpenAI,
  schema: T,
  name: string,
  input: string,
  responseError: unknown,
  signal?: AbortSignal
): Promise<z.infer<T>> {
  try {
    throwIfAborted(signal);
    const completion = await openai.chat.completions.parse({
      model: runtimeConfig.model,
      messages: buildChatMessages(input),
      response_format: zodResponseFormat(schema, name)
    }, { signal });
    const parsed = completion.choices[0]?.message.parsed;
    if (!parsed) throw new Error("模型没有返回符合 JSON Schema 的结构化结果。");
    return parsed;
  } catch (chatSchemaError) {
    throwIfAborted(signal);
    if (!shouldFallbackToManualJson(chatSchemaError)) {
      throw normalizeOpenAIError(mergeFallbackErrors(responseError, chatSchemaError));
    }
    return createManualJsonChatResponse(openai, schema, input, responseError, chatSchemaError, signal);
  }
}

async function createManualJsonChatResponse<T extends z.ZodTypeAny>(
  openai: OpenAI,
  schema: T,
  input: string,
  responseError: unknown,
  chatSchemaError: unknown,
  signal?: AbortSignal
): Promise<z.infer<T>> {
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
    }, { signal });
    const content = readChatContent(completion.choices[0]?.message.content);
    const parsedJson = extractJsonObject(content);
    return schema.parse(parsedJson);
  } catch (manualJsonError) {
    throw normalizeOpenAIError(mergeFallbackErrors(responseError, chatSchemaError, manualJsonError));
  }
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
  chunkTotal: number
): string {
  return [
    "你是解说剧分镜导演和提示词工程师。",
    "请只返回符合 schema 的 JSON，不要输出解释。",
    `语言：${settings.language === "zh" ? "中文" : "英文"}`,
    `剧本风格：${settings.scriptStyle}`,
    `视觉风格：${renderVisualStyle(settings.visualStyle)}`,
    `目标分集数：${settings.episodeCount} 集。请让整体镜头可按剧情节奏拆成 ${settings.episodeCount} 集，每集尽量有明确的小悬念、反转或情绪落点。`,
    `这是第 ${chunkIndex}/${chunkTotal} 段。本段会与其他段并发生成，请只处理本段文本，不要续写未提供内容。`,
    "分镜规则：",
    "1. 先理解每一句旁白的画面功能。",
    "2. 连续句子如果属于同一画面、同一动作或同一情绪推进，可以归并为一个镜头。",
    "3. 每个镜头的画面重点必须落在归并句组的最后一句，即 anchorSentence。",
    "4. narration 应保留这个镜头覆盖的原文旁白，不要改写成剧本对白。",
    "5. prompt 必须使用下方“镜头提示词格式”，不是普通散文提示词，不要绑定具体平台参数。",
    "6. 必须参考理解档案，保持人物外貌、服装、场景和时间线一致。",
    "7. 分集拆分由系统按镜头顺序写入 episodeNumber；你只需要在 notes 中提示适合断集的剧情节点。",
    "8. 本段最多生成 12 个镜头；如果句子很多，必须合并同场景、同动作或同情绪的连续句子，避免输出过长。",
    "9. 任何涉及旁白或角色对话的镜头，都必须在 [台词/旁白] 行使用标准引用格式。",
    buildPromptFormatInstruction(),
    `理解档案：\n${JSON.stringify(analysis, null, 2)}`,
    `小说文本：\n${text}`
  ].join("\n\n");
}

function buildPromptFormatInstruction(): string {
  return [
    "镜头提示词格式：",
    "每个 prompt 必须严格使用 7 行结构，每一行都用方括号标签开头：",
    "[00:00-00:00s]",
    "[镜头语法 / 视角 / 景别 / 焦段或镜头特征 // 运动或强度]",
    "[画面细节] 主体、动作、空间、表情、构图、光线、色彩、关键道具、视觉风格；如果是主观视角，要明确是谁的视角。",
    "[摄影机补充状态] 机位高度、运动方式、稳定程度、推拉摇移、景深、畸变或遮挡。",
    "[声音设计] BGM、环境声、拟音、情绪推进、音量或节奏变化。",
    "[台词/旁白] 旁白必须写成：旁白：“对应内容”。角色对话必须写成：角色名（情绪+发声方式）：“对应内容”。如果同一镜头同时有旁白和对话，逐条列出。没有旁白或对话时写：无。",
    "[导演批注] 说明这个镜头的戏剧目的、压迫感/恐惧/爽感/悬念等观众感受，以及剪辑或同框重点。",
    "时间段根据 durationSeconds 估算即可；不要跨镜头累计到全片时间，只写本镜头内部时间范围。"
  ].join("\n");
}

function renderVisualStyle(style: VisualStyle): string {
  const names: Record<VisualStyle, string> = {
    "2D": "2D 动画/插画",
    "3D": "3D 动画/电影感渲染",
    photoreal: "仿真人/写实影视"
  };
  return names[style];
}

function ensureOpenAI(): void {
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
  return /500|502|503|504|bad gateway|upstream|timeout|socket hang up|econnreset/i.test(message) || isGatewayNonJsonError(message);
}

async function withTransientRetry<T>(
  operation: () => Promise<T>,
  retries = TRANSIENT_REQUEST_RETRIES,
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
      await delay(300 * (attempt + 1));
    }
  }
  throw lastError;
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
  getParallelLimit
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

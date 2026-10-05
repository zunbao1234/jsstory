import assert from "node:assert/strict";
import { numberStoryboardShots, sortStoryboardShots, storyboardToCsv, storyboardToExcel } from "../src/shared/export";
import { buildDownloadFilename, deriveProjectTitleFromFilename, sanitizeDownloadBaseName } from "../src/shared/files";
import { detectLanguageMode, shouldAutoTranslate } from "../src/shared/language";
import { clearGeneratingStoryboardShots, countCompletedStoryboardShots, createStoryboardPlaceholders, failStoryboardChunkShots, getGenerationPreparationStatus, getGenerationStartBlockReason, markStoryboardChunkGenerating, replaceStoryboardChunkShots, replaceStoryboardShotWithResults } from "../src/shared/generation";
import { DEFAULT_MODEL, selectPreferredModel } from "../src/shared/models";
import { buildStoryboardChunks, buildStoryboardPlan, buildTranslationChunks, calculateDurationSeconds, calculateShotDurationSeconds, splitSentences } from "../src/shared/text";
import type { AnalysisResult, StoryboardShot } from "../src/shared/types";

process.env.JSSTORY_SKIP_SERVER_LISTEN = "1";
process.env.PARALLEL_CHUNK_LIMIT = "invalid-for-default";
process.env.JSSTORY_MOCK_STORYBOARD_FAIL_UNIT_LIMIT = "1";

assert.equal(detectLanguageMode("The old station was silent. A train arrived after midnight."), "en");
assert.equal(detectLanguageMode("雨夜的地铁站空无一人，列车在午夜后驶入站台。"), "zh");
assert.equal(detectLanguageMode(""), null);
assert.equal(shouldAutoTranslate("The old station was silent, and a train arrived after midnight.", "en"), true);
assert.equal(shouldAutoTranslate("The old station was silent, and a train arrived after midnight.", "zh"), false);
assert.equal(getGenerationStartBlockReason({ textLength: 35, hasApiKey: true, connectionStatus: "checking" }), "正在检查模型连接，请稍候片刻再开始。");
assert.equal(getGenerationStartBlockReason({ textLength: 35, hasApiKey: true, connectionStatus: "connected" }), null);
assert.equal(getGenerationPreparationStatus("en", true), "正在准备中文译文...");
assert.deepEqual(
  selectPreferredModel(["gpt-5.6-sol", "gpt-6.1-sol", "gpt-6-sol"], "gpt-5.6-sol"),
  { model: "gpt-6.1-sol", useCustomModel: false }
);
assert.deepEqual(
  selectPreferredModel(["vendor/gpt-6.1-sol-preview", "gpt-6-sol"], "gpt-5.6-sol"),
  { model: "vendor/gpt-6.1-sol-preview", useCustomModel: false }
);
assert.deepEqual(
  selectPreferredModel(["gpt-5.6-sol", "gpt-6-sol"], "gpt-5.6-sol"),
  { model: "gpt-6-sol", useCustomModel: false }
);
assert.deepEqual(
  selectPreferredModel(["gpt-5.6-sol", "gpt-5.4"], "custom-6.1-sol"),
  { model: "custom-6.1-sol", useCustomModel: true }
);
assert.deepEqual(
  selectPreferredModel(["gpt-5.6-sol", "gpt-5.4"], "gpt-5.6-sol"),
  { model: "gpt-5.6-sol", useCustomModel: false }
);

const longTranslationText = "First sentence stays intact. Second sentence continues the scene. ".repeat(18);
const translationChunks = buildTranslationChunks(longTranslationText);
assert.ok(translationChunks.length > 1);
assert.ok(translationChunks.every((chunk) => chunk.length <= 450));
assert.equal(translationChunks.join(""), longTranslationText);
const longUnbrokenTranslationText = "x".repeat(1001);
assert.ok(buildTranslationChunks(longUnbrokenTranslationText).every((chunk) => chunk.length <= 450));
assert.equal(buildTranslationChunks(longUnbrokenTranslationText).join(""), longUnbrokenTranslationText);
const unicodeTranslationText = `${"😀测试 ".repeat(100)}\r\n结尾。`;
const unicodeTranslationChunks = buildTranslationChunks(unicodeTranslationText);
assert.ok(unicodeTranslationChunks.every((chunk) => Array.from(chunk).length <= 450));
assert.equal(unicodeTranslationChunks.join(""), unicodeTranslationText);

const progressiveStoryText = Array.from({ length: 18 }, (_, index) =>
  `第${index + 1}天，林舟在清晨走进安静的图书馆，沿着整齐的书架慢慢前行，窗边的阳光落在一本摊开的旧书上。`
).join("");
const progressiveStorySettings = {
  visualStyle: "2D",
  scriptStyle: "温暖治愈",
  language: "zh",
  readingRate: 0.95,
  readingRateUnit: "secondsPerChar",
  episodeCount: 1
} as const;
const progressivePlan = buildStoryboardPlan(progressiveStoryText, "zh", 0.95, "secondsPerChar");
assert.equal(progressivePlan.chunks.join("\n"), buildStoryboardChunks(progressiveStoryText, "zh", 0.95, "secondsPerChar").join("\n"));
assert.ok(progressivePlan.units.length >= 2);
assert.ok(progressivePlan.units.every((unit) => unit.chunkIndex >= 0 && unit.text.length > 0));
const progressivePlaceholders = createStoryboardPlaceholders(progressivePlan, progressiveStorySettings);
assert.equal(progressivePlaceholders.length, progressivePlan.units.length);
assert.equal(progressivePlaceholders[0].sourceText, progressivePlan.units[0].text);
assert.equal(progressivePlaceholders[0].generationStatus, "pending");
assert.equal(progressivePlaceholders[0].prompt, "");
const generatingFirstChunk = markStoryboardChunkGenerating(progressivePlaceholders, 0);
assert.ok(generatingFirstChunk.filter((shot) => shot.generationChunkIndex === 0).every((shot) => shot.generationStatus === "generating"));
assert.ok(clearGeneratingStoryboardShots(generatingFirstChunk).every((shot) => shot.generationStatus !== "generating"));
const completedFirstChunk = replaceStoryboardChunkShots(progressivePlaceholders, 0, progressivePlaceholders
  .filter((shot) => shot.generationChunkIndex === 0)
  .map((shot, index) => ({
    ...shot,
    id: `generated-first-${index}`,
    generationStatus: "completed" as const,
    prompt: "逐步生成的镜头提示词"
  })));
assert.ok(completedFirstChunk.filter((shot) => shot.generationChunkIndex === 0).every((shot) => shot.generationStatus === "completed"));
assert.equal(completedFirstChunk.filter((shot) => shot.generationStatus === "pending").length, progressivePlaceholders.length - progressivePlaceholders.filter((shot) => shot.generationChunkIndex === 0).length);
const failedSecondChunk = failStoryboardChunkShots(completedFirstChunk, 1, "上游暂时拒绝");
assert.ok(failedSecondChunk.filter((shot) => shot.generationChunkIndex === 1).every((shot) => shot.generationStatus === "failed"));
assert.ok(failedSecondChunk.filter((shot) => shot.generationChunkIndex === 1).every((shot) => shot.generationError === "上游暂时拒绝"));
assert.equal(countCompletedStoryboardShots(failedSecondChunk), completedFirstChunk.filter((shot) => shot.generationStatus === "completed").length);

const { __test__ } = await import("./index");

assert.equal(
  __test__.joinTranslatedChunks(["Hello ", "world."], ["你好", "世界。"]),
  "你好 世界。"
);
assert.equal(
  __test__.joinTranslatedChunks(["Hello. ", "World."], ["你好。", "世界。"]),
  "你好。 世界。"
);

const attemptedChunks: string[] = [];
const settledChunks: string[] = [];
const independentChunkResults = await __test__.runChunksIndependently(
  ["first", "fails", "last"],
  async (chunk: string) => {
    attemptedChunks.push(chunk);
    if (chunk === "fails") throw new Error("chunk rejected");
    return chunk.toUpperCase();
  },
  (result: { status: string }, index: number) => settledChunks.push(`${index}:${result.status}`)
);
assert.deepEqual(attemptedChunks, ["first", "fails", "last"]);
assert.deepEqual(settledChunks, ["0:completed", "1:failed", "2:completed"]);
assert.deepEqual(independentChunkResults.map((result: { status: string }) => result.status), ["completed", "failed", "completed"]);
const pausedChunks: string[] = [];
const pauseController = new AbortController();
await assert.rejects(__test__.runChunksIndependently(
  ["first", "later"],
  async (chunk: string) => {
    pausedChunks.push(chunk);
    return chunk;
  },
  (_result: unknown, index: number) => {
    if (index === 0) pauseController.abort();
  },
  pauseController.signal
), /Generation aborted/);
assert.deepEqual(pausedChunks, ["first"]);

const gatewayError = __test__.normalizeOpenAIError(
  new Error("500 invalid character 'e' looking for beginning of value")
);

assert.match(gatewayError.message, /非 JSON 或损坏的 JSON/);
assert.ok(!gatewayError.message.includes(`模型 ${DEFAULT_MODEL} 不可用或当前账号无权限`));
assert.equal(__test__.isGatewayNonJsonError("500 invalid character 'e' looking for beginning of value"), true);
assert.equal(__test__.shouldFallbackToChat(new Error("500 invalid character 'e' looking for beginning of value")), true);

const modelError = __test__.normalizeOpenAIError(new Error(`model ${DEFAULT_MODEL} not found`));
assert.ok(modelError.message.includes(`模型 ${DEFAULT_MODEL} 不可用或当前账号无权限`));
assert.equal(__test__.shouldFallbackToChat(new Error(`model ${DEFAULT_MODEL} not found`)), false);

const responseFormatError = new Error("response_format json_schema is unsupported");
assert.equal(__test__.shouldFallbackToChat(responseFormatError), true);

const overloadedError = __test__.normalizeOpenAIError(new Error("503 system cpu overloaded"));
assert.match(overloadedError.message, /上游服务返回 503/);
assert.match(overloadedError.message, /system cpu overloaded/);
assert.equal(__test__.isTransientGatewayError(new Error("503 system cpu overloaded")), true);
const rateLimitError = Object.assign(new Error("429 openai_error"), {
  status: 429,
  error: { message: "openai_error", type: "rate_limit_error", code: "rate_limit_exceeded" }
});
const normalizedRateLimitError = __test__.normalizeOpenAIError(rateLimitError);
assert.match(normalizedRateLimitError.message, /上游接口返回 429/);
assert.match(normalizedRateLimitError.message, /请求频率过高、额度不足或供应商限制/);
assert.match(normalizedRateLimitError.message, /rate_limit_exceeded/);
assert.equal(__test__.isTransientGatewayError(rateLimitError), true);
assert.equal(__test__.isRateLimitError(rateLimitError), true);
assert.equal(__test__.shouldRetryModelRequest(rateLimitError, "storyboard"), true);
const retryableStoryboardChunk = "【分镜单元 1】First.\n【分镜单元 2】Second.";
const sensitiveWordsError = Object.assign(new Error("500 sensitive_words_detected (request id: demo-request)"), {
  status: 500,
  code: "sensitive_words_detected"
});
assert.equal(__test__.isContentFilterError(sensitiveWordsError), true);
assert.equal(__test__.isTransientGatewayError(sensitiveWordsError), false);
assert.equal(__test__.shouldRetryModelRequest(sensitiveWordsError, "storyboard"), false);
assert.equal(__test__.shouldSplitStoryboardChunk(sensitiveWordsError, retryableStoryboardChunk, 0), false);
assert.equal(__test__.shouldFallbackToChat(sensitiveWordsError), false);
assert.equal(__test__.shouldFallbackToManualJson(sensitiveWordsError), false);
assert.match(__test__.normalizeOpenAIError(sensitiveWordsError).message, /内容安全策略拦截/);
assert.match(__test__.normalizeOpenAIError(sensitiveWordsError).message, /demo-request/);
assert.equal(__test__.shouldSplitStoryboardChunk(rateLimitError, retryableStoryboardChunk, 0), false);
assert.equal(__test__.shouldSplitStoryboardChunk(new Error("503 system cpu overloaded"), retryableStoryboardChunk, 0), true);
const connectionError = __test__.normalizeOpenAIError(new Error("Connection error."));
assert.match(connectionError.message, /上游连接错误/);
assert.equal(__test__.isTransientGatewayError(new Error("Connection error.")), true);
assert.equal(__test__.isTransientGatewayError(connectionError), true);
assert.equal(__test__.getTransientRetryCount(), 3);
assert.equal(__test__.getTransientRetryBaseDelayMs(), 1000);
assert.equal(__test__.getTransientRetryDelayMs(0), 1000);
assert.equal(__test__.getTransientRetryDelayMs(1), 2000);
assert.equal(__test__.getModelRequestTimeoutMs("analysis"), 180000);
assert.equal(__test__.getModelRequestTimeoutMs("storyboard"), 90000);
assert.equal(__test__.getMaxStoryboardAdaptiveSplitDepth(), 2);
assert.match(__test__.createModelTimeoutError("storyboard", 2400).message, /请求内容约 2400 字符/);
assert.match(__test__.createModelTimeoutError("storyboard", 2400).message, /上游排队\/拥塞/);
assert.equal(__test__.shouldRetryModelRequest(new Error("分镜阶段模型请求超时（90000ms）"), "storyboard"), false);
assert.equal(__test__.shouldRetryModelRequest(new Error("上游服务返回 503"), "storyboard"), true);
assert.equal(__test__.shouldRetryModelRequest(new Error("理解阶段模型请求超时（180000ms）"), "analysis"), true);

const responseProbeClient = {
  responses: { create: async () => ({ output_text: "ok" }) },
  chat: { completions: { create: async () => { throw new Error("should not call chat"); } } }
} as never;
const responseProbe = await __test__.probeModelConnectionWithClient(responseProbeClient, "demo-model", 1000);
assert.equal(responseProbe.api, "responses");
assert.equal(responseProbe.model, "demo-model");

let chatFallbackCalled = false;
const chatProbeClient = {
  responses: { create: async () => { throw new Error("Responses API unsupported"); } },
  chat: { completions: { create: async () => { chatFallbackCalled = true; return {}; } } }
} as never;
const chatProbe = await __test__.probeModelConnectionWithClient(chatProbeClient, "chat-model", 1000);
assert.equal(chatProbe.api, "chat_completions");
assert.equal(chatFallbackCalled, true);

assert.equal(__test__.getParallelLimit(), 1);
assert.doesNotThrow(() => __test__.createAnalysisTextFormatForTest());

const safeSamplePrompt = __test__.buildStoryboardPrompt(
  "【分镜单元 1】林舟走进空荡的图书馆，窗边的光落在一本摊开的旧书上。",
  {
    visualStyle: "2D",
    scriptStyle: "温暖治愈",
    language: "zh",
    readingRate: 0.95,
    readingRateUnit: "secondsPerChar",
    episodeCount: 1
  },
  { logline: "一次安静的发现", characters: [], scenes: [], keyEvents: [], emotionalRhythm: [], continuityNotes: [] },
  1,
  1
);
assert.doesNotMatch(safeSamplePrompt, /肢解|内脏|酷刑|性侵|自伤|色情|敏感部位|武器制作|爆炸物/);

const originalMockAiSetting = process.env.JSSTORY_MOCK_AI;
process.env.JSSTORY_MOCK_AI = "1";
try {
  const safeNovelText = Array.from({ length: 3 }, (_, index) =>
    `第${index + 1}天，林舟走进安静的图书馆，窗边的阳光落在一本摊开的旧书上。他在书页间发现一封信，读完后决定把它交给管理员。`
  ).join("");
  const safeNovelSettings = {
    visualStyle: "2D",
    scriptStyle: "温暖治愈",
    language: "zh",
    readingRate: 0.95,
    readingRateUnit: "secondsPerChar",
    episodeCount: 1
  } as const;
  const safeNovelAnalysis = await __test__.analyzeNovel([safeNovelText], safeNovelSettings);
  const safeNovelPlan = buildStoryboardPlan(safeNovelText, "zh", 0.95, "secondsPerChar");
  const mockGenerationEvents: Array<{ type: string }> = [];
  const safeNovelStoryboard = await __test__.generateStoryboardStream(
    safeNovelPlan,
    safeNovelSettings,
    safeNovelAnalysis,
    (event) => mockGenerationEvents.push(event)
  );
  assert.ok(safeNovelStoryboard.shots.length > 0);
  assert.ok(mockGenerationEvents.some((event) => event.type === "storyboard_progress"));
  assert.ok(mockGenerationEvents.some((event) => event.type === "storyboard_chunk"));
  assert.ok(mockGenerationEvents.some((event) => event.type === "storyboard_retrying"));
  assert.match(safeNovelStoryboard.shots[0].sourceText, /林舟/);
} finally {
  if (originalMockAiSetting === undefined) delete process.env.JSSTORY_MOCK_AI;
  else process.env.JSSTORY_MOCK_AI = originalMockAiSetting;
}

const analysisPromptWithSkills = __test__.buildAnalysisPrompt(
  "Adam looked at the silver necklace and went silent.",
  {
    visualStyle: "photoreal",
    scriptStyle: "悬疑",
    language: "en",
    readingRate: 0.95,
    readingRateUnit: "secondsPerChar",
    episodeCount: 1
  },
  1,
  1
);
assert.match(analysisPromptWithSkills, /Prompt Skill Set: analysis/);
assert.match(analysisPromptWithSkills, /Prompt Skill: evidence-first-analysis/);
assert.equal((analysisPromptWithSkills.match(/Prompt Skill: evidence-first-analysis/g) ?? []).length, 1);
assert.match(analysisPromptWithSkills, /quote 必须是原文中的短句或词组/);
assert.match(analysisPromptWithSkills, /理解档案字段输出使用中文/);
assert.match(analysisPromptWithSkills, /输出语言：中文/);
assert.doesNotMatch(analysisPromptWithSkills, /小说理解 skill/);

const machineTranslationUrl = __test__.buildMachineTranslationUrl("The old station was silent.");
assert.match(machineTranslationUrl, /translate\.googleapis\.com\/translate_a\/single/);
assert.match(machineTranslationUrl, /sl=auto/);
assert.match(machineTranslationUrl, /tl=zh-CN/);
assert.match(machineTranslationUrl, /q=The\+old\+station/);
const fallbackTranslationUrl = __test__.buildFallbackMachineTranslationUrl("The old station was silent.");
assert.match(fallbackTranslationUrl, /api\.mymemory\.translated\.net\/get/);
assert.match(fallbackTranslationUrl, /langpair=en%7Czh-CN/);
assert.equal(
  __test__.parseMachineTranslationResponse([[ ["旧车站", "The old station"], ["很安静。", " was silent."] ]]),
  "旧车站很安静。"
);
assert.equal(
  __test__.parseFallbackMachineTranslationResponse({ responseData: { translatedText: "旧车站很安静。" }, responseStatus: 200 }),
  "旧车站很安静。"
);
const machineTranslationFailure = __test__.describeMachineTranslationFailure(
  machineTranslationUrl,
  new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND translate.googleapis.com"), { code: "ENOTFOUND" }) })
);
assert.match(machineTranslationFailure, /translate\.googleapis\.com/);
assert.match(machineTranslationFailure, /DNS/);
assert.doesNotMatch(machineTranslationFailure, /fetch failed$/);
const fallbackResponse = new Response(JSON.stringify({ responseData: { translatedText: "旧车站很安静。" }, responseStatus: 200 }), { status: 200 });
const fallbackResult = await __test__.translateMachineChunk("The old station was silent.", async (input) => {
  if (String(input).includes("translate.googleapis.com")) throw new TypeError("fetch failed");
  return fallbackResponse;
});
assert.equal(fallbackResult, "旧车站很安静。");
await assert.rejects(
  __test__.translateMachineChunk("The old station was silent.", async () => {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) });
  }),
  /translate\.googleapis\.com DNS 解析失败；api\.mymemory\.translated\.net DNS 解析失败/
);

const safetyPrompt = __test__.buildStoryboardPrompt(
  "【分镜单元 1】林昭听见门外传来异常响动，她屏住呼吸看向门缝。",
  {
    visualStyle: "photoreal",
    scriptStyle: "惊悚",
    language: "zh",
    readingRate: 0.95,
    readingRateUnit: "secondsPerChar",
    episodeCount: 1
  },
  {
    logline: "林昭在出租屋中察觉异常。",
    characters: [],
    scenes: [],
    keyEvents: [],
    emotionalRhythm: [],
    continuityNotes: []
  },
  1,
  1
);
assert.match(safetyPrompt, /Prompt Skill Set: storyboard/);
assert.match(safetyPrompt, /Prompt Skill: original-text-fidelity/);
assert.match(safetyPrompt, /Prompt Skill: speech-ordering/);
assert.match(safetyPrompt, /Prompt Skill: scene-evidence/);
assert.match(safetyPrompt, /Prompt Skill: cinematic-image-quality/);
assert.match(safetyPrompt, /Prompt Skill: visual-safety/);
[
  "original-text-fidelity",
  "speech-ordering",
  "scene-evidence",
  "cinematic-image-quality",
  "visual-safety"
].forEach((skillId) => {
  assert.equal((safetyPrompt.match(new RegExp(`Prompt Skill: ${skillId}`, "g")) ?? []).length, 1);
});
assert.match(safetyPrompt, /安全画面化规则/);
assert.match(safetyPrompt, /克制、非具象、非操作性的表达/);
assert.match(safetyPrompt, /不展开过程/);
assert.match(safetyPrompt, /安全画面化只约束视觉表达/);
assert.doesNotMatch(safetyPrompt, /肢解|内脏|酷刑|性侵|自伤|色情|敏感部位|武器制作|爆炸物/);
assert.match(safetyPrompt, /\[镜头语法 \/ 视角 \/ 景别 \/ 焦距 \/ 焦点变化 \/\/ 运动或强度\]/);
assert.doesNotMatch(safetyPrompt, /景别或景别切换 \/ 焦段或焦距变化/);
assert.match(safetyPrompt, /中景 -> 近景/);
assert.match(safetyPrompt, /焦距变化/);
assert.match(safetyPrompt, /焦点转移/);
assert.match(safetyPrompt, /默认保持单一景别、单一焦距和稳定焦点/);
assert.match(safetyPrompt, /没有明确叙事原因时，只写一个最合适的景别/);
assert.match(safetyPrompt, /表情细节/);
assert.match(safetyPrompt, /近景、特写、面部或细节镜头/);
assert.match(safetyPrompt, /中景、全景、远景、全身、半身或多人同框/);
assert.match(safetyPrompt, /动作路径、人物站位、距离关系/);
assert.match(safetyPrompt, /手部动作/);
assert.match(safetyPrompt, /身体姿态/);
assert.match(safetyPrompt, /嘴角状态/);
assert.match(safetyPrompt, /眼部状态/);
assert.match(safetyPrompt, /面部状态/);
assert.match(safetyPrompt, /视线方向/);
assert.match(safetyPrompt, /不能使用代称作为人物名/);
assert.match(safetyPrompt, /他\/她\/它\/he\/she\/it\/they/);
assert.match(safetyPrompt, /当前场景光源/);
assert.match(safetyPrompt, /主光源来源、光线方向、光线质感/);
assert.match(safetyPrompt, /高级动画感，不是越真实越好/);
assert.match(safetyPrompt, /本段相关理解档案/);
assert.doesNotMatch(safetyPrompt, /"characters"/);

const splitRetryChunks = __test__.splitStoryboardChunkForRetry([
  "【分镜单元 1】A.",
  "【分镜单元 2】B.",
  "【分镜单元 3】C.",
  "【分镜单元 4】D."
].join("\n"));
assert.deepEqual(splitRetryChunks, [
  "【分镜单元 1】A.\n【分镜单元 2】B.",
  "【分镜单元 3】C.\n【分镜单元 4】D."
]);

const relevantContext = __test__.renderRelevantAnalysisContext({
  logline: "林昭在出租屋中察觉异常。",
  characters: [
    { name: "林昭", role: "主角", appearance: "短发", costume: "风衣", continuityNote: "始终警觉" },
    { name: "周远", role: "邻居", appearance: "戴眼镜", costume: "灰色外套", continuityNote: "总在门缝后观察" }
  ],
  scenes: [
    { name: "出租屋", location: "旧城", mood: "紧张", visualAnchor: "昏黄灯光" },
    { name: "天台", location: "楼顶", mood: "冷清", visualAnchor: "风声" }
  ],
  keyEvents: ["收到匿名信"],
  emotionalRhythm: ["疑虑上升"],
  continuityNotes: ["门外脚步持续逼近"]
}, "【分镜单元 1】林昭在出租屋里看见匿名信。", [
  "【分镜单元 1】上一段脚步声靠近。",
  "【分镜单元 2】林昭在出租屋里看见匿名信。",
  "【分镜单元 3】下一段门把手开始转动。"
], 1);
assert.match(relevantContext, /本段相关人物：林昭/);
assert.match(relevantContext, /本段相关场景：出租屋/);
assert.match(relevantContext, /上一段：上一段脚步声靠近/);
assert.match(relevantContext, /下一段：下一段门把手开始转动/);
assert.doesNotMatch(relevantContext, /"logline"/);

const unsupportedAnalysisContext = __test__.renderRelevantAnalysisContext({
  logline: "项链让Adam沉默。",
  characters: [
    { name: "Vivian", role: "silver necklace observer", appearance: "fragile", costume: "dress", continuityNote: "冷笑旁观" }
  ],
  scenes: [
    { name: "顶层公寓", location: "penthouse apartment", mood: "压抑", visualAnchor: "silver necklace" }
  ],
  keyEvents: ["Vivian watches Adam in the penthouse apartment"],
  emotionalRhythm: ["震惊"],
  continuityNotes: ["Vivian始终站在Adam身边"]
}, "【分镜单元 1】Adam looked at the silver necklace and went silent.", [
  "【分镜单元 1】Adam looked at the silver necklace and went silent."
], 0);
assert.doesNotMatch(unsupportedAnalysisContext, /Vivian/);
assert.doesNotMatch(unsupportedAnalysisContext, /顶层公寓|penthouse apartment/);

const unsupportedRhythmContext = __test__.renderRelevantAnalysisContext({
  logline: "项链让Adam沉默。",
  characters: [],
  scenes: [],
  keyEvents: [],
  emotionalRhythm: ["Vivian在医院旁观，医生围住Adam"],
  continuityNotes: []
}, "【分镜单元 1】Adam looked at the silver necklace and went silent.", [
  "【分镜单元 1】Adam looked at the silver necklace and went silent."
], 0);
assert.doesNotMatch(unsupportedRhythmContext, /Vivian|医院|医生/);

const locallyMergedAnalysis = __test__.mergeAnalysisPartialsLocally([
  {
    logline: "第一段钩子",
    characters: [
      { name: "林昭", role: "主角", appearance: "短发", costume: "风衣", continuityNote: "警觉" }
    ],
    scenes: [
      { name: "出租屋", location: "旧城", mood: "紧张", visualAnchor: "灯光" }
    ],
    keyEvents: ["收到匿名信"],
    emotionalRhythm: ["疑虑上升"],
    continuityNotes: ["保持风衣"]
  },
  {
    logline: "第二段钩子",
    characters: [
      { name: "林昭", role: "主角", appearance: "短发", costume: "风衣", continuityNote: "警觉" },
      { name: "周远", role: "邻居", appearance: "戴眼镜", costume: "灰色外套", continuityNote: "门后观察" }
    ],
    scenes: [
      { name: "出租屋", location: "旧城", mood: "紧张", visualAnchor: "灯光" },
      { name: "楼道", location: "旧楼", mood: "压迫", visualAnchor: "脚步声" }
    ],
    keyEvents: ["收到匿名信", "脚步逼近"],
    emotionalRhythm: ["疑虑上升", "紧张推进"],
    continuityNotes: ["保持风衣", "脚步声持续"]
  }
]);
assert.equal(locallyMergedAnalysis.logline, "第一段钩子");
assert.deepEqual(locallyMergedAnalysis.characters.map((character) => character.name), ["林昭", "周远"]);
assert.deepEqual(locallyMergedAnalysis.scenes.map((scene) => scene.name), ["出租屋", "楼道"]);
assert.deepEqual(locallyMergedAnalysis.keyEvents, ["收到匿名信", "脚步逼近"]);

const sanitizedShot = __test__.normalizeShotTextFields({
  sourceText: "原文里保留敏感表达：鲜血。",
  anchorSentence: "鲜血。",
  narration: "旁白保留原文：鲜血。",
  dialogueLines: [
    { speaker: "甲", delivery: "低声", text: "鲜血。" }
  ],
  imageDescription: "地面出现鲜血，旁边有尸体。男人触摸她的敏感部位，胸部被镜头强调。",
  shotType: "血腥特写和敏感接触",
  characters: ["甲"],
  scene: "房间",
  emotion: "恐惧",
  prompt: "[画面细节] 鲜血和尸体特写，男人触摸她的敏感部位，胸部被镜头强调。\n[台词/旁白] 旁白：“鲜血。”"
});
assert.equal(sanitizedShot.sourceText, "原文里保留敏感表达：鲜血。");
assert.equal(sanitizedShot.narration, "旁白保留原文：鲜血。");
assert.equal(sanitizedShot.dialogueLines[0].text, "鲜血。");
assert.doesNotMatch(sanitizedShot.imageDescription, /鲜血|尸体/);
assert.doesNotMatch(sanitizedShot.prompt.split("[台词/旁白]")[0], /鲜血|尸体|敏感部位|胸部/);
assert.match(sanitizedShot.prompt, /红色液体/);
assert.match(sanitizedShot.prompt, /肩侧或手臂/);
assert.match(sanitizedShot.prompt, /\[台词\/旁白\] 旁白：“鲜血。”/);

const pronounCharacterShot = __test__.normalizeShotTextFields({
  sourceText: "Adam lowered his head and Vivian stepped back.",
  anchorSentence: "Vivian stepped back.",
  narration: "Adam lowered his head and Vivian stepped back.",
  dialogueLines: [
    { speaker: "she", delivery: "低声", text: "I understand." },
    { speaker: "Adam", delivery: "疲惫", text: "Leave." }
  ],
  imageDescription: "Adam站在窗边，Vivian后退。",
  shotType: "中景",
  characters: ["Adam", "she", "他", "Vivian", "it", "Adam"],
  scene: "公寓",
  emotion: "压抑",
  prompt: "[画面细节] Adam站在窗边，Vivian后退。\n[台词/旁白] she（低声）：“I understand.”；Adam（疲惫）：“Leave.”"
});
assert.deepEqual(pronounCharacterShot.characters, ["Adam", "Vivian"]);
assert.equal(pronounCharacterShot.dialogueLines[0].speaker, "未指明说话者");
assert.equal(pronounCharacterShot.dialogueLines[1].speaker, "Adam");
assert.doesNotMatch(pronounCharacterShot.prompt, /she（低声）/);
assert.match(pronounCharacterShot.prompt, /未指明说话者（低声）：“I understand\.”/);

const mixedSpeechShot = __test__.normalizeShotTextFields({
  sourceText: "他说别回头。林昭停下脚步。",
  anchorSentence: "林昭停下脚步。",
  narration: "林昭停下脚步。",
  dialogueLines: [
    { speaker: "周远", delivery: "紧张+低声", text: "别回头。" }
  ],
  imageDescription: "周远说话后闭上嘴，镜头切到林昭的手。",
  shotType: "反应镜头",
  characters: ["周远", "林昭"],
  scene: "楼道",
  emotion: "紧张",
  prompt: "[台词/旁白] 周远（紧张+低声）：“别回头。”；旁白：“林昭停下脚步。”"
});
assert.match(mixedSpeechShot.prompt, /周远（紧张\+低声）：“别回头。”；【停顿0\.4s，周远静默无发声】；旁白：“林昭停下脚步。”/);

const narrationFirstMixedSpeechShot = __test__.normalizeShotTextFields({
  sourceText: "林昭停下脚步。他说别回头。",
  anchorSentence: "他说别回头。",
  narration: "林昭停下脚步。",
  dialogueLines: [
    { speaker: "周远", delivery: "紧张+低声", text: "别回头。" }
  ],
  imageDescription: "林昭停下脚步，周远低声提醒。",
  shotType: "中景",
  characters: ["周远", "林昭"],
  scene: "楼道",
  emotion: "紧张",
  prompt: "[台词/旁白] 旁白：“林昭停下脚步。”；周远（紧张+低声）：“别回头。”"
});
assert.match(narrationFirstMixedSpeechShot.prompt, /旁白：“林昭停下脚步。”；【停顿0\.4s】；周远（紧张\+低声）：“别回头。”/);

const repairedPlainNarrationShot = __test__.normalizeShotTextFields({
  sourceText: "She floated silently above the room.",
  anchorSentence: "She floated silently above the room.",
  narration: "She floated silently",
  dialogueLines: [
    { speaker: "Adam", delivery: "低声", text: "I can see you." }
  ],
  imageDescription: "她漂浮在房间上方。",
  shotType: "中景",
  characters: ["Adam"],
  scene: "房间",
  emotion: "压抑",
  prompt: "[台词/旁白] 旁白：“She floated silently”；Adam（低声）：“I can see you.”"
}, "She floated silently above the room.");
assert.equal(repairedPlainNarrationShot.sourceText, "She floated silently above the room.");
assert.equal(repairedPlainNarrationShot.narration, "She floated silently above the room.");
assert.deepEqual(repairedPlainNarrationShot.dialogueLines, []);
assert.match(repairedPlainNarrationShot.prompt, /\[台词\/旁白\] 旁白：“She floated silently above the room\.”/);
assert.doesNotMatch(repairedPlainNarrationShot.prompt, /I can see you/);

const repairedMixedReadingShot = __test__.normalizeShotTextFields({
  sourceText: "Vivian trembled, looking pitiful.",
  anchorSentence: "Vivian trembled, looking pitiful.",
  narration: "Vivian trembled.",
  dialogueLines: [
    { speaker: "Vivian", delivery: "哭腔", text: "Why would she send me something like this?" },
    { speaker: "Adam", delivery: "愤怒", text: "A line that is not in the source." }
  ],
  imageDescription: "Vivian坐在沙发边缘。",
  shotType: "近景",
  characters: ["Vivian", "Adam"],
  scene: "公寓",
  emotion: "紧张",
  prompt: "[台词/旁白] Vivian（哭腔）：“Why would she send me something like this?”；Adam（愤怒）：“A line that is not in the source.”"
}, "Vivian trembled, looking pitiful: \"Why would she send me something like this?\"");
assert.equal(repairedMixedReadingShot.sourceText, "Vivian trembled, looking pitiful: \"Why would she send me something like this?\"");
assert.equal(repairedMixedReadingShot.narration, "Vivian trembled, looking pitiful:");
assert.deepEqual(repairedMixedReadingShot.dialogueLines, [
  { speaker: "Vivian", delivery: "哭腔", text: "Why would she send me something like this?" }
]);
assert.match(repairedMixedReadingShot.prompt, /旁白：“Vivian trembled, looking pitiful:”；【停顿0\.4s】；Vivian（哭腔）：“Why would she send me something like this\?”/);
assert.doesNotMatch(repairedMixedReadingShot.prompt, /A line that is not in the source/);

const singleQuotedDialogueShot = __test__.normalizeShotTextFields({
  sourceText: "'I know,' Adam whispered.",
  anchorSentence: "'I know,' Adam whispered.",
  narration: "'I know,' Adam whispered.",
  dialogueLines: [
    { speaker: "Adam", delivery: "低声", text: "I know," }
  ],
  imageDescription: "Adam低声开口。",
  shotType: "近景",
  characters: ["Adam"],
  scene: "房间",
  emotion: "压抑",
  prompt: "[台词/旁白] 旁白：“'I know,' Adam whispered.”"
}, "'I know,' Adam whispered.");
assert.equal(singleQuotedDialogueShot.narration, "Adam whispered.");
assert.deepEqual(singleQuotedDialogueShot.dialogueLines, [
  { speaker: "Adam", delivery: "低声", text: "I know," }
]);
assert.match(singleQuotedDialogueShot.prompt, /Adam（低声）：“I know,”；【停顿0\.8s】；旁白：“Adam whispered\.”/);

const possessiveApostropheShot = __test__.normalizeShotTextFields({
  sourceText: "Vivian's heart was failing.",
  anchorSentence: "Vivian's heart was failing.",
  narration: "Vivian's heart was failing.",
  dialogueLines: [
    { speaker: "Vivian", delivery: "虚弱", text: "s heart was failing." }
  ],
  imageDescription: "Vivian虚弱地坐着。",
  shotType: "中景",
  characters: ["Vivian"],
  scene: "公寓",
  emotion: "紧张",
  prompt: "[台词/旁白] Vivian（虚弱）：“s heart was failing.”"
}, "Vivian's heart was failing.");
assert.equal(possessiveApostropheShot.narration, "Vivian's heart was failing.");
assert.deepEqual(possessiveApostropheShot.dialogueLines, []);

const repairedChunkResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "First sentence.",
      anchorSentence: "First sentence.",
      narration: "First sentence.",
      dialogueLines: [],
      imageDescription: "第一句画面。",
      shotType: "中景",
      characters: [],
      scene: "房间",
      emotion: "平静",
      prompt: "[台词/旁白] 旁白：“First sentence.”"
    }
  ],
  notes: []
}, "【分镜单元 1】Adam stood in the corridor, listening to the locked door.\n【分镜单元 2】He reached toward the handle without speaking.");
assert.equal(repairedChunkResult.shots.length, 2);
assert.equal(repairedChunkResult.shots[1].sourceText, "He reached toward the handle without speaking.");
assert.equal(repairedChunkResult.shots[1].narration, "He reached toward the handle without speaking.");
assert.match(repairedChunkResult.shots[1].prompt, /\[台词\/旁白\] 旁白：“He reached toward the handle without speaking\.”/);
assert.doesNotMatch(repairedChunkResult.shots[1].prompt, /根据原文内容设计安全画面/);
assert.match(repairedChunkResult.shots[1].prompt, /corridor|locked door|handle/i);
assert.match(repairedChunkResult.shots[1].prompt, /\[导演批注\] 保底修复镜头，用于补齐模型遗漏的原文分镜单元。/);

const naturalFallbackShotResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "Return to the Binding Rite.",
      anchorSentence: "Return to the Binding Rite.",
      narration: "Return to the Binding Rite.",
      dialogueLines: [],
      imageDescription: "Aurelia Academy的召唤大厅内，石质仪式台位于画面中央，墙面符文保持微光。",
      shotType: "中景",
      characters: [],
      scene: "Summoning Hall",
      emotion: "苏醒",
      prompt: "[画面细节] Aurelia Academy的召唤大厅内，石质仪式台位于画面中央，墙面符文保持微光。\n[台词/旁白] 旁白：“Return to the Binding Rite.”"
    }
  ],
  notes: []
}, "【分镜单元 1】Return to the Binding Rite.\n【分镜单元 2】I opened my eyes and found myself in the Summoning Hall of Aurelia Academy.");
const naturalFallbackVisualPrompt = naturalFallbackShotResult.shots[1].prompt.split("[台词/旁白]")[0];
assert.equal(naturalFallbackShotResult.shots[1].sourceText, "I opened my eyes and found myself in the Summoning Hall of Aurelia Academy.");
assert.doesNotMatch(naturalFallbackShotResult.shots[1].characters.join(" "), /Return|Binding Rite|Summoning Hall|Aurelia Academy/);
assert.match(naturalFallbackVisualPrompt, /Summoning Hall|Aurelia Academy|召唤大厅/);
assert.match(naturalFallbackVisualPrompt, /睁开|抬眼|眼睛|苏醒|open/i);
assert.match(naturalFallbackVisualPrompt, /光|灯|阴影|轮廓|light/i);
assert.doesNotMatch(naturalFallbackVisualPrompt, /当前场景主光源/);
assert.doesNotMatch(naturalFallbackVisualPrompt, /执行当前句动作|当前句动作|基于原文的保守人物画面/);
assert.doesNotMatch(naturalFallbackVisualPrompt, /I opened my eyes and found myself in the Summoning Hall of Aurelia Academy\./);
assert.match(naturalFallbackShotResult.shots[1].prompt, /\[台词\/旁白\] 旁白：“I opened my eyes and found myself in the Summoning Hall of Aurelia Academy\.”/);
assert.match(naturalFallbackShotResult.shots[1].prompt, /\[导演批注\] 保底修复镜头，用于补齐模型遗漏的原文分镜单元。/);

const titleAndPrepositionFallbackResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "Fate Written in Bloodline.",
      anchorSentence: "Fate Written in Bloodline.",
      narration: "Fate Written in Bloodline.",
      dialogueLines: [],
      imageDescription: "标题画面淡出。",
      shotType: "中景",
      characters: ["From"],
      scene: "Fate Written in Bloodline",
      emotion: "铺垫",
      prompt: "[画面细节] 标题画面淡出。\n[台词/旁白] 旁白：“Fate Written in Bloodline.”"
    }
  ],
  notes: []
}, "【分镜单元 1】Fate Written in Bloodline.\n【分镜单元 2】In this world,");
const titleFallbackVisualPrompt = titleAndPrepositionFallbackResult.shots[1].prompt.split("[台词/旁白]")[0];
assert.doesNotMatch(titleAndPrepositionFallbackResult.shots[1].characters.join(" "), /\bFrom\b|Fate Written in Bloodline/);
assert.notEqual(titleAndPrepositionFallbackResult.shots[1].scene, "Fate Written in Bloodline");
assert.doesNotMatch(titleFallbackVisualPrompt, /Fate Written in Bloodline中|From承接|保留From|沿着From/);
assert.doesNotMatch(titleFallbackVisualPrompt, /世界观信息|人物与关键道具|保留世界观信息/);
assert.match(titleFallbackVisualPrompt, /世界观|叙事|建立|环境|空间/);
assert.match(titleAndPrepositionFallbackResult.shots[1].prompt, /\[台词\/旁白\] 旁白：“In this world,”/);
assert.match(titleAndPrepositionFallbackResult.shots[1].prompt, /\[导演批注\] 保底修复镜头，用于补齐模型遗漏的原文分镜单元。/);

const openingWorldbuildingSceneResult = __test__.repairStoryboardChunkResult({
  shots: [],
  notes: []
}, [
  "【分镜单元 1】The world-destroying black dragon From a One-Star Reject to a God Devourer In this world,",
  "【分镜单元 2】an Aether Beast’s Bloodline determines everything.",
  "【分镜单元 3】A creature’s Rank Tier is fixed the moment it is born.",
  "【分镜单元 4】When I opened my eyes again, I was back at the day of the Binding Rite.",
  "【分镜单元 5】I opened my eyes and found myself in the Summoning Hall of Aurelia Academy."
].join("\n"));
const openingWorldbuildingPrompt = openingWorldbuildingSceneResult.shots[0].prompt.split("[台词/旁白]")[0];
assert.match(openingWorldbuildingSceneResult.shots[0].scene, /Summoning Hall|召唤大厅/);
assert.match(openingWorldbuildingSceneResult.shots[1].scene, /Summoning Hall|召唤大厅/);
assert.match(openingWorldbuildingPrompt, /Summoning Hall|召唤大厅|Aurelia Academy|中央祭坛|兽卵/);
assert.doesNotMatch(openingWorldbuildingPrompt, /世界观建立画面，标题或上一镜头淡出后切入环境建立镜头/);
assert.doesNotMatch(openingWorldbuildingPrompt, /当前连续场景/);

const genericWorldbuildingModelResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "The world-destroying black dragon From a One-Star Reject to a God Devourer In this world,",
      anchorSentence: "The world-destroying black dragon From a One-Star Reject to a God Devourer In this world,",
      narration: "The world-destroying black dragon From a One-Star Reject to a God Devourer In this world,",
      dialogueLines: [],
      imageDescription: "世界观建立画面，标题或上一镜头淡出后切入环境建立镜头，画面落在空间入口、墙面纹章和阶层秩序符号上。",
      shotType: "中景",
      characters: [],
      scene: "世界观建立画面",
      emotion: "铺垫",
      prompt: [
        "[00:00-00:04s]",
        "[镜头语法 / 客观视角 / 中景 / 24mm / 深景深，焦点覆盖前中后景 // 稳定横移或缓慢推进]",
        "[画面细节] 世界观建立画面，标题或上一镜头淡出后切入环境建立镜头，画面落在空间入口、墙面纹章和阶层秩序符号上。",
        "[摄影机补充状态] 稳定建立镜头，24mm 深景深缓慢扫过世界观建立画面中的环境符号和空间层次。",
        "[声音设计] 环境声低铺，跟随旁白节奏。",
        "[台词/旁白] 旁白：“The world-destroying black dragon From a One-Star Reject to a God Devourer In this world,”",
        "[导演批注] 模型原始镜头。"
      ].join("\n")
    }
  ],
  notes: []
}, [
  "【分镜单元 1】The world-destroying black dragon From a One-Star Reject to a God Devourer In this world,",
  "【分镜单元 2】an Aether Beast’s Bloodline determines everything.",
  "【分镜单元 3】A creature’s Rank Tier is fixed the moment it is born.",
  "【分镜单元 4】When I opened my eyes again, I was back at the day of the Binding Rite.",
  "【分镜单元 5】I opened my eyes and found myself in the Summoning Hall of Aurelia Academy."
].join("\n"));
const repairedGenericWorldbuildingPrompt = genericWorldbuildingModelResult.shots[0].prompt.split("[台词/旁白]")[0];
assert.match(genericWorldbuildingModelResult.shots[0].scene, /Summoning Hall|召唤大厅/);
assert.match(repairedGenericWorldbuildingPrompt, /Aurelia Academy|Summoning Hall|中央祭坛|兽卵|血脉等级纹章/);
assert.doesNotMatch(repairedGenericWorldbuildingPrompt, /世界观建立画面，标题或上一镜头淡出后切入环境建立镜头/);

const qualityCheckedResult = __test__.qualityCheckStoryboardChunkResult({
  shots: [
    {
      sourceText: "Adam looked at the silver necklace and went silent.",
      anchorSentence: "Adam looked at the silver necklace and went silent.",
      narration: "Adam looked at the silver necklace and went silent.",
      dialogueLines: [],
      imageDescription: "基于原文的保守人物画面：Adam looked at the silver necklace and went silent.",
      shotType: "保守中景",
      characters: ["Adam"],
      scene: "未明确场景",
      emotion: "震惊",
      prompt: "[画面细节] 基于原文的保守人物画面：Adam looked at the silver necklace and went silent.\n[台词/旁白] 旁白：“Adam looked at the silver necklace and went silent.”"
    }
  ],
  notes: []
}, "【分镜单元 1】Adam looked at the silver necklace and went silent.");
assert.ok(qualityCheckedResult.notes.some((note) => /质检提示/.test(note)));
assert.ok(qualityCheckedResult.qualityReport.some((issue) => issue.code === "prompt_missing_required_lines"));
assert.ok(qualityCheckedResult.qualityReport.some((issue) => issue.code === "scene_not_explicit"));

const unsupportedSceneResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "Adam looked at the silver necklace and went silent.",
      anchorSentence: "Adam looked at the silver necklace and went silent.",
      narration: "Adam looked at the silver necklace and went silent.",
      dialogueLines: [],
      imageDescription: "医院急救室里，Adam站在手术台旁看着银色项链。",
      shotType: "医院急救室近景",
      characters: ["Adam"],
      scene: "医院急救室",
      emotion: "震惊",
      prompt: [
        "[00:00-00:04s]",
        "[镜头语法 / 客观视角 / 近景 / 35mm / 稳定焦点 // 稳定]",
        "[画面细节] 医院急救室里，Adam站在手术台旁看着银色项链。",
        "[摄影机补充状态] 稳定机位。",
        "[声音设计] 环境声。",
        "[台词/旁白] 旁白：“Adam looked at the silver necklace and went silent.”",
        "[导演批注] 表现医院中的震惊。"
      ].join("\n")
    }
  ],
  notes: []
}, "【分镜单元 1】Adam looked at the silver necklace and went silent.", {
  logline: "项链让Adam沉默。",
  characters: [],
  scenes: [
    { name: "破旧公寓", location: "城市边缘", mood: "压抑", visualAnchor: "银色项链" }
  ],
  keyEvents: [],
  emotionalRhythm: [],
  continuityNotes: []
});
assert.doesNotMatch(unsupportedSceneResult.shots[0].scene, /医院|急救室|手术台/);
assert.doesNotMatch(unsupportedSceneResult.shots[0].imageDescription, /医院|急救室|手术台/);
assert.doesNotMatch(unsupportedSceneResult.shots[0].prompt.split("[台词/旁白]")[0], /医院|急救室|手术台/);
assert.match(unsupportedSceneResult.shots[0].prompt, /可靠性修复镜头/);

const unsupportedVisualSceneResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "Adam looked at the silver necklace and went silent.",
      anchorSentence: "Adam looked at the silver necklace and went silent.",
      narration: "Adam looked at the silver necklace and went silent.",
      dialogueLines: [],
      imageDescription: "顶层公寓里，Adam坐在沙发边看着银色项链沉默。",
      shotType: "近景",
      characters: ["Adam"],
      scene: "未明确场景",
      emotion: "震惊",
      prompt: "[画面细节] 顶层公寓里，Adam坐在沙发边看着银色项链沉默。\n[台词/旁白] 旁白：“Adam looked at the silver necklace and went silent.”"
    }
  ],
  notes: []
}, "【分镜单元 1】Adam looked at the silver necklace and went silent.");
assert.doesNotMatch(unsupportedVisualSceneResult.shots[0].imageDescription, /顶层公寓|沙发/);
assert.doesNotMatch(unsupportedVisualSceneResult.shots[0].prompt.split("[台词/旁白]")[0], /顶层公寓|沙发/);
assert.match(unsupportedVisualSceneResult.shots[0].imageDescription, /Adam.*银色项链.*沉默|Adam.*看着.*银色项链/);
assert.doesNotMatch(unsupportedVisualSceneResult.shots[0].prompt, /可靠性修复镜头/);
assert.match(unsupportedVisualSceneResult.shots[0].prompt, /视觉局部修复|局部校正/);

const leadingPunctuationVisualResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "I stood inside the Summoning Hall.",
      anchorSentence: "I stood inside the Summoning Hall.",
      narration: "I stood inside the Summoning Hall.",
      dialogueLines: [],
      imageDescription: "Aurelia Academy的Summoning Hall中，中央祭坛位于画面中景。",
      shotType: "中景",
      characters: [],
      scene: "Summoning Hall",
      emotion: "回归",
      prompt: [
        "[00:00-00:04s]",
        "[镜头语法 / 客观视角 / 中景 / 35mm / 中等景深，焦点锁定中央祭坛 // 稳定]",
        "[画面细节] Aurelia Academy的Summoning Hall中，中央祭坛位于画面中景，侧上方柔光照亮地面符文，背景墙面保持轻微虚化。",
        "[摄影机补充状态] 稳定机位，35mm 中等景深锁定中央祭坛，背景轻微虚化。",
        "[声音设计] 环境声。",
        "[台词/旁白] 旁白：“I stood inside the Summoning Hall.”",
        "[导演批注] 建立召唤大厅。"
      ].join("\n")
    },
    {
      sourceText: "And when I needed it most, the gryphon turned on me, triggering a Pact Backlash.",
      anchorSentence: "And when I needed it most, the gryphon turned on me, triggering a Pact Backlash.",
      narration: "And when I needed it most, the gryphon turned on me, triggering a Pact Backlash.",
      dialogueLines: [],
      imageDescription: "，狮鹫的巨大阴影压下，环境与角色反应表现契约反噬，不直观描绘伤害细节",
      shotType: "中景",
      characters: [],
      scene: "Summoning Hall",
      emotion: "契约反噬",
      prompt: [
        "[00:00-00:04s]",
        "[镜头语法 / 客观视角 / 中景 / 35mm / 稳定焦点 // 稳定]",
        "[画面细节] ，狮鹫的巨大阴影压下，环境与角色反应表现契约反噬，不直观描绘伤害细节",
        "[摄影机补充状态] 稳定机位。",
        "[声音设计] 环境声。",
        "[台词/旁白] 旁白：“And when I needed it most, the gryphon turned on me, triggering a Pact Backlash.”",
        "[导演批注] 表现契约反噬。"
      ].join("\n")
    }
  ],
  notes: []
}, [
  "【分镜单元 1】I stood inside the Summoning Hall.",
  "【分镜单元 2】And when I needed it most, the gryphon turned on me, triggering a Pact Backlash."
].join("\n"));
assert.doesNotMatch(leadingPunctuationVisualResult.shots[1].imageDescription, /^，/);
assert.doesNotMatch(leadingPunctuationVisualResult.shots[1].prompt, /\[画面细节\]\s*[，,；;]/);
assert.match(leadingPunctuationVisualResult.shots[1].imageDescription, /^狮鹫的巨大阴影压下/);

const doctorIsNotHospitalEvidenceResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "The doctor checked Adam's pulse in the hallway.",
      anchorSentence: "The doctor checked Adam's pulse in the hallway.",
      narration: "The doctor checked Adam's pulse in the hallway.",
      dialogueLines: [],
      imageDescription: "医院急救室里，医生站在手术台旁检查Adam的脉搏。",
      shotType: "医院中景",
      characters: ["Adam"],
      scene: "走廊",
      emotion: "紧张",
      prompt: "[画面细节] 医院急救室里，医生站在手术台旁检查Adam的脉搏。\n[台词/旁白] 旁白：“The doctor checked Adam's pulse in the hallway.”"
    }
  ],
  notes: []
}, "【分镜单元 1】The doctor checked Adam's pulse in the hallway.");
assert.doesNotMatch(doctorIsNotHospitalEvidenceResult.shots[0].imageDescription, /医院|急救室|手术台/);
assert.doesNotMatch(doctorIsNotHospitalEvidenceResult.shots[0].prompt.split("[台词/旁白]")[0], /医院|急救室|手术台/);
assert.match(doctorIsNotHospitalEvidenceResult.shots[0].prompt, /可靠性修复镜头/);

const usefulUnknownSceneResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "Adam looked at the silver necklace and went silent.",
      anchorSentence: "Adam looked at the silver necklace and went silent.",
      narration: "Adam looked at the silver necklace and went silent.",
      dialogueLines: [],
      imageDescription: "Adam低头看着掌心里的银色项链，肩膀僵住，手指收紧，侧上方柔和主光落在项链边缘，背景保持低亮度阴影。",
      shotType: "近景",
      characters: ["Adam"],
      scene: "未明确场景",
      emotion: "震惊",
      prompt: [
        "[00:00-00:04s]",
        "[镜头语法 / 客观视角 / 近景 / 35mm / 稳定焦点 // 稳定]",
        "[画面细节] Adam低头看着掌心里的银色项链，肩膀僵住，手指收紧，侧上方柔和主光落在项链边缘，背景保持低亮度阴影。",
        "[摄影机补充状态] 稳定近景，焦点停在Adam的手部和项链之间。",
        "[声音设计] 环境声压低，保留短促呼吸声。",
        "[台词/旁白] 旁白：“Adam looked at the silver necklace and went silent.”",
        "[导演批注] 用沉默反应承接项链带来的冲击。"
      ].join("\n")
    }
  ],
  notes: []
}, "【分镜单元 1】Adam looked at the silver necklace and went silent.");
assert.match(usefulUnknownSceneResult.shots[0].imageDescription, /Adam低头看着掌心里的银色项链/);
assert.doesNotMatch(usefulUnknownSceneResult.shots[0].prompt, /可靠性修复镜头/);

const genericSceneWithUsefulVisualResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "Adam stood in the penthouse apartment, staring at the scattered photos.",
      anchorSentence: "Adam stood in the penthouse apartment, staring at the scattered photos.",
      narration: "Adam stood in the penthouse apartment, staring at the scattered photos.",
      dialogueLines: [],
      imageDescription: "顶层公寓里，Adam盯着散落的照片，侧上方冷光压住桌面，背景照片墙轻微虚化。",
      shotType: "近景",
      characters: ["Adam"],
      scene: "顶层公寓",
      emotion: "震惊",
      prompt: "[画面细节] 顶层公寓里，Adam盯着散落的照片，侧上方冷光压住桌面，背景照片墙轻微虚化。\n[台词/旁白] 旁白：“Adam stood in the penthouse apartment, staring at the scattered photos.”"
    },
    {
      sourceText: "Adam looked at the silver necklace and went silent.",
      anchorSentence: "Adam looked at the silver necklace and went silent.",
      narration: "Adam looked at the silver necklace and went silent.",
      dialogueLines: [],
      imageDescription: "Adam低头看着掌心里的银色项链，肩膀僵住，手指收紧，侧上方柔和主光落在项链边缘，前景保留桌沿，背景陈设轻微虚化。",
      shotType: "近景",
      characters: ["Adam"],
      scene: "当前连续场景",
      emotion: "震惊",
      prompt: [
        "[00:00-00:04s]",
        "[镜头语法 / 客观视角 / 近景 / 35mm / 稳定焦点 // 稳定]",
        "[画面细节] Adam低头看着掌心里的银色项链，肩膀僵住，手指收紧，侧上方柔和主光落在项链边缘，前景保留桌沿，背景陈设轻微虚化。",
        "[摄影机补充状态] 稳定近景，焦点停在Adam的手部和项链之间。",
        "[声音设计] 环境声压低，保留短促呼吸声。",
        "[台词/旁白] 旁白：“Adam looked at the silver necklace and went silent.”",
        "[导演批注] 用沉默反应承接项链带来的冲击。"
      ].join("\n")
    }
  ],
  notes: []
}, [
  "【分镜单元 1】Adam stood in the penthouse apartment, staring at the scattered photos.",
  "【分镜单元 2】Adam looked at the silver necklace and went silent."
].join("\n"), {
  logline: "项链让Adam沉默。",
  characters: [],
  scenes: [
    { name: "顶层公寓", location: "penthouse apartment", mood: "压抑", visualAnchor: "scattered photos" }
  ],
  keyEvents: [],
  emotionalRhythm: [],
  continuityNotes: []
});
const genericSceneUsefulVisualBlock = genericSceneWithUsefulVisualResult.shots[1].prompt.split("[台词/旁白]")[0];
assert.match(genericSceneWithUsefulVisualResult.shots[1].imageDescription, /Adam低头看着掌心里的银色项链/);
assert.match(genericSceneUsefulVisualBlock, /主光|阴影|轮廓|高光/);
assert.match(genericSceneUsefulVisualBlock, /前景|中景|背景|空间层次/);
assert.match(genericSceneUsefulVisualBlock, /虚化|景深|焦点|焦距|35mm|50mm|70mm|85mm/);
assert.doesNotMatch(genericSceneWithUsefulVisualResult.shots[1].prompt, /可靠性修复镜头/);
assert.match(genericSceneWithUsefulVisualResult.shots[1].prompt, /\[台词\/旁白\] 旁白：“Adam looked at the silver necklace and went silent\.”/);

const weakCompletePromptResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "Adam looked at the silver necklace and went silent.",
      anchorSentence: "Adam looked at the silver necklace and went silent.",
      narration: "Adam looked at the silver necklace and went silent.",
      dialogueLines: [],
      imageDescription: "Adam看着银色项链，灯光昏暗。",
      shotType: "近景",
      characters: ["Adam"],
      scene: "未明确场景",
      emotion: "震惊",
      prompt: [
        "[00:00-00:04s]",
        "[镜头语法 / 客观视角 / 近景 / 35mm / 稳定焦点 // 稳定]",
        "[画面细节] Adam看着银色项链，灯光昏暗。",
        "[摄影机补充状态] 稳定机位。",
        "[声音设计] 环境声。",
        "[台词/旁白] 旁白：“Adam looked at the silver necklace and went silent.”",
        "[导演批注] 表现震惊。"
      ].join("\n")
    }
  ],
  notes: []
}, "【分镜单元 1】Adam looked at the silver necklace and went silent.");
const weakCompleteVisualBlock = weakCompletePromptResult.shots[0].prompt.split("[台词/旁白]")[0];
assert.match(weakCompleteVisualBlock, /前景|中景|背景|空间层次/);
assert.match(weakCompleteVisualBlock, /嘴角|眼部|面部|视线/);
assert.match(weakCompleteVisualBlock, /主光|阴影|轮廓|高光/);
assert.match(weakCompleteVisualBlock, /虚化|景深/);
assert.match(weakCompleteVisualBlock, /50mm|70mm|85mm|焦距|焦段|焦点/);
assert.doesNotMatch(weakCompletePromptResult.shots[0].prompt, /可靠性修复镜头/);
assert.match(weakCompletePromptResult.shots[0].prompt, /\[台词\/旁白\] 旁白：“Adam looked at the silver necklace and went silent\.”/);

const keywordOnlyWeakPromptResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "Adam looked at the silver necklace and went silent.",
      anchorSentence: "Adam looked at the silver necklace and went silent.",
      narration: "Adam looked at the silver necklace and went silent.",
      dialogueLines: [],
      imageDescription: "Adam看着银色项链，背景有光，表情复杂。",
      shotType: "近景",
      characters: ["Adam"],
      scene: "未明确场景",
      emotion: "震惊",
      prompt: [
        "[00:00-00:04s]",
        "[镜头语法 / 客观视角 / 近景 / 35mm / 稳定焦点 // 稳定]",
        "[画面细节] Adam看着银色项链，背景有光，表情复杂。",
        "[摄影机补充状态] 焦点清楚。",
        "[声音设计] 保留原声音行。",
        "[台词/旁白] 旁白：“Adam looked at the silver necklace and went silent.”",
        "[导演批注] 保留原导演批注。"
      ].join("\n")
    }
  ],
  notes: []
}, "【分镜单元 1】Adam looked at the silver necklace and went silent.");
const keywordOnlyVisualBlock = keywordOnlyWeakPromptResult.shots[0].prompt.split("[台词/旁白]")[0];
assert.match(keywordOnlyVisualBlock, /前景|中景|背景|空间层次/);
assert.match(keywordOnlyVisualBlock, /嘴角|眼部|面部|视线/);
assert.match(keywordOnlyVisualBlock, /主光|阴影|轮廓|高光/);
assert.match(keywordOnlyVisualBlock, /虚化|景深/);
assert.match(keywordOnlyVisualBlock, /50mm|70mm|85mm|焦距|焦段|焦点/);
assert.match(keywordOnlyWeakPromptResult.shots[0].prompt, /\[声音设计\] 保留原声音行。/);
assert.match(keywordOnlyWeakPromptResult.shots[0].prompt, /\[台词\/旁白\] 旁白：“Adam looked at the silver necklace and went silent\.”/);
assert.match(keywordOnlyWeakPromptResult.shots[0].prompt, /\[导演批注\] 保留原导演批注。/);

const adjacentHallucinatedHospitalResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "Adam looked at the silver necklace and went silent.",
      anchorSentence: "Adam looked at the silver necklace and went silent.",
      narration: "Adam looked at the silver necklace and went silent.",
      dialogueLines: [],
      imageDescription: "医院急救室里，Adam站在手术台旁看着银色项链，一个医生在旁边记录。",
      shotType: "医院急救室近景",
      characters: ["Adam"],
      scene: "医院急救室",
      emotion: "震惊",
      prompt: "[画面细节] 医院急救室里，Adam站在手术台旁看着银色项链，一个医生在旁边记录。\n[台词/旁白] 旁白：“Adam looked at the silver necklace and went silent.”"
    },
    {
      sourceText: "He lowered his eyes and said nothing.",
      anchorSentence: "He lowered his eyes and said nothing.",
      narration: "He lowered his eyes and said nothing.",
      dialogueLines: [],
      imageDescription: "医院急救室里，Adam继续沉默，医生站在手术台边。",
      shotType: "医院急救室近景",
      characters: ["Adam"],
      scene: "医院急救室",
      emotion: "压抑",
      prompt: "[画面细节] 医院急救室里，Adam继续沉默，医生站在手术台边。\n[台词/旁白] 旁白：“He lowered his eyes and said nothing.”"
    }
  ],
  notes: []
}, [
  "【分镜单元 1】Adam looked at the silver necklace and went silent.",
  "【分镜单元 2】He lowered his eyes and said nothing."
].join("\n"));
assert.doesNotMatch(adjacentHallucinatedHospitalResult.shots[0].prompt.split("[台词/旁白]")[0], /医院|急救室|手术台|医生/);
assert.doesNotMatch(adjacentHallucinatedHospitalResult.shots[1].prompt.split("[台词/旁白]")[0], /医院|急救室|手术台|医生/);
assert.match(adjacentHallucinatedHospitalResult.shots[0].prompt, /可靠性修复镜头/);
assert.match(adjacentHallucinatedHospitalResult.shots[1].prompt, /可靠性修复镜头/);

const visualAnchorOnlySceneResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "Adam looked at the silver necklace and went silent.",
      anchorSentence: "Adam looked at the silver necklace and went silent.",
      narration: "Adam looked at the silver necklace and went silent.",
      dialogueLines: [],
      imageDescription: "顶层公寓里，Adam看着银色项链沉默。",
      shotType: "近景",
      characters: ["Adam"],
      scene: "顶层公寓",
      emotion: "震惊",
      prompt: "[画面细节] 顶层公寓里，Adam看着银色项链沉默。\n[台词/旁白] 旁白：“Adam looked at the silver necklace and went silent.”"
    }
  ],
  notes: []
}, "【分镜单元 1】Adam looked at the silver necklace and went silent.", {
  logline: "项链让Adam沉默。",
  characters: [],
  scenes: [
    { name: "顶层公寓", location: "penthouse apartment", mood: "压抑", visualAnchor: "silver necklace" }
  ],
  keyEvents: [],
  emotionalRhythm: [],
  continuityNotes: []
});
assert.doesNotMatch(visualAnchorOnlySceneResult.shots[0].scene, /顶层公寓|penthouse/i);
assert.doesNotMatch(visualAnchorOnlySceneResult.shots[0].imageDescription, /顶层公寓|penthouse/i);

const supportedSceneResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "Adam stood in the penthouse apartment, staring at the scattered photos.",
      anchorSentence: "Adam stood in the penthouse apartment, staring at the scattered photos.",
      narration: "Adam stood in the penthouse apartment, staring at the scattered photos.",
      dialogueLines: [],
      imageDescription: "顶层公寓里，Adam盯着散落的照片。",
      shotType: "近景",
      characters: ["Adam"],
      scene: "顶层公寓",
      emotion: "震惊",
      prompt: "[画面细节] 顶层公寓里，Adam盯着散落的照片。\n[台词/旁白] 旁白：“Adam stood in the penthouse apartment, staring at the scattered photos.”"
    }
  ],
  notes: []
}, "【分镜单元 1】Adam stood in the penthouse apartment, staring at the scattered photos.", {
  logline: "Adam回到顶层公寓。",
  characters: [],
  scenes: [
    { name: "顶层公寓", location: "penthouse apartment", mood: "压抑", visualAnchor: "scattered photos" }
  ],
  keyEvents: [],
  emotionalRhythm: [],
  continuityNotes: []
});
assert.equal(supportedSceneResult.shots[0].scene, "顶层公寓");
assert.match(supportedSceneResult.shots[0].imageDescription, /顶层公寓/);

const inheritedSceneResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "Adam stood in the penthouse apartment, staring at the scattered photos.",
      anchorSentence: "Adam stood in the penthouse apartment, staring at the scattered photos.",
      narration: "Adam stood in the penthouse apartment, staring at the scattered photos.",
      dialogueLines: [],
      imageDescription: "顶层公寓里，Adam盯着散落的照片。",
      shotType: "近景",
      characters: ["Adam"],
      scene: "顶层公寓",
      emotion: "震惊",
      prompt: "[画面细节] 顶层公寓里，Adam盯着散落的照片。\n[台词/旁白] 旁白：“Adam stood in the penthouse apartment, staring at the scattered photos.”"
    },
    {
      sourceText: "Adam looked at the silver necklace and went silent.",
      anchorSentence: "Adam looked at the silver necklace and went silent.",
      narration: "Adam looked at the silver necklace and went silent.",
      dialogueLines: [],
      imageDescription: "医院急救室里，Adam看着银色项链沉默。",
      shotType: "近景",
      characters: ["Adam"],
      scene: "医院急救室",
      emotion: "压抑",
      prompt: "[画面细节] 医院急救室里，Adam看着银色项链沉默。\n[台词/旁白] 旁白：“Adam looked at the silver necklace and went silent.”"
    }
  ],
  notes: []
}, [
  "【分镜单元 1】Adam stood in the penthouse apartment, staring at the scattered photos.",
  "【分镜单元 2】Adam looked at the silver necklace and went silent."
].join("\n"), {
  logline: "Adam回到顶层公寓。",
  characters: [],
  scenes: [
    { name: "顶层公寓", location: "penthouse apartment", mood: "压抑", visualAnchor: "scattered photos" }
  ],
  keyEvents: [],
  emotionalRhythm: [],
  continuityNotes: []
});
assert.equal(inheritedSceneResult.shots[1].scene, "顶层公寓");
assert.match(inheritedSceneResult.shots[1].imageDescription, /顶层公寓/);
assert.doesNotMatch(inheritedSceneResult.shots[1].prompt.split("[台词/旁白]")[0], /医院|急救室/);

const nextInheritedSceneResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "Adam looked at the silver necklace and went silent.",
      anchorSentence: "Adam looked at the silver necklace and went silent.",
      narration: "Adam looked at the silver necklace and went silent.",
      dialogueLines: [],
      imageDescription: "空白背景里，Adam看着银色项链沉默。",
      shotType: "近景",
      characters: ["Adam"],
      scene: "未明确场景",
      emotion: "压抑",
      prompt: "[画面细节] 空白背景里，Adam看着银色项链沉默。\n[台词/旁白] 旁白：“Adam looked at the silver necklace and went silent.”"
    },
    {
      sourceText: "Adam stood in the penthouse apartment, staring at the scattered photos.",
      anchorSentence: "Adam stood in the penthouse apartment, staring at the scattered photos.",
      narration: "Adam stood in the penthouse apartment, staring at the scattered photos.",
      dialogueLines: [],
      imageDescription: "顶层公寓里，Adam盯着散落的照片。",
      shotType: "近景",
      characters: ["Adam"],
      scene: "顶层公寓",
      emotion: "震惊",
      prompt: "[画面细节] 顶层公寓里，Adam盯着散落的照片。\n[台词/旁白] 旁白：“Adam stood in the penthouse apartment, staring at the scattered photos.”"
    }
  ],
  notes: []
}, [
  "【分镜单元 1】Adam looked at the silver necklace and went silent.",
  "【分镜单元 2】Adam stood in the penthouse apartment, staring at the scattered photos."
].join("\n"), {
  logline: "Adam回到顶层公寓。",
  characters: [],
  scenes: [
    { name: "顶层公寓", location: "penthouse apartment", mood: "压抑", visualAnchor: "scattered photos" }
  ],
  keyEvents: [],
  emotionalRhythm: [],
  continuityNotes: []
});
assert.equal(nextInheritedSceneResult.shots[0].scene, "顶层公寓");
assert.match(nextInheritedSceneResult.shots[0].imageDescription, /顶层公寓/);
assert.doesNotMatch(nextInheritedSceneResult.shots[0].imageDescription, /空白背景/);

const previousScenePreferredResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "Adam stood in the penthouse apartment.",
      anchorSentence: "Adam stood in the penthouse apartment.",
      narration: "Adam stood in the penthouse apartment.",
      dialogueLines: [],
      imageDescription: "顶层公寓里Adam站着。",
      shotType: "近景",
      characters: ["Adam"],
      scene: "顶层公寓",
      emotion: "压抑",
      prompt: "[画面细节] 顶层公寓里Adam站着。\n[台词/旁白] 旁白：“Adam stood in the penthouse apartment.”"
    },
    {
      sourceText: "He lowered his eyes and said nothing.",
      anchorSentence: "He lowered his eyes and said nothing.",
      narration: "He lowered his eyes and said nothing.",
      dialogueLines: [],
      imageDescription: "空白背景里，他低下眼睛沉默。",
      shotType: "近景",
      characters: [],
      scene: "未明确场景",
      emotion: "压抑",
      prompt: "[画面细节] 空白背景里，他低下眼睛沉默。\n[台词/旁白] 旁白：“He lowered his eyes and said nothing.”"
    },
    {
      sourceText: "Gary waited in the basement.",
      anchorSentence: "Gary waited in the basement.",
      narration: "Gary waited in the basement.",
      dialogueLines: [],
      imageDescription: "地下室里Gary等待。",
      shotType: "近景",
      characters: ["Gary"],
      scene: "地下室",
      emotion: "紧张",
      prompt: "[画面细节] 地下室里Gary等待。\n[台词/旁白] 旁白：“Gary waited in the basement.”"
    }
  ],
  notes: []
}, [
  "【分镜单元 1】Adam stood in the penthouse apartment.",
  "【分镜单元 2】He lowered his eyes and said nothing.",
  "【分镜单元 3】Gary waited in the basement."
].join("\n"), {
  logline: "两个场景之间的沉默反应。",
  characters: [],
  scenes: [
    { name: "顶层公寓", location: "penthouse apartment", mood: "压抑", visualAnchor: "Adam" },
    { name: "地下室", location: "basement", mood: "紧张", visualAnchor: "Gary" }
  ],
  keyEvents: [],
  emotionalRhythm: [],
  continuityNotes: []
});
assert.equal(previousScenePreferredResult.shots[1].scene, "顶层公寓");
assert.match(previousScenePreferredResult.shots[1].imageDescription, /Adam|顶层公寓/);
assert.doesNotMatch(previousScenePreferredResult.shots[1].imageDescription, /空白背景/);

const blockedInheritedSceneResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "Adam stood in the penthouse apartment.",
      anchorSentence: "Adam stood in the penthouse apartment.",
      narration: "Adam stood in the penthouse apartment.",
      dialogueLines: [],
      imageDescription: "顶层公寓里Adam站着。",
      shotType: "近景",
      characters: ["Adam"],
      scene: "顶层公寓",
      emotion: "压抑",
      prompt: "[画面细节] 顶层公寓里Adam站着。\n[台词/旁白] 旁白：“Adam stood in the penthouse apartment.”"
    },
    {
      sourceText: "He stepped into the hallway.",
      anchorSentence: "He stepped into the hallway.",
      narration: "He stepped into the hallway.",
      dialogueLines: [],
      imageDescription: "顶层公寓里，他走向沙发。",
      shotType: "近景",
      characters: [],
      scene: "顶层公寓",
      emotion: "压抑",
      prompt: "[画面细节] 顶层公寓里，他走向沙发。\n[台词/旁白] 旁白：“He stepped into the hallway.”"
    }
  ],
  notes: []
}, "【分镜单元 1】Adam stood in the penthouse apartment.\n【分镜单元 2】He stepped into the hallway.", {
  logline: "Adam离开房间。",
  characters: [],
  scenes: [
    { name: "顶层公寓", location: "penthouse apartment", mood: "压抑", visualAnchor: "sofa" }
  ],
  keyEvents: [],
  emotionalRhythm: [],
  continuityNotes: []
});
assert.doesNotMatch(blockedInheritedSceneResult.shots[1].scene, /顶层公寓/);
assert.doesNotMatch(blockedInheritedSceneResult.shots[1].imageDescription, /顶层公寓|沙发/);
assert.match(blockedInheritedSceneResult.shots[1].imageDescription, /走廊|hallway/i);

const unsupportedCharacterResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "Adam looked at the silver necklace and went silent.",
      anchorSentence: "Adam looked at the silver necklace and went silent.",
      narration: "Adam looked at the silver necklace and went silent.",
      dialogueLines: [],
      imageDescription: "Adam看着银色项链沉默，Vivian站在他身边露出冷笑。",
      shotType: "双人近景",
      characters: ["Adam", "Vivian"],
      scene: "未明确场景",
      emotion: "震惊",
      prompt: "[画面细节] Adam看着银色项链沉默，Vivian站在他身边露出冷笑。\n[台词/旁白] 旁白：“Adam looked at the silver necklace and went silent.”"
    }
  ],
  notes: []
}, "【分镜单元 1】Adam looked at the silver necklace and went silent.", {
  logline: "项链让Adam沉默。",
  characters: [
    { name: "Adam", role: "fiance", appearance: "blond", costume: "suit", continuityNote: "guilty" },
    { name: "Vivian", role: "sister", appearance: "fragile", costume: "dress", continuityNote: "deceptive" }
  ],
  scenes: [],
  keyEvents: [],
  emotionalRhythm: [],
  continuityNotes: []
});
assert.deepEqual(unsupportedCharacterResult.shots[0].characters, ["Adam"]);
assert.doesNotMatch(unsupportedCharacterResult.shots[0].imageDescription, /Vivian|冷笑/);
assert.doesNotMatch(unsupportedCharacterResult.shots[0].prompt.split("[台词/旁白]")[0], /Vivian|冷笑/);
assert.doesNotMatch(unsupportedCharacterResult.shots[0].prompt, /可靠性修复镜头/);
assert.match(unsupportedCharacterResult.shots[0].prompt, /视觉局部修复/);

const futureCharacterLeakResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "The stone door opened without warning.",
      anchorSentence: "The stone door opened without warning.",
      narration: "The stone door opened without warning.",
      dialogueLines: [],
      imageDescription: "Adam站在石门前，抬头看向突然打开的门缝。",
      shotType: "中景",
      characters: ["Adam"],
      scene: "未明确场景",
      emotion: "紧张",
      prompt: "[画面细节] Adam站在石门前，抬头看向突然打开的门缝。\n[台词/旁白] 旁白：“The stone door opened without warning.”"
    }
  ],
  notes: []
}, "【分镜单元 1】The stone door opened without warning.\n【分镜单元 2】Adam entered the Summoning Hall.");
assert.deepEqual(futureCharacterLeakResult.shots[0].characters, []);
assert.doesNotMatch(futureCharacterLeakResult.shots[0].imageDescription, /Adam/);
assert.doesNotMatch(futureCharacterLeakResult.shots[0].prompt.split("[台词/旁白]")[0], /Adam/);

const reliableRepairDialogueVisualResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "\"You had a chance to rise above your station. You chose to throw it away.\" The noble students began to snicker.",
      anchorSentence: "The noble students began to snicker.",
      narration: "The noble students began to snicker.",
      dialogueLines: [
        { speaker: "Elena", delivery: "平静+清晰发声", text: "You had a chance to rise above your station. You chose to throw it away." }
      ],
      imageDescription: "前世记忆画面中，画面主体承接上一镜头的动作和情绪，身体朝向当前叙事重点，手部、视线与关键道具的关系保持清楚。",
      shotType: "中景",
      characters: ["Elena"],
      scene: "Fate Written in Bloodline",
      emotion: "嘲讽",
      prompt: [
        "[00:00-00:04s]",
        "[镜头语法 / 客观视角 / 中景 / 50mm / 中等景深，焦点锁定主体动作，背景轻微虚化 // 稳定推进]",
        "[画面细节] 前世记忆画面中，画面主体承接上一镜头的动作和情绪，身体朝向当前叙事重点，手部、视线与关键道具的关系保持清楚。",
        "[摄影机补充状态] 稳定机位，50mm 中等景深沿着画面主体的动作方向轻微推进。",
        "[声音设计] 环境声低铺，跟随旁白节奏。",
        "[台词/旁白] Elena（平静+清晰发声）：“You had a chance to rise above your station. You chose to throw it away.”；【停顿0.8s】；旁白：“The noble students began to snicker.”",
        "[导演批注] 可靠性修复镜头。"
      ].join("\n")
    }
  ],
  notes: []
}, "【分镜单元 1】\"You had a chance to rise above your station. You chose to throw it away.\" The noble students began to snicker.");
const repairedDialogueVisual = reliableRepairDialogueVisualResult.shots[0].prompt.split("[台词/旁白]")[0];
assert.doesNotMatch(repairedDialogueVisual, /画面主体|当前叙事重点|关键道具|空间入口/);
assert.match(repairedDialogueVisual, /Elena/);
assert.match(repairedDialogueVisual, /贵族学生|noble students/i);
assert.match(repairedDialogueVisual, /嘴角|眼部|眉|视线|微表情|snicker|窃笑/i);
assert.match(repairedDialogueVisual, /前景|背景|氛围|大厅|Summoning Hall|环境/i);
assert.match(repairedDialogueVisual, /保持人物面部清晰，自然柔和瞳孔聚焦/);
assert.match(reliableRepairDialogueVisualResult.shots[0].prompt, /\[导演批注\] 可靠性修复镜头/);

const unsupportedGenericCharacterResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "Adam looked at the silver necklace and went silent.",
      anchorSentence: "Adam looked at the silver necklace and went silent.",
      narration: "Adam looked at the silver necklace and went silent.",
      dialogueLines: [],
      imageDescription: "Adam看着银色项链沉默，一个女孩站在他身边露出冷笑。",
      shotType: "双人近景",
      characters: ["Adam", "Vivian"],
      scene: "未明确场景",
      emotion: "震惊",
      prompt: "[画面细节] Adam看着银色项链沉默，一个女孩站在他身边露出冷笑。\n[台词/旁白] 旁白：“Adam looked at the silver necklace and went silent.”"
    }
  ],
  notes: []
}, "【分镜单元 1】Adam looked at the silver necklace and went silent.");
assert.deepEqual(unsupportedGenericCharacterResult.shots[0].characters, ["Adam"]);
assert.doesNotMatch(unsupportedGenericCharacterResult.shots[0].imageDescription, /女孩|身边|冷笑/);
assert.doesNotMatch(unsupportedGenericCharacterResult.shots[0].prompt.split("[台词/旁白]")[0], /女孩|身边|冷笑/);
assert.doesNotMatch(unsupportedGenericCharacterResult.shots[0].prompt, /可靠性修复镜头/);
assert.match(unsupportedGenericCharacterResult.shots[0].prompt, /视觉局部修复/);

const unsupportedStrangerCharacterResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "Adam looked at the silver necklace and went silent.",
      anchorSentence: "Adam looked at the silver necklace and went silent.",
      narration: "Adam looked at the silver necklace and went silent.",
      dialogueLines: [],
      imageDescription: "Adam看着银色项链沉默，一个陌生人站在旁边观察。",
      shotType: "双人近景",
      characters: ["Adam"],
      scene: "未明确场景",
      emotion: "震惊",
      prompt: "[画面细节] Adam看着银色项链沉默，一个陌生人站在旁边观察。\n[台词/旁白] 旁白：“Adam looked at the silver necklace and went silent.”"
    }
  ],
  notes: []
}, "【分镜单元 1】Adam looked at the silver necklace and went silent.");
assert.deepEqual(unsupportedStrangerCharacterResult.shots[0].characters, ["Adam"]);
assert.doesNotMatch(unsupportedStrangerCharacterResult.shots[0].imageDescription, /陌生人|旁边|观察/);
assert.doesNotMatch(unsupportedStrangerCharacterResult.shots[0].prompt.split("[台词/旁白]")[0], /陌生人|旁边|观察/);
assert.doesNotMatch(unsupportedStrangerCharacterResult.shots[0].prompt, /可靠性修复镜头/);

const unsupportedEnglishGenericPersonResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "Adam looked at the silver necklace and went silent.",
      anchorSentence: "Adam looked at the silver necklace and went silent.",
      narration: "Adam looked at the silver necklace and went silent.",
      dialogueLines: [],
      imageDescription: "Adam stared at the silver necklace while someone stood beside him and watched.",
      shotType: "two-person close-up",
      characters: ["Adam"],
      scene: "未明确场景",
      emotion: "震惊",
      prompt: "[画面细节] Adam stared at the silver necklace while someone stood beside him and watched.\n[台词/旁白] 旁白：“Adam looked at the silver necklace and went silent.”"
    }
  ],
  notes: []
}, "【分镜单元 1】Adam looked at the silver necklace and went silent.");
assert.deepEqual(unsupportedEnglishGenericPersonResult.shots[0].characters, ["Adam"]);
assert.doesNotMatch(unsupportedEnglishGenericPersonResult.shots[0].imageDescription, /someone|beside him|watched/i);
assert.doesNotMatch(unsupportedEnglishGenericPersonResult.shots[0].prompt.split("[台词/旁白]")[0], /someone|beside him|watched/i);
assert.doesNotMatch(unsupportedEnglishGenericPersonResult.shots[0].prompt, /可靠性修复镜头/);
assert.match(unsupportedEnglishGenericPersonResult.shots[0].prompt, /视觉局部修复/);

const visualOnlyGenericCharacterResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "Adam looked at the silver necklace and went silent.",
      anchorSentence: "Adam looked at the silver necklace and went silent.",
      narration: "Adam looked at the silver necklace and went silent.",
      dialogueLines: [],
      imageDescription: "Adam看着银色项链沉默，一个医生在旁边记录。",
      shotType: "近景",
      characters: ["Adam"],
      scene: "未明确场景",
      emotion: "震惊",
      prompt: "[画面细节] Adam看着银色项链沉默，一个医生在旁边记录。\n[台词/旁白] 旁白：“Adam looked at the silver necklace and went silent.”"
    }
  ],
  notes: []
}, "【分镜单元 1】Adam looked at the silver necklace and went silent.");
assert.deepEqual(visualOnlyGenericCharacterResult.shots[0].characters, ["Adam"]);
assert.doesNotMatch(visualOnlyGenericCharacterResult.shots[0].imageDescription, /医生|旁边|记录/);
assert.doesNotMatch(visualOnlyGenericCharacterResult.shots[0].prompt.split("[台词/旁白]")[0], /医生|旁边|记录/);
assert.doesNotMatch(visualOnlyGenericCharacterResult.shots[0].prompt, /可靠性修复镜头/);
assert.match(visualOnlyGenericCharacterResult.shots[0].prompt, /视觉局部修复/);

const visualOnlyChineseNameResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "林昭看着桌上的银色项链，久久没有说话。",
      anchorSentence: "林昭看着桌上的银色项链，久久没有说话。",
      narration: "林昭看着桌上的银色项链，久久没有说话。",
      dialogueLines: [],
      imageDescription: "林昭看着银色项链沉默，王强站在旁边冷笑。",
      shotType: "双人近景",
      characters: ["林昭"],
      scene: "未明确场景",
      emotion: "压抑",
      prompt: "[画面细节] 林昭看着银色项链沉默，王强站在旁边冷笑。\n[台词/旁白] 旁白：“林昭看着桌上的银色项链，久久没有说话。”"
    }
  ],
  notes: []
}, "【分镜单元 1】林昭看着桌上的银色项链，久久没有说话。");
assert.deepEqual(visualOnlyChineseNameResult.shots[0].characters, ["林昭"]);
assert.doesNotMatch(visualOnlyChineseNameResult.shots[0].imageDescription, /王强|冷笑/);
assert.doesNotMatch(visualOnlyChineseNameResult.shots[0].prompt.split("[台词/旁白]")[0], /王强|冷笑/);
assert.doesNotMatch(visualOnlyChineseNameResult.shots[0].prompt, /可靠性修复镜头/);

const repeatedConservativePromptResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "AI sister has perfectly replaced me",
      anchorSentence: "AI sister has perfectly replaced me",
      narration: "AI sister has perfectly replaced me",
      dialogueLines: [],
      imageDescription: "AI sister坐在餐桌旁，一个医生在旁边记录。",
      shotType: "中景",
      characters: ["AI sister"],
      scene: "未明确场景",
      emotion: "失落",
      prompt: [
        "[00:00-00:04s]",
        "[镜头语法 / 客观视角 / 中景 / 35mm / 稳定焦点 // 稳定]",
        "[画面细节] AI sister坐在餐桌旁，一个医生在旁边记录。",
        "[摄影机补充状态] 稳定机位。",
        "[声音设计] 低频环境声。",
        "[台词/旁白] 旁白：“AI sister has perfectly replaced me”",
        "[导演批注] 表现被替代的落差。"
      ].join("\n")
    }
  ],
  notes: []
}, "【分镜单元 1】AI sister has perfectly replaced me");
assert.match(repeatedConservativePromptResult.shots[0].prompt, /\[镜头语法/);
assert.match(repeatedConservativePromptResult.shots[0].prompt, /\[摄影机补充状态\]/);
assert.match(repeatedConservativePromptResult.shots[0].prompt, /\[声音设计\]/);
assert.match(repeatedConservativePromptResult.shots[0].prompt, /\[导演批注\]/);
assert.doesNotMatch(repeatedConservativePromptResult.shots[0].prompt, /基于原文的保守人物画面/);
assert.doesNotMatch(repeatedConservativePromptResult.shots[0].prompt.split("[台词/旁白]")[0], /医生|旁边|记录/);
assert.doesNotMatch(repeatedConservativePromptResult.shots[0].prompt, /可靠性修复镜头/);
assert.match(repeatedConservativePromptResult.shots[0].prompt, /视觉局部修复/);

const emptySceneUsefulVisualResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "Adam looked at the silver necklace and went silent.",
      anchorSentence: "Adam looked at the silver necklace and went silent.",
      narration: "Adam looked at the silver necklace and went silent.",
      dialogueLines: [],
      imageDescription: "Adam低头看着掌心里的银色项链，肩膀僵住，侧上方柔和主光落在项链边缘。",
      shotType: "近景",
      characters: ["Adam"],
      scene: "",
      emotion: "震惊",
      prompt: [
        "[00:00-00:04s]",
        "[镜头语法 / 客观视角 / 近景 / 35mm / 稳定焦点 // 稳定]",
        "[画面细节] Adam低头看着掌心里的银色项链，肩膀僵住，侧上方柔和主光落在项链边缘。",
        "[摄影机补充状态] 稳定近景，焦点停在Adam的手部和项链之间。",
        "[声音设计] 环境声压低。",
        "[台词/旁白] 旁白：“Adam looked at the silver necklace and went silent.”",
        "[导演批注] 用沉默反应承接项链带来的冲击。"
      ].join("\n")
    }
  ],
  notes: []
}, "【分镜单元 1】Adam looked at the silver necklace and went silent.");
assert.doesNotMatch(emptySceneUsefulVisualResult.shots[0].prompt, /可靠性修复镜头|视觉局部修复/);

const blankBackgroundUnknownSceneResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "Adam looked at the silver necklace and went silent.",
      anchorSentence: "Adam looked at the silver necklace and went silent.",
      narration: "Adam looked at the silver necklace and went silent.",
      dialogueLines: [],
      imageDescription: "空白背景中，Adam看着银色项链沉默。",
      shotType: "近景",
      characters: ["Adam"],
      scene: "未明确场景",
      emotion: "震惊",
      prompt: "[画面细节] 空白背景中，Adam看着银色项链沉默。\n[台词/旁白] 旁白：“Adam looked at the silver necklace and went silent.”"
    }
  ],
  notes: []
}, "【分镜单元 1】Adam looked at the silver necklace and went silent.");
assert.match(blankBackgroundUnknownSceneResult.shots[0].prompt, /可靠性修复镜头/);
assert.doesNotMatch(blankBackgroundUnknownSceneResult.shots[0].prompt.split("[台词/旁白]")[0], /空白背景/);

const completeLegacyVisualResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "I raised my hand toward the open vault.",
      anchorSentence: "I raised my hand toward the open vault.",
      narration: "I raised my hand toward the open vault.",
      dialogueLines: [],
      imageDescription: "Royal Vault里前景保留厚重门框，中景落在第一人称主角抬手朝向开启宝库的动作，背景封印架和藏品轮廓轻微虚化，侧上方冷白主光压住门框阴影，第一人称主角身体朝向开启宝库，手部动作、站位距离和视线关系保持清楚。",
      shotType: "中景",
      characters: ["第一人称主角"],
      scene: "Royal Vault",
      emotion: "冷静",
      prompt: [
        "[00:00-00:04s]",
        "[镜头语法 / 客观视角 / 中景 / 50mm / 稳定焦点 // 稳定推进]",
        "[画面细节] Royal Vault里前景保留厚重门框，中景落在第一人称主角抬手朝向开启宝库的动作，背景封印架和藏品轮廓轻微虚化，侧上方冷白主光压住门框阴影，第一人称主角身体朝向开启宝库，手部动作、站位距离和视线关系保持清楚。",
        "[摄影机补充状态] 稳定机位。",
        "[声音设计] 环境声低铺。",
        "[台词/旁白] 旁白：“I raised my hand toward the open vault.”",
        "[导演批注] 测试旧描述已经完整时的追加式补全。"
      ].join("\n")
    }
  ],
  notes: []
}, "【分镜单元 1】I raised my hand toward the open vault.");
const completeLegacyVisual = completeLegacyVisualResult.shots[0].imageDescription;
assert.equal((completeLegacyVisual.match(/前景/g) ?? []).length, 1);
assert.equal((completeLegacyVisual.match(/中景/g) ?? []).length, 1);
assert.equal((completeLegacyVisual.match(/背景/g) ?? []).length, 1);
assert.equal((completeLegacyVisual.match(/身体朝向/g) ?? []).length, 1);
assert.equal((completeLegacyVisual.match(/手部动作/g) ?? []).length, 1);
assert.doesNotMatch(completeLegacyVisual, /背景保持可读空间层次/);

const missingLightOnlyVisualResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "林昭停在楼道门口，抬手握住门把。",
      anchorSentence: "林昭停在楼道门口，抬手握住门把。",
      narration: "林昭停在楼道门口，抬手握住门把。",
      dialogueLines: [],
      imageDescription: "楼道里前景保留门框边缘，中景落在林昭抬手握住门把的动作，背景走廊深处轻微虚化，林昭身体朝向门内，手部动作、站位距离和视线关系保持清楚。",
      shotType: "中景",
      characters: ["林昭"],
      scene: "楼道",
      emotion: "紧张",
      prompt: [
        "[00:00-00:04s]",
        "[镜头语法 / 客观视角 / 中景 / 35mm / 稳定焦点 // 稳定]",
        "[画面细节] 楼道里前景保留门框边缘，中景落在林昭抬手握住门把的动作，背景走廊深处轻微虚化，林昭身体朝向门内，手部动作、站位距离和视线关系保持清楚。",
        "[摄影机补充状态] 稳定机位。",
        "[声音设计] 环境声低铺。",
        "[台词/旁白] 旁白：“林昭停在楼道门口，抬手握住门把。”",
        "[导演批注] 测试缺少光源时只补光。"
      ].join("\n")
    }
  ],
  notes: []
}, "【分镜单元 1】林昭停在楼道门口，抬手握住门把。");
const missingLightOnlyVisual = missingLightOnlyVisualResult.shots[0].imageDescription;
assert.match(missingLightOnlyVisual, /林昭抬手握住门把的动作/);
assert.match(missingLightOnlyVisual, /主光|顶灯|冷白光|侧上方|阴影/);
assert.equal((missingLightOnlyVisual.match(/前景/g) ?? []).length, 1);
assert.equal((missingLightOnlyVisual.match(/身体朝向/g) ?? []).length, 1);

const missingSpatialOnlyVisualResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "Adam lowered his head and looked at the silver necklace.",
      anchorSentence: "Adam lowered his head and looked at the silver necklace.",
      narration: "Adam lowered his head and looked at the silver necklace.",
      dialogueLines: [],
      imageDescription: "Adam低头看着掌心里的银色项链，肩膀僵住，侧上方柔和主光落在项链边缘，Adam身体朝向掌心目标物，手部动作、站位距离和视线关系保持清楚。",
      shotType: "中景",
      characters: ["Adam"],
      scene: "室内",
      emotion: "震惊",
      prompt: [
        "[00:00-00:04s]",
        "[镜头语法 / 客观视角 / 中景 / 50mm / 稳定焦点 // 稳定]",
        "[画面细节] Adam低头看着掌心里的银色项链，肩膀僵住，侧上方柔和主光落在项链边缘，Adam身体朝向掌心目标物，手部动作、站位距离和视线关系保持清楚。",
        "[摄影机补充状态] 稳定机位。",
        "[声音设计] 环境声低铺。",
        "[台词/旁白] 旁白：“Adam lowered his head and looked at the silver necklace.”",
        "[导演批注] 测试缺少空间层次时只补空间。"
      ].join("\n")
    }
  ],
  notes: []
}, "【分镜单元 1】Adam lowered his head and looked at the silver necklace.");
const missingSpatialOnlyVisual = missingSpatialOnlyVisualResult.shots[0].imageDescription;
assert.match(missingSpatialOnlyVisual, /前景|中景|背景|空间层次|纵深/);
assert.equal((missingSpatialOnlyVisual.match(/主光/g) ?? []).length, 1);
assert.equal((missingSpatialOnlyVisual.match(/身体朝向/g) ?? []).length, 1);
assert.match(missingSpatialOnlyVisual, /Adam低头看着掌心里的银色项链/);

const sourceSupportedGenericCharacterResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "In the emergency room, the doctors were trying to save me.",
      anchorSentence: "In the emergency room, the doctors were trying to save me.",
      narration: "In the emergency room, the doctors were trying to save me.",
      dialogueLines: [],
      imageDescription: "急救室里，医生围在手术台旁尝试救治。",
      shotType: "中景",
      characters: [],
      scene: "急救室",
      emotion: "紧张",
      prompt: "[画面细节] 急救室里，医生围在手术台旁尝试救治。\n[台词/旁白] 旁白：“In the emergency room, the doctors were trying to save me.”"
    }
  ],
  notes: []
}, "【分镜单元 1】In the emergency room, the doctors were trying to save me.", {
  logline: "急救室抢救。",
  characters: [],
  scenes: [
    { name: "急救室", location: "emergency room", mood: "紧张", visualAnchor: "doctors" }
  ],
  keyEvents: [],
  emotionalRhythm: [],
  continuityNotes: []
});
assert.match(sourceSupportedGenericCharacterResult.shots[0].imageDescription, /医生/);
assert.match(sourceSupportedGenericCharacterResult.shots[0].prompt.split("[台词/旁白]")[0], /医生/);

const dialogueSpeakerCharacterResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "\"I know,\" Adam whispered.",
      anchorSentence: "\"I know,\" Adam whispered.",
      narration: "Adam whispered.",
      dialogueLines: [
        { speaker: "Adam", delivery: "低声", text: "I know," }
      ],
      imageDescription: "Adam低声开口。",
      shotType: "近景",
      characters: [],
      scene: "未明确场景",
      emotion: "压抑",
      prompt: "[画面细节] Adam低声开口。\n[台词/旁白] Adam（低声）：“I know,”"
    }
  ],
  notes: []
}, "【分镜单元 1】\"I know,\" Adam whispered.");
assert.deepEqual(dialogueSpeakerCharacterResult.shots[0].characters, ["Adam"]);

const pauseSpeechQualityResult = __test__.qualityCheckStoryboardChunkResult({
  shots: [
    {
      sourceText: "林昭停下脚步。他说别回头。",
      anchorSentence: "他说别回头。",
      narration: "林昭停下脚步。",
      dialogueLines: [
        { speaker: "周远", delivery: "紧张+低声", text: "别回头。" }
      ],
      imageDescription: "林昭停下脚步，周远低声提醒。",
      shotType: "中景",
      characters: ["周远", "林昭"],
      scene: "楼道",
      emotion: "紧张",
      prompt: "[00:00-00:04s]\n[镜头语法 / 客观视角 / 中景 / 35mm / 稳定焦点 // 稳定]\n[画面细节] 林昭停下脚步，周远低声提醒。\n[摄影机补充状态] 稳定机位。\n[声音设计] 环境声。\n[台词/旁白] 旁白：“林昭停下脚步。”；【停顿0.4s】；周远（紧张+低声）：“别回头。”\n[导演批注] 表现紧张提醒。"
    }
  ],
  notes: []
}, "【分镜单元 1】林昭停下脚步。他说别回头。");
assert.ok(pauseSpeechQualityResult.qualityReport.every((issue) => issue.code !== "speech_line_mismatch"));

const attributedDialogueResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "\"Arthur, form a Pact with it,\" Elena said.",
      anchorSentence: "\"Arthur, form a Pact with it,\" Elena said.",
      narration: "Elena said.",
      dialogueLines: [
        { speaker: "Elena", delivery: "急切+压低声音", text: "Arthur, form a Pact with it," }
      ],
      imageDescription: "Elena看向Arthur，催促他完成契约。",
      shotType: "近景",
      characters: ["Elena", "Arthur"],
      scene: "室内",
      emotion: "急切",
      prompt: "[画面细节] Elena看向Arthur，催促他完成契约。\n[台词/旁白] Elena（急切+压低声音）：“Arthur, form a Pact with it,”；旁白：“Elena said.”"
    },
    {
      sourceText: "\"This is your moment.\"",
      anchorSentence: "\"This is your moment.\"",
      narration: "无",
      dialogueLines: [
        { speaker: "未指明说话者", delivery: "急切+压低声音", text: "This is your moment." }
      ],
      imageDescription: "Elena继续看着Arthur。",
      shotType: "近景",
      characters: ["Elena", "Arthur"],
      scene: "室内",
      emotion: "鼓励",
      prompt: "[画面细节] Elena继续看着Arthur。\n[台词/旁白] 未指明说话者（急切+压低声音）：“This is your moment.”"
    }
  ],
  notes: []
}, "【分镜单元 1】\"Arthur, form a Pact with it,\" Elena said.\n【分镜单元 2】\"This is your moment.\"");
assert.match(attributedDialogueResult.shots[0].prompt, /Elena（急切\+压低声音）：“Arthur, form a Pact with it,”；【停顿0\.8s】；旁白：“Elena said\.”/);
assert.equal(attributedDialogueResult.shots[0].dialogueLines[0].speaker, "Elena");
assert.equal(attributedDialogueResult.shots[0].narration, "Elena said.");
assert.match(attributedDialogueResult.shots[1].prompt, /Elena（急切\+压低声音）：“This is your moment\.”/);
assert.equal(attributedDialogueResult.shots[1].dialogueLines[0].speaker, "Elena");
const attributedDialogueQuality = __test__.qualityCheckStoryboardChunkResult(attributedDialogueResult, "【分镜单元 1】\"Arthur, form a Pact with it,\" Elena said.\n【分镜单元 2】\"This is your moment.\"");
assert.ok(attributedDialogueQuality.qualityReport.every((issue) => issue.code !== "speech_line_mismatch"));

const surroundingNarrationDialogueShot = __test__.normalizeShotTextFields({
  sourceText: "I froze when Elena leaned close and whispered, \"Arthur, form a Pact with it,\" before the hall went silent.",
  anchorSentence: "I froze when Elena leaned close and whispered, \"Arthur, form a Pact with it,\" before the hall went silent.",
  narration: "I froze when Elena leaned close and whispered, before the hall went silent.",
  dialogueLines: [
    { speaker: "Elena", delivery: "急切+压低声音", text: "Arthur, form a Pact with it," }
  ],
  imageDescription: "Elena靠近Arthur低声催促，周围大厅陷入安静。",
  shotType: "近景",
  characters: ["Elena", "Arthur"],
  scene: "大厅",
  emotion: "紧张",
  prompt: "[画面细节] Elena靠近Arthur低声催促。\n[台词/旁白] Elena（急切+压低声音）：“Arthur, form a Pact with it,”"
}, "【分镜单元 1】I froze when Elena leaned close and whispered, \"Arthur, form a Pact with it,\" before the hall went silent.");
assert.match(
  surroundingNarrationDialogueShot.prompt,
  /旁白：“I froze when Elena leaned close and whispered,”；【停顿0\.4s】；Elena（急切\+压低声音）：“Arthur, form a Pact with it,”；【停顿0\.8s】；旁白：“before the hall went silent\.”/
);
assert.equal(surroundingNarrationDialogueShot.narration, "I froze when Elena leaned close and whispered, before the hall went silent.");
assert.deepEqual(surroundingNarrationDialogueShot.dialogueLines, [
  { speaker: "Elena", delivery: "急切+压低声音", text: "Arthur, form a Pact with it," }
]);

const doubleQuotedDialogueWithAttributionShot = __test__.normalizeShotTextFields({
  sourceText: "\"Run,\" Elena said, \"hide,\" before the door opened.",
  anchorSentence: "\"Run,\" Elena said, \"hide,\" before the door opened.",
  narration: "Elena said, before the door opened.",
  dialogueLines: [
    { speaker: "Elena", delivery: "急促+低声", text: "Run," },
    { speaker: "Elena", delivery: "急促+低声", text: "hide," }
  ],
  imageDescription: "Elena压低声音连续提醒，门即将打开。",
  shotType: "近景",
  characters: ["Elena"],
  scene: "门前",
  emotion: "紧张",
  prompt: "[画面细节] Elena压低声音连续提醒。\n[台词/旁白] Elena（急促+低声）：“Run,”；Elena（急促+低声）：“hide,”；旁白：“Elena said, before the door opened.”"
}, "【分镜单元 1】\"Run,\" Elena said, \"hide,\" before the door opened.");
assert.match(
  doubleQuotedDialogueWithAttributionShot.prompt,
  /Elena（急促\+低声）：“Run,”；【停顿0\.8s】；旁白：“Elena said,”；【停顿0\.4s】；Elena（急促\+低声）：“hide,”；【停顿0\.8s】；旁白：“before the door opened\.”/
);
assert.deepEqual(doubleQuotedDialogueWithAttributionShot.dialogueLines, [
  { speaker: "Elena", delivery: "急促+低声", text: "Run," },
  { speaker: "Elena", delivery: "急促+低声", text: "hide," }
]);
assert.doesNotMatch(doubleQuotedDialogueWithAttributionShot.prompt, /旁白：“hide,”/);

const orderedPauseSpeechQualityResult = __test__.qualityCheckStoryboardChunkResult({
  shots: [
    {
      sourceText: "I froze when Elena leaned close and whispered, \"Arthur, form a Pact with it,\" before the hall went silent.",
      anchorSentence: "I froze when Elena leaned close and whispered, \"Arthur, form a Pact with it,\" before the hall went silent.",
      narration: "I froze when Elena leaned close and whispered, before the hall went silent.",
      dialogueLines: [
        { speaker: "Elena", delivery: "急切+压低声音", text: "Arthur, form a Pact with it," }
      ],
      imageDescription: "Elena靠近Arthur低声催促，周围大厅陷入安静。",
      shotType: "近景",
      characters: ["Elena", "Arthur"],
      scene: "大厅",
      emotion: "紧张",
      prompt: "[00:00-00:04s]\n[镜头语法 / 客观视角 / 近景 / 50mm / 稳定焦点 // 稳定推进]\n[画面细节] Elena靠近Arthur低声催促，Arthur屏住呼吸，侧上方冷光压住大厅背景。\n[摄影机补充状态] 稳定机位，焦点锁定Elena靠近Arthur的动作。\n[声音设计] 环境声压低，停顿后大厅安静。\n[台词/旁白] 旁白：“I froze when Elena leaned close and whispered,”；【停顿0.4s】；Elena（急切+压低声音）：“Arthur, form a Pact with it,”；【停顿0.8s】；旁白：“before the hall went silent.”\n[导演批注] 通过先旁白、对白、后旁白保持原文阅读顺序。"
    }
  ],
  notes: []
}, "【分镜单元 1】I froze when Elena leaned close and whispered, \"Arthur, form a Pact with it,\" before the hall went silent.");
assert.ok(orderedPauseSpeechQualityResult.qualityReport.every((issue) => issue.code !== "speech_line_mismatch"));

const firstPersonNarratorDoesNotFallbackToFirstAnalysisCharacter = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "\"Eat whatever you can use,\" I said.",
      anchorSentence: "\"Eat whatever you can use,\" I said.",
      narration: "I said.",
      dialogueLines: [
        { speaker: "Victoria", delivery: "冷静+命令式低声", text: "Eat whatever you can use," }
      ],
      imageDescription: "Victoria低声命令。",
      shotType: "中景",
      characters: ["Victoria"],
      scene: "当前连续场景",
      emotion: "冷静",
      prompt: "[画面细节] Victoria低声命令。\n[台词/旁白] Victoria（冷静+命令式低声）：“Eat whatever you can use,”；【停顿0.8s】；旁白：“I said.”"
    }
  ],
  notes: []
}, "【分镜单元 1】\"Eat whatever you can use,\" I said.", {
  logline: "Victoria watches the protagonist command Rage.",
  characters: [
    { name: "Victoria", role: "未在原文证实", appearance: "未在原文证实", costume: "未在原文证实", continuityNote: "observes the vault", evidence: [{ quote: "Victoria said", chunkIndex: 0, field: "name" }] },
    { name: "Arthur Pendragon", role: "未在原文证实", appearance: "未在原文证实", costume: "未在原文证实", continuityNote: "protagonist", evidence: [{ quote: "Arthur Pendragon", chunkIndex: 0, field: "name" }] }
  ],
  scenes: [],
  keyEvents: [],
  emotionalRhythm: [],
  continuityNotes: []
});
assert.equal(firstPersonNarratorDoesNotFallbackToFirstAnalysisCharacter.shots[0].dialogueLines[0].speaker, "第一人称主角");
assert.match(firstPersonNarratorDoesNotFallbackToFirstAnalysisCharacter.shots[0].prompt, /第一人称主角（冷静\+命令式低声）：“Eat whatever you can use,”/);
assert.doesNotMatch(firstPersonNarratorDoesNotFallbackToFirstAnalysisCharacter.shots[0].prompt, /Victoria（冷静\+命令式低声）：“Eat whatever you can use,”/);

const generatedChineseVisualFragmentsAreNotNameClaims = __test__.assessShotReliability({
  sourceText: "\"Eat whatever you can use,\" I said.",
  anchorSentence: "\"Eat whatever you can use,\" I said.",
  narration: "I said.",
  dialogueLines: [
    { speaker: "第一人称主角", delivery: "冷静+命令式低声", text: "Eat whatever you can use," }
  ],
  imageDescription: "Royal Vault中，第一人称主角说出对白时站在画面中景，肩颈保持克制，嘴角压低，眼部平稳盯向对方，背景人物保持短暂停顿或低声反应，环境压力通过视线方向和站位距离呈现。",
  shotType: "中景",
  characters: ["第一人称主角"],
  scene: "Royal Vault",
  emotion: "冷静",
  prompt: "[00:00-00:04s]\n[镜头语法 / 客观视角 / 中景 / 50mm / 中等景深，焦点锁定主体动作，背景轻微虚化 // 稳定推进]\n[画面细节] Royal Vault中，第一人称主角说出对白时站在画面中景，肩颈保持克制，嘴角压低，眼部平稳盯向对方，背景人物保持短暂停顿或低声反应，环境压力通过视线方向和站位距离呈现。\n[摄影机补充状态] 稳定机位，50mm 中等景深沿着第一人称主角的动作方向轻微推进，焦点锁定第一人称主角的动作和面部反应，背景轻微虚化以保持空间连续。\n[声音设计] 环境声低铺，跟随旁白节奏。\n[台词/旁白] 第一人称主角（冷静+命令式低声）：“Eat whatever you can use,”；【停顿0.8s】；旁白：“I said.”\n[导演批注] 测试镜头。"
}, {
  unitText: "\"Eat whatever you can use,\" I said.",
  previousUnitText: "Rage appeared in the front hall.",
  nextUnitText: "It didn’t hesitate."
});
assert.ok(generatedChineseVisualFragmentsAreNotNameClaims.issues.every((issue) => issue.code !== "shot_visual_named_claim_unreliable"));

const vaultFallbackRegressionChunk = [
  "【分镜单元 1】The Royal Vault of the Augustine Empire lay beneath the Imperial Capital,",
  "【分镜单元 2】protected by multiple layers of barriers and guarded by three seven-star mages.",
  "【分镜单元 3】When the massive doors opened, dense mana surged outward like the heat of a furnace.",
  "【分镜单元 4】\"Take what you need,\" Victoria said.",
  "【分镜单元 5】\"In one month, the Beastmaster Grand Tournament begins. I want you to win on the Holy See’s home ground.\" Inside the vault were high-tier Core Crystals, ancient remains, sealed Divine Matter,",
  "【分镜单元 6】\"Eat whatever you can use,\" I said.",
  "【分镜单元 7】[Consumed: Seven-star Titan Behemoth heart. Earth Elemental Affinity acquired. Defense increased]",
  "【分镜单元 8】\"Not this one.\" She looked at me."
].join("\n");
const vaultFallbackRegressionResult = __test__.repairStoryboardChunkResult({
  shots: [],
  notes: []
}, vaultFallbackRegressionChunk);
const vaultFallbackVisualJson = JSON.stringify(vaultFallbackRegressionResult.shots.map((shot) => ({
  characters: shot.characters,
  scene: shot.scene,
  imageDescription: shot.imageDescription,
  promptVisual: shot.prompt.split("[台词/旁白]")[0],
  dialogueLines: shot.dialogueLines
})));
const forbiddenVisualPlaceholderTerms = /画面主体|镜头视觉中心|当前叙事重点|关键道具|当前连续场景|画面叙事焦点|目标物|周围道具/;
assert.doesNotMatch(vaultFallbackVisualJson, /\b(?:Royal|Vault|Take|Eat|Consumed|Seven|Titan Behemoth|Earth Elemental|Not|Inside|Tournament|Holy See)\b(?:承接|说出|情绪|身体|站在|沿着)/);
assert.doesNotMatch(vaultFallbackVisualJson, /门口中|走廊顶灯|Take说出对白|Eat说出对白|Consumed情绪外露|Not说出对白/);
assert.doesNotMatch(vaultFallbackVisualJson, /画面主体|当前叙事重点|关键道具/);
assert.doesNotMatch(vaultFallbackVisualJson, /位于画面叙事焦点/);
assert.doesNotMatch(vaultFallbackVisualJson, forbiddenVisualPlaceholderTerms);
assert.match(vaultFallbackRegressionResult.shots[0].prompt, /Royal Vault|vault|宝库|地下宝库/i);
assert.match(vaultFallbackRegressionResult.shots[1].prompt, /barrier|mage|屏障|法师|宝库|vault/i);
assert.match(vaultFallbackRegressionResult.shots[3].prompt, /Victoria（/);
assert.doesNotMatch(vaultFallbackRegressionResult.shots[3].characters.join(" "), /\bTake\b/);
assert.equal(vaultFallbackRegressionResult.shots[3].dialogueLines[0].speaker, "Victoria");
assert.doesNotMatch(vaultFallbackRegressionResult.shots[4].characters.join(" "), /第一人称主角/);
assert.equal(vaultFallbackRegressionResult.shots[5].dialogueLines[0].speaker, "第一人称主角");
assert.doesNotMatch(vaultFallbackRegressionResult.shots[5].characters.join(" "), /\bEat\b|Victoria/);
assert.deepEqual(vaultFallbackRegressionResult.shots[6].characters, []);
assert.doesNotMatch(vaultFallbackRegressionResult.shots[6].prompt.split("[台词/旁白]")[0], /保持人物面部清晰|Consumed|Titan Behemoth(?:承接|身体|脸侧)/);
assert.doesNotMatch(vaultFallbackRegressionResult.shots[7].characters.join(" "), /\bNot\b/);

const ordinaryNoSubjectFallbackResult = __test__.repairStoryboardChunkResult({
  shots: [],
  notes: []
}, "【分镜单元 1】The air shifted, and the silence in the room grew heavier.");
const ordinaryNoSubjectShot = ordinaryNoSubjectFallbackResult.shots[0];
const ordinaryNoSubjectVisual = JSON.stringify({
  scene: ordinaryNoSubjectShot.scene,
  imageDescription: ordinaryNoSubjectShot.imageDescription,
  promptVisual: ordinaryNoSubjectShot.prompt.split("[台词/旁白]")[0]
});
assert.doesNotMatch(ordinaryNoSubjectVisual, /镜头视觉中心|当前画面重点/);
assert.doesNotMatch(ordinaryNoSubjectVisual, forbiddenVisualPlaceholderTerms);
assert.doesNotMatch(ordinaryNoSubjectVisual, /空间延续环境|空间结构|当前可见变化|可见物件/);
assert.match(ordinaryNoSubjectVisual, /环境气氛与人物关系变化|空间层次/);

const placeholderSpeechPreservedResult = __test__.repairStoryboardChunkResult({
  shots: [
    {
      sourceText: "The corridor became still.",
      anchorSentence: "The corridor became still.",
      narration: "The narrator said 镜头视觉中心 and 关键道具 in the draft.",
      dialogueLines: [],
      imageDescription: "画面主体承接当前连续场景，镜头视觉中心朝向目标物，关键道具与周围道具保持清楚。",
      shotType: "中景",
      characters: [],
      scene: "当前连续场景",
      emotion: "紧张",
      prompt: "[画面细节] 画面主体承接当前连续场景，镜头视觉中心朝向目标物，关键道具与周围道具保持清楚。\n[台词/旁白] 旁白：“The narrator said 镜头视觉中心 and 关键道具 in the draft.”"
    }
  ],
  notes: []
}, "【分镜单元 1】The narrator said 镜头视觉中心 and 关键道具 in the draft.");
const placeholderSpeechPreservedShot = placeholderSpeechPreservedResult.shots[0];
const placeholderSpeechVisual = JSON.stringify({
  scene: placeholderSpeechPreservedShot.scene,
  imageDescription: placeholderSpeechPreservedShot.imageDescription,
  promptVisual: placeholderSpeechPreservedShot.prompt.split("[台词/旁白]")[0]
});
assert.doesNotMatch(placeholderSpeechVisual, forbiddenVisualPlaceholderTerms);
assert.match(placeholderSpeechPreservedShot.prompt, /\[台词\/旁白\] 旁白：“The narrator said 镜头视觉中心 and 关键道具 in the draft\.”/);

const shoutedDialogueText = "“Shut up! Stop it! Stop!” I stared at her in horror. I grabbed the baseball bat from my desk, ready to smash the speaker that was blasting the recording.";
const shoutedDialogueSentences = splitSentences(shoutedDialogueText, "en");
assert.deepEqual(shoutedDialogueSentences, [
  "“Shut up! Stop it! Stop!” I stared at her in horror.",
  "I grabbed the baseball bat from my desk, ready to smash the speaker that was blasting the recording."
]);
const shoutedDialogueChunks = buildStoryboardChunks(shoutedDialogueText, "en", 0.4, "secondsPerWord");
const shoutedDialogueUnits = shoutedDialogueChunks.flatMap((chunk) =>
  chunk.split("\n").map((line) => line.replace(/【分镜单元\s*\d+】/, "").trim())
);
assert.ok(shoutedDialogueUnits.includes("“Shut up! Stop it! Stop!” I stared at her in horror."));
assert.ok(shoutedDialogueUnits.includes("I grabbed the baseball bat from my desk, ready to smash the speaker that was blasting the recording."));
assert.ok(shoutedDialogueUnits.every((unitText) => !/^Stop it!/.test(unitText)));
assert.ok(shoutedDialogueUnits.every((unitText) => !/^Stop!”/.test(unitText)));

const quotedCommaDialogueText = "\"Lucy, come downstairs.\" I heard my mother calling from the kitchen, her voice echoing through the silent hallway as I froze beside the door.";
const quotedCommaSentences = splitSentences(quotedCommaDialogueText, "en");
assert.ok(quotedCommaSentences.some((sentence) => sentence.includes("\"Lucy, come downstairs.\"")));
assert.ok(quotedCommaSentences.every((sentence) => !/^come downstairs/.test(sentence)));
const quotedCommaChunks = buildStoryboardChunks(quotedCommaDialogueText, "en", 0.4, "secondsPerWord");
const quotedCommaUnits = quotedCommaChunks.flatMap((chunk) =>
  chunk.split("\n").map((line) => line.replace(/【分镜单元\s*\d+】/, "").trim())
);
assert.ok(quotedCommaUnits.some((unitText) => unitText.includes("\"Lucy, come downstairs.\"")));
assert.ok(quotedCommaUnits.every((unitText) => !/^"Lucy,$/.test(unitText)));
assert.ok(quotedCommaUnits.every((unitText) => !/^come downstairs/.test(unitText)));

const abbreviatedEnglishText = "Dr. Vivian stood in the U.S. embassy hallway. Mr. Adam looked away.";
assert.deepEqual(splitSentences(abbreviatedEnglishText, "en"), [
  "Dr. Vivian stood in the U.S. embassy hallway.",
  "Mr. Adam looked away."
]);

const quotedActionAttributionText = "\"Get out!\" Adam barked. I stepped back from the doorway.";
assert.deepEqual(splitSentences(quotedActionAttributionText, "en"), [
  "\"Get out!\" Adam barked.",
  "I stepped back from the doorway."
]);
const quotedActionAttributionChunks = buildStoryboardChunks(quotedActionAttributionText, "en", 0.4, "secondsPerWord");
const quotedActionAttributionUnits = quotedActionAttributionChunks.flatMap((chunk) =>
  chunk.split("\n").map((line) => line.replace(/【分镜单元\s*\d+】/, "").trim())
);
assert.ok(quotedActionAttributionUnits.includes("\"Get out!\" Adam barked."));
assert.ok(quotedActionAttributionUnits.every((unitText) => !/^Adam barked/.test(unitText)));

const consecutiveQuotedDialogueText = "“What good is crying? Just playing the helpless card.” “Will Seraphina forgive them or kick them out?” “Out with the old, in with the new. Those two Familiars aren’t even half as good as Drake.” Leo knelt on the floor,";
const consecutiveQuotedDialogueUnits = buildStoryboardChunks(consecutiveQuotedDialogueText, "en", 0.4, "secondsPerWord").flatMap((chunk) =>
  chunk.split("\n").map((line) => line.replace(/【分镜单元\s*\d+】/, "").trim())
);
assert.ok(consecutiveQuotedDialogueUnits.includes("“What good is crying? Just playing the helpless card.”"));
assert.ok(consecutiveQuotedDialogueUnits.includes("“Will Seraphina forgive them or kick them out?”"));
assert.ok(consecutiveQuotedDialogueUnits.includes("“Out with the old, in with the new. Those two Familiars aren’t even half as good as Drake.”"));
assert.ok(consecutiveQuotedDialogueUnits.some((unitText) => unitText.startsWith("Leo knelt on the floor")));
assert.ok(consecutiveQuotedDialogueUnits.every((unitText) => !/^the old/.test(unitText)));
assert.ok(consecutiveQuotedDialogueUnits.every((unitText) => !/Out with$/.test(unitText)));

const shortQuotedExclamationText = "“Shut up! Stop it! Stop!” I stared at her in horror. I grabbed the baseball bat from my desk, ready to smash the speaker that was blasting the recording.";
const shortQuotedExclamationUnits = extractStoryboardUnitTexts(buildStoryboardChunks(shortQuotedExclamationText, "en", 0.4, "secondsPerWord"));
assert.deepEqual(shortQuotedExclamationUnits, [
  "“Shut up! Stop it! Stop!” I stared at her in horror.",
  "I grabbed the baseball bat from my desk, ready to smash the speaker that was blasting the recording."
]);
assert.equal(shortQuotedExclamationUnits.join(" "), shortQuotedExclamationText);

const compactQuotedCommandUnits = extractStoryboardUnitTexts(
  buildStoryboardChunks("\"Lucy, come downstairs.\"", "en", 0.4, "secondsPerWord")
);
assert.deepEqual(compactQuotedCommandUnits, ["\"Lucy, come downstairs.\""]);

const quotePhraseBoundaryText = "“Before the trial began every noble student in the hall leaned closer waiting for another cruel joke because nobody wanted mercy today from Seraphina’s enemies again Out with the old, in with the new. Those two Familiars aren’t even half as good as Drake.”";
const quotePhraseBoundaryUnits = extractStoryboardUnitTexts(buildStoryboardChunks(quotePhraseBoundaryText, "en", 0.4, "secondsPerWord"));
assert.ok(quotePhraseBoundaryUnits.every((unitText) => /^“.*”$/.test(unitText)));
assert.ok(quotePhraseBoundaryUnits.every((unitText) => !/^“the old\b/i.test(unitText)));
assert.ok(quotePhraseBoundaryUnits.every((unitText) => !/Out with”$/.test(unitText)));
assert.ok(quotePhraseBoundaryUnits.every((unitText) => !/\b[A-Za-z]+-[A-Za-z]+$/.test(unitText)));

const chineseListText = "桌上放着钥匙、手机、旧照片和一封没有署名的信，她站在门口迟迟没有进去。";
const chineseListUnits = buildStoryboardChunks(chineseListText, "zh", 0.25, "secondsPerChar").flatMap((chunk) =>
  chunk.split("\n").map((line) => line.replace(/【分镜单元\s*\d+】/, "").trim())
);
assert.ok(chineseListUnits.every((unitText) => !/^手机、/.test(unitText)));
assert.ok(chineseListUnits.every((unitText) => !/^旧照片/.test(unitText)));
assert.ok(chineseListUnits.some((unitText) => unitText.includes("钥匙、手机、旧照片")));

const longChineseText = "林昭猛地推开门，发现走廊尽头站着那个陌生男人，他的影子被灯拉得很长，邻居听见动静后从门缝里看出来，整条楼道忽然安静得像被掐住了喉咙。";
const storyboardChunks = buildStoryboardChunks(longChineseText, "zh", 0.25, "secondsPerChar");
assert.ok(storyboardChunks.length >= 1);
assert.ok(storyboardChunks.every((chunk) => chunk.includes("【分镜单元")));
assert.ok(storyboardChunks.every((chunk) => chunk.length <= 1200));
assert.ok(storyboardChunks.length <= 2);
for (const chunk of storyboardChunks) {
  for (const unitText of chunk.split("\n").map((line) => line.replace(/【分镜单元\s*\d+】/, ""))) {
    assert.ok(calculateDurationSeconds(unitText, "zh", 1 / 6, "secondsPerChar") <= 12);
  }
}

const mergeShortNarrationText = "林昭推开门。走廊尽头的灯闪了两下。她握紧手机，慢慢走向电梯口。";
const mergedShortNarrationUnits = buildStoryboardChunks(mergeShortNarrationText, "zh", 0.25, "secondsPerChar").flatMap((chunk) =>
  chunk.split("\n").map((line) => line.replace(/【分镜单元\s*\d+】/, "").trim())
);
assert.deepEqual(mergedShortNarrationUnits, [
  "林昭推开门。走廊尽头的灯闪了两下。她握紧手机，慢慢走向电梯口。"
]);
assert.ok(calculateDurationSeconds(mergedShortNarrationUnits[0], "zh", 1 / 6, "secondsPerChar") <= 12);

const dialogueBoundaryWithContextText = "Lena opened the door. \"Stay back,\" Adam said. She stopped at the threshold and did not move forward.";
const dialogueBoundaryWithContextUnits = buildStoryboardChunks(dialogueBoundaryWithContextText, "en", 0.4, "secondsPerWord").flatMap((chunk) =>
  chunk.split("\n").map((line) => line.replace(/【分镜单元\s*\d+】/, "").trim())
);
assert.ok(dialogueBoundaryWithContextUnits.includes("Lena opened the door."));
assert.ok(dialogueBoundaryWithContextUnits.includes("\"Stay back,\" Adam said."));
assert.ok(dialogueBoundaryWithContextUnits.includes("She stopped at the threshold and did not move forward."));
assert.ok(dialogueBoundaryWithContextUnits.every((unitText) => !/Lena opened the door\.\s+"Stay back/.test(unitText)));

const newlineDependentClauseText = "In this world,\nbloodline determines fate.";
const newlineDependentClauseChunks = buildStoryboardChunks(newlineDependentClauseText, "en", 0.4, "secondsPerWord");
const newlineDependentClauseUnits = newlineDependentClauseChunks.flatMap((chunk) =>
  chunk.split("\n").map((line) => line.replace(/【分镜单元\s*\d+】/, "").trim())
);
assert.deepEqual(newlineDependentClauseUnits, ["In this world, bloodline determines fate."]);
assert.ok(newlineDependentClauseChunks.every((chunk) => !/【分镜单元\s*\d+】[^\n]*\n(?!【分镜单元)/.test(chunk)));
assert.ok(newlineDependentClauseUnits.every((unitText) => unitText !== "In this world,"));

const longDependentClauseText = "In this world, from the moment I opened my eyes, every bloodline, every contract, and every inherited name decided where a person could stand before the first bell rang.";
const longDependentClauseUnits = buildStoryboardChunks(longDependentClauseText, "en", 0.4, "secondsPerWord").flatMap((chunk) =>
  chunk.split("\n").map((line) => line.replace(/【分镜单元\s*\d+】/, "").trim())
);
assert.ok(longDependentClauseUnits.every((unitText) => unitText !== "In this world,"));
assert.ok(longDependentClauseUnits.every((unitText) => !/^from the moment/i.test(unitText)));
assert.ok(longDependentClauseUnits.some((unitText) => /^In this world,\s+from the moment/i.test(unitText)));

const emergencyRoomText = "In the emergency room, the doctors were trying to save me, but my fiance ordered them to dig out my heart and replace it with my fake adopted sister Vivian's heart.";
const emergencyChunks = buildStoryboardChunks(emergencyRoomText, "en", 0.4, "secondsPerWord");
const emergencyUnits = emergencyChunks.flatMap((chunk) =>
  chunk.split("\n").map((line) => line.replace(/【分镜单元\s*\d+】/, "").trim())
);
assert.ok(emergencyUnits.length >= 1);
assert.notEqual(emergencyUnits[emergencyUnits.length - 1], "heart.");
assert.ok(emergencyUnits.every((unitText) => countWords(unitText) > 1));

const emergencyRoomWithDialogueText = [
  "In the emergency room, the doctors were trying to save me, but my fiance ordered them to dig out my heart and replace it with my fake adopted sister Vivian's heart.",
  "\"Vivian's heart is failing,\" he said."
].join("\n");
const emergencyDialogueChunks = buildStoryboardChunks(emergencyRoomWithDialogueText, "en", 0.4, "secondsPerWord");
const emergencyDialogueUnits = emergencyDialogueChunks.flatMap((chunk) =>
  chunk.split("\n").map((line) => line.replace(/【分镜单元\s*\d+】/, "").trim())
);
assert.ok(emergencyDialogueUnits.some((unitText) => unitText.startsWith("\"Vivian's heart is failing,\"")));
assert.ok(emergencyDialogueUnits.every((unitText) => !/heart\.\s+"Vivian's heart is failing/.test(unitText)));
assert.ok(emergencyDialogueUnits.every((unitText) => !/^heart\.\s+"Vivian's heart is failing/.test(unitText)));

const accusationDialogueText = [
  "My soul trembled wildly.",
  "\"You forgive me? You were the one who took my heart, my dignity, and threw me into hell, and now you have the audacity to say you forgive me?\""
].join("\n");
const accusationSentences = splitSentences(accusationDialogueText, "en");
assert.deepEqual(accusationSentences, [
  "My soul trembled wildly.",
  "\"You forgive me? You were the one who took my heart, my dignity, and threw me into hell, and now you have the audacity to say you forgive me?\""
]);
const accusationChunks = buildStoryboardChunks(accusationDialogueText, "en", 0.4, "secondsPerWord");
const accusationUnits = accusationChunks.flatMap((chunk) =>
  chunk.split("\n").map((line) => line.replace(/【分镜单元\s*\d+】/, "").trim())
);
assert.ok(accusationUnits.includes("My soul trembled wildly."));
const accusationDialogueUnits = accusationUnits.filter((unitText) => unitText.includes("You forgive me") || unitText.includes("took my heart") || unitText.includes("audacity"));
assert.ok(accusationDialogueUnits.length >= 1);
assert.ok(accusationDialogueUnits.every((unitText) => /^".*"$/.test(unitText)));
assert.ok(accusationDialogueUnits.some((unitText) => unitText.includes("You forgive me?")));
assert.ok(accusationDialogueUnits.every((unitText) => !/^You were the one/.test(unitText)));
assert.ok(accusationDialogueUnits.every((unitText) => !/^and now/.test(unitText)));
assert.match(safetyPrompt, /speaker 需要继承同一段直接发言的说话人/);

const curlyLongDialogueText = "“You forgave her again, ignored every warning I gave you, forced me to smile while everyone watched me break apart in silence, and then expected me to thank you for turning my pain into another convenient story.”";
const curlyLongDialogueUnits = buildStoryboardChunks(curlyLongDialogueText, "en", 0.4, "secondsPerWord").flatMap((chunk) =>
  chunk.split("\n").map((line) => line.replace(/【分镜单元\s*\d+】/, "").trim())
);
assert.ok(curlyLongDialogueUnits.length > 1);
assert.ok(curlyLongDialogueUnits.every((unitText) => /^“.*”$/.test(unitText)));
assert.ok(curlyLongDialogueUnits.every((unitText) => !/^You forgave/.test(unitText)));

const quotedSpeechBeforeSceneText = "“In one month, the Beastmaster Grand Tournament begins. I want you to win on the Holy See’s home ground.” Inside the vault were high-tier Core Crystals, ancient remains, sealed Divine Matter, and relics collected over centuries.";
assert.deepEqual(splitSentences(quotedSpeechBeforeSceneText, "en"), [
  "“In one month, the Beastmaster Grand Tournament begins. I want you to win on the Holy See’s home ground.”",
  "Inside the vault were high-tier Core Crystals, ancient remains, sealed Divine Matter, and relics collected over centuries."
]);
const quotedSpeechBeforeSceneUnits = extractStoryboardUnitTexts(
  buildStoryboardChunks(quotedSpeechBeforeSceneText, "en", 0.4, "secondsPerWord")
);
assert.ok(quotedSpeechBeforeSceneUnits.includes("“In one month, the Beastmaster Grand Tournament begins. I want you to win on the Holy See’s home ground.”"));
assert.ok(quotedSpeechBeforeSceneUnits.some((unitText) => unitText.startsWith("Inside the vault were high-tier Core Crystals")));
assert.ok(quotedSpeechBeforeSceneUnits.every((unitText) => !/\bwi$/.test(unitText)));
assert.ok(quotedSpeechBeforeSceneUnits.every((unitText) => !/^n on\b/.test(unitText)));

const straightSingleQuoteDialogueText = "'What good is crying? Just playing the helpless card.' Leo knelt on the floor.";
assert.deepEqual(splitSentences(straightSingleQuoteDialogueText, "en"), [
  "'What good is crying? Just playing the helpless card.'",
  "Leo knelt on the floor."
]);
const straightSingleQuoteUnits = extractStoryboardUnitTexts(
  buildStoryboardChunks(straightSingleQuoteDialogueText, "en", 0.4, "secondsPerWord")
);
assert.ok(straightSingleQuoteUnits.includes("'What good is crying? Just playing the helpless card.'"));
assert.ok(straightSingleQuoteUnits.includes("Leo knelt on the floor."));
assert.ok(straightSingleQuoteUnits.every((unitText) => !/^Just playing/.test(unitText)));

const fuzzyMatchedShotResult = __test__.repairStoryboardChunkResult({
  shots: [{
    sourceText: "Take what you need Victoria said",
    anchorSentence: "Take what you need Victoria said",
    narration: "Victoria said.",
    dialogueLines: [{ speaker: "Victoria", text: "Take what you need,", delivery: "平静" }],
    imageDescription: "Victoria站在宝库入口侧面说话，嘴角压低，眼部看向对方；宝库上方的水晶辉光形成冷金色主光；前景保留门框边缘，中景锁定Victoria，背景陈列轻微虚化；保持人物面部清晰，自然柔和瞳孔聚焦。",
    shotType: "近景",
    characters: ["Victoria"],
    scene: "Royal Vault",
    emotion: "平静",
    prompt: [
      "[00:00-00:04s]",
      "[镜头语法 / 客观视角 / 近景 / 70mm / 浅景深，焦点锁定Victoria眼部 // 稳定缓慢推进]",
      "[画面细节] Victoria站在宝库入口侧面说话，嘴角压低，眼部看向对方；宝库上方的水晶辉光形成冷金色主光；前景保留门框边缘，中景锁定Victoria，背景陈列轻微虚化；保持人物面部清晰，自然柔和瞳孔聚焦。",
      "[摄影机补充状态] 稳定近景，70mm 浅景深，焦点锁定Victoria眼部，背景轻微虚化。",
      "[声音设计] 环境声低铺。",
      "[台词/旁白] Victoria（平静）：“Take what you need,”；【停顿0.8s】；旁白：“Victoria said.”",
      "[导演批注] 普通镜头。"
    ].join("\n")
  }],
  notes: []
}, "【分镜单元 1】“Take what you need,” Victoria said.");
assert.doesNotMatch(fuzzyMatchedShotResult.shots[0].prompt, /保底修复镜头/);
assert.match(fuzzyMatchedShotResult.shots[0].prompt, /Victoria（/);

const fallbackDialogueSpeakerVisualResult = __test__.repairStoryboardChunkResult({
  shots: [],
  notes: []
}, [
  "【分镜单元 1】“Take what you need,” Victoria said.",
  "【分镜单元 2】“In one month, the Beastmaster Grand Tournament begins. I want you to win on the Holy See’s home ground.”"
].join("\n"));
assert.match(fallbackDialogueSpeakerVisualResult.shots[1].prompt, /\[台词\/旁白\] Victoria（/);
assert.match(fallbackDialogueSpeakerVisualResult.shots[1].imageDescription, /Victoria/);
assert.doesNotMatch(fallbackDialogueSpeakerVisualResult.shots[1].prompt, /空间结构|画面主体|镜头视觉中心|当前叙事重点/);

const fallbackPronounSubjectResult = __test__.repairStoryboardChunkResult({
  shots: [],
  notes: []
}, [
  "【分镜单元 1】Rage appeared in the front hall in its six-star Infernal Apex Dragon form,",
  "【分镜单元 2】its massive body nearly brushing the ceiling.",
  "【分镜单元 3】It didn’t hesitate."
].join("\n"));
assert.match(fallbackPronounSubjectResult.shots[1].imageDescription, /Rage/);
assert.match(fallbackPronounSubjectResult.shots[2].imageDescription, /Rage/);
assert.doesNotMatch(fallbackPronounSubjectResult.shots[1].prompt, /空间结构|画面主体|镜头视觉中心/);
assert.doesNotMatch(fallbackPronounSubjectResult.shots[2].prompt, /空间结构|画面主体|镜头视觉中心/);
assert.doesNotMatch(fallbackPronounSubjectResult.shots[2].imageDescription, /说出对白/);

const hospitalMentionInDialogueDoesNotMoveSceneResult = __test__.repairStoryboardChunkResult({
  shots: [],
  notes: []
}, [
  "【分镜单元 1】Inside the Royal Vault, Victoria stood beside the altar.",
  "【分镜单元 2】“It maintains the purification barrier for three commoner hospitals in the Imperial Capital,”",
  "【分镜单元 3】For the first time, she didn’t look at me as just a weapon."
].join("\n"));
assert.doesNotMatch(hospitalMentionInDialogueDoesNotMoveSceneResult.shots[2].scene, /医院|hospital/i);
assert.doesNotMatch(hospitalMentionInDialogueDoesNotMoveSceneResult.shots[2].prompt, /医院|hospital|急救室|医疗灯/i);
assert.match(hospitalMentionInDialogueDoesNotMoveSceneResult.shots[2].scene, /Royal Vault/);
assert.doesNotMatch(hospitalMentionInDialogueDoesNotMoveSceneResult.shots[1].scene, /医院|hospital/i);
assert.match(hospitalMentionInDialogueDoesNotMoveSceneResult.shots[1].scene, /Royal Vault/);

const thirdPersonAttributionInheritsContextSpeakerResult = __test__.repairStoryboardChunkResult({
  shots: [],
  notes: []
}, [
  "【分镜单元 1】Inside the Royal Vault, Victoria stood beside the altar.",
  "【分镜单元 2】“You knew about those hospitals?” she asked.",
  "【分镜单元 3】Victoria instructed a scribe to record the altar’s purpose and immediately removed the three hospitals from the noble council’s budget cuts.",
  "【分镜单元 4】Her tone was calm, without mockery."
].join("\n"));
const softVisualPlaceholderTerms = /空间延续环境|空间结构|当前可见变化|可见物件/;
assert.match(thirdPersonAttributionInheritsContextSpeakerResult.shots[1].prompt, /\[台词\/旁白\] Victoria（/);
assert.match(thirdPersonAttributionInheritsContextSpeakerResult.shots[1].imageDescription, /Victoria/);
assert.match(thirdPersonAttributionInheritsContextSpeakerResult.shots[2].scene, /Royal Vault/);
assert.match(thirdPersonAttributionInheritsContextSpeakerResult.shots[3].scene, /Royal Vault/);
assert.doesNotMatch(thirdPersonAttributionInheritsContextSpeakerResult.shots[2].prompt.split("[台词/旁白]")[0], /医院|hospital|急救室|医疗灯/i);
assert.doesNotMatch(JSON.stringify(thirdPersonAttributionInheritsContextSpeakerResult.shots.map((shot) => ({
  scene: shot.scene,
  imageDescription: shot.imageDescription,
  promptVisual: shot.prompt.split("[台词/旁白]")[0]
}))), softVisualPlaceholderTerms);

const vaultCoreAfterHospitalMemoryResult = __test__.repairStoryboardChunkResult({
  shots: [],
  notes: []
}, [
  "【分镜单元 1】Inside the Royal Vault, the Lifebloom Stag core rested on the altar.",
  "【分镜单元 2】“In my last life, I took Elena’s mother there when she was critically ill.”",
  "【分镜单元 3】The Lifebloom Stag’s core had saved many lives, including someone I no longer cared to remember."
].join("\n"));
assert.match(vaultCoreAfterHospitalMemoryResult.shots[2].scene, /Royal Vault/);
assert.doesNotMatch(vaultCoreAfterHospitalMemoryResult.shots[2].prompt, /医院|hospital|急救室|医疗灯/i);

const thirdPersonAttributionSkipsFirstPersonInterruptionResult = __test__.repairStoryboardChunkResult({
  shots: [],
  notes: []
}, [
  "【分镜单元 1】Victoria was silent for a moment.",
  "【分镜单元 2】For the first time, she didn’t look at me as just a weapon.",
  "【分镜单元 3】“You knew about those hospitals?” she asked."
].join("\n"));
assert.match(thirdPersonAttributionSkipsFirstPersonInterruptionResult.shots[2].prompt, /\[台词\/旁白\] Victoria（/);
assert.match(thirdPersonAttributionSkipsFirstPersonInterruptionResult.shots[2].imageDescription, /Victoria/);
assert.doesNotMatch(thirdPersonAttributionSkipsFirstPersonInterruptionResult.shots[2].imageDescription, /第一人称主角说出对白/);

const halfAnHourIsNotACharacterResult = __test__.repairStoryboardChunkResult({
  shots: [],
  notes: []
}, [
  "【分镜单元 1】Rage bit the blue-white bone in half and swallowed it.",
  "【分镜单元 2】“That scroll was a holy forbidden spell from the Holy See.”",
  "【分镜单元 3】It devoured the scroll as well, exhaling a faint white mist. Half an hour later, seven outer chambers of the vault had been emptied."
].join("\n"));
assert.doesNotMatch(halfAnHourIsNotACharacterResult.shots[2].characters.join(" "), /\bHalf\b/);
assert.doesNotMatch(halfAnHourIsNotACharacterResult.shots[2].imageDescription, /\bHalf承接|中景锁定Half/);
assert.match(halfAnHourIsNotACharacterResult.shots[2].imageDescription, /Rage|魔力雾气|鳞片纹路|宝库角落/);
assert.doesNotMatch(halfAnHourIsNotACharacterResult.shots[2].imageDescription, /Victoria承接|中景锁定Victoria/);

const directItContinuationResult = __test__.repairStoryboardChunkResult({
  shots: [],
  notes: []
}, [
  "【分镜单元 1】Rage bit the blue-white bone in half and swallowed it.",
  "【分镜单元 2】It devoured the scroll as well, exhaling a faint white mist. Half an hour later, seven outer chambers of the vault had been emptied."
].join("\n"));
assert.match(directItContinuationResult.shots[1].imageDescription, /Rage|魔力雾气|鳞片纹路|宝库角落/);

const chapterMarkerStoryboardText = "###Chapter 1 The Abandoned Egg###{{{\n\"Arthur, form a Pact with it,\" Elena said. \"This is your moment.\"";
const chapterMarkerUnits = buildStoryboardChunks(chapterMarkerStoryboardText, "en", 0.4, "secondsPerWord").flatMap((chunk) =>
  chunk.split("\n").map((line) => line.replace(/【分镜单元\s*\d+】/, "").trim())
);
assert.ok(chapterMarkerUnits.every((unitText) => !/###|\{\{\{|Chapter 1 The Abandoned Egg/.test(unitText)));
assert.ok(chapterMarkerUnits.some((unitText) => unitText.startsWith("\"Arthur, form a Pact with it,\" Elena said.")));

const fantasyAnalysis: AnalysisResult = {
  logline: "Arthur rejects the Radiant Gryphon and chooses a defective egg.",
  characters: [
    {
      name: "Arthur Pendragon",
      role: "第一人称主角",
      appearance: "未在原文证实",
      costume: "未在原文证实",
      continuityNote: "重生回到 Binding Rite",
      evidence: [{ quote: "my name was Arthur Pendragon", chunkIndex: 0, field: "name" }]
    },
    {
      name: "Elena",
      role: "未婚妻",
      appearance: "未在原文证实",
      costume: "未在原文证实",
      continuityNote: "催促Arthur缔结契约",
      evidence: [{ quote: "Elena said", chunkIndex: 0, field: "name" }]
    },
    {
      name: "Drake",
      role: "贵族宿敌",
      appearance: "未在原文证实",
      costume: "未在原文证实",
      continuityNote: "嘲笑Arthur",
      evidence: [{ quote: "Drake was the first to laugh", chunkIndex: 0, field: "name" }]
    }
  ],
  scenes: [],
  keyEvents: [],
  emotionalRhythm: [],
  continuityNotes: []
};
const fantasyFallbackChunk = [
  "【分镜单元 1】The world-destroying black dragon From a One-Star Reject to a God Devourer In this world,",
  "【分镜单元 2】That alone told me everything I needed to know.",
  "【分镜单元 3】\"Since Arthur doesn’t want it,\"",
  "【分镜单元 4】Even a few instructors showed disappointment.",
  "【分镜单元 5】Its life force was so faint it was almost nonexistent. The plaque read: Redtail Lizard. One star. Defective.",
  "【分镜单元 6】\"That kind of glory isn’t for me,\" I said."
].join("\n");
const fantasyFallbackResult = __test__.repairStoryboardChunkResult({ shots: [], notes: [] }, fantasyFallbackChunk, fantasyAnalysis);
const fantasyFallbackVisualJson = JSON.stringify(fantasyFallbackResult.shots.map((shot) => ({
  characters: shot.characters,
  imageDescription: shot.imageDescription,
  prompt: shot.prompt.split("[台词/旁白]")[0],
  scene: shot.scene
})));
assert.doesNotMatch(fantasyFallbackVisualJson, /\b(?:One|Star Reject|God Devourer|Aether Beast|Since Arthur|Even|There|Its|Hatchery Basin|Defective)\b/);
assert.doesNotMatch(fantasyFallbackVisualJson, /(?:One|Since Arthur|Even|Its)(?:承接|沿|抬起|身体|嘴角)/);
assert.equal(fantasyFallbackResult.shots[5].dialogueLines[0].speaker, "Arthur Pendragon");
assert.match(fantasyFallbackResult.shots[5].prompt, /Arthur Pendragon（/);

const runtimeNumberedShots = __test__.assignRuntimeFieldsForStoryboardChunk([
  makeRawShot("first"),
  makeRawShot("second"),
  makeRawShot("third")
], {
  existingShotCount: 8,
  episodeCount: 1,
  language: "en"
});
assert.deepEqual(runtimeNumberedShots.map((shot) => shot.index), [9, 10, 11]);
assert.deepEqual(runtimeNumberedShots.map((shot) => shot.id), ["shot-9", "shot-10", "shot-11"]);

const bridgeDuration = calculateShotDurationSeconds({
  narration: "无",
  sourceText: "",
  shotType: "场景空镜",
  imageDescription: "楼道灯管闪烁，门缝里有人影后退。",
  prompt: "[台词/旁白] 无"
}, "zh");
assert.equal(bridgeDuration, 2);

const longNarrationShotDuration = calculateShotDurationSeconds({
  narration: "林昭猛地推开门，发现走廊尽头站着那个陌生男人，他的影子被灯拉得很长。",
  sourceText: "",
  shotType: "中景",
  imageDescription: "林昭推门，远处陌生男人站在灯影里。",
  prompt: "[台词/旁白] 旁白：“林昭猛地推开门。”"
}, "zh");
assert.ok(longNarrationShotDuration <= 12);
assert.ok(longNarrationShotDuration >= 4);

const extendedNarrationShotDuration = calculateShotDurationSeconds({
  narration: "林昭推开门。走廊尽头的灯闪了两下。她握紧手机，慢慢走向电梯口。",
  sourceText: "",
  shotType: "中景",
  imageDescription: "林昭从门口走向电梯口，走廊灯光闪烁。",
  prompt: "[台词/旁白] 旁白：“林昭推开门。走廊尽头的灯闪了两下。她握紧手机，慢慢走向电梯口。”"
}, "zh");
assert.ok(extendedNarrationShotDuration > 6);
assert.ok(extendedNarrationShotDuration <= 12);

const unorderedShots: StoryboardShot[] = [
  makeShot("shot-3", 3, 2),
  makeShot("shot-1", 1, 1),
  makeShot("shot-2", 2, 1)
];
const orderedShots = sortStoryboardShots(unorderedShots);
assert.deepEqual(orderedShots.map((shot) => `${shot.episodeNumber}-${shot.index}`), ["1-1", "1-2", "2-3"]);
const jumpedShots: StoryboardShot[] = [
  makeShot("shot-1", 1, 1),
  makeShot("shot-9", 9, 1),
  makeShot("shot-10", 10, 2)
];
assert.deepEqual(
  numberStoryboardShots(jumpedShots).map(({ shot, episodeShotNumber }) => `${shot.episodeNumber}-${episodeShotNumber}`),
  ["1-1", "1-2", "2-1"]
);
const jumpedCsv = storyboardToCsv(jumpedShots);
assert.match(jumpedCsv, /\n1,1,/);
assert.match(jumpedCsv, /\n1,2,/);
assert.doesNotMatch(jumpedCsv, /\n1,9,/);
assert.match(storyboardToExcel(unorderedShots), /<table>/);
assert.match(storyboardToExcel(unorderedShots), /镜头时长秒/);

assert.equal(deriveProjectTitleFromFilename("ep01.txt"), "ep01");
assert.equal(deriveProjectTitleFromFilename("第一集.最终版.txt"), "第一集.最终版");
assert.equal(sanitizeDownloadBaseName("ep:01/危险*文件名"), "ep_01_危险_文件名");
assert.equal(sanitizeDownloadBaseName("   "), "storyboard");
assert.equal(buildDownloadFilename("ep01.txt", "xls"), "ep01.xls");
assert.equal(buildDownloadFilename("第一集.最终版.txt", "json"), "第一集.最终版.json");

const promptExportShot = makeShot("shot-4", 4, 1);
promptExportShot.prompt = "[00:00-00:04s][镜头语法 / 客观视角 / 中景 / 35mm // 缓慢推进][画面细节] 林昭站在门口。 [摄影机补充状态] 手持轻微晃动。[声音设计] 低频环境声。[台词/旁白] 旁白：“林昭停下脚步。”[导演批注] 保持悬念。";
const promptCsv = storyboardToCsv([promptExportShot]);
assert.match(promptCsv, /"\[00:00-00:04s\]\n\[镜头语法/);
assert.match(promptCsv, /\[台词\/旁白\] 旁白/);
const promptExcel = storyboardToExcel([promptExportShot]);
assert.match(promptExcel, /class="multiline prompt-cell"/);
assert.match(promptExcel, /\[00:00-00:04s\]<br style="mso-data-placement:same-cell" \/>\[镜头语法/);

console.log("error handling tests passed");

function makeShot(id: string, index: number, episodeNumber: number): StoryboardShot {
  return {
    id,
    index,
    episodeNumber,
    sourceText: "source",
    anchorSentence: "anchor",
    narration: "narration",
    dialogueLines: [
      { speaker: "未指明说话者", delivery: "紧张+低声", text: "别回头。" }
    ],
    imageDescription: "image",
    shotType: "中景",
    characters: ["林昭"],
    scene: "走廊",
    emotion: "紧张",
    prompt: "prompt",
    durationSeconds: 4
  };
}

function makeRawShot(sourceText: string) {
  return {
    sourceText,
    anchorSentence: sourceText,
    narration: sourceText,
    dialogueLines: [],
    imageDescription: "Summoning Hall中，Arthur站在祭坛边。",
    shotType: "中景",
    characters: ["Arthur"],
    scene: "Summoning Hall",
    emotion: "克制",
    prompt: [
      "[00:00-00:04s]",
      "[镜头语法 / 客观视角 / 中景 / 50mm / 中等景深，焦点锁定Arthur // 稳定推进]",
      "[画面细节] Summoning Hall中，Arthur站在祭坛边；大厅高窗与仪式符文形成侧上方柔光；背景保持轻微虚化。",
      "[摄影机补充状态] 50mm 中等景深稳定推进，焦点锁定Arthur。",
      "[声音设计] 环境声低铺。",
      `旁白：“${sourceText}”`,
      "[导演批注] 普通镜头。"
    ].join("\n")
  };
}

function extractStoryboardUnitTexts(chunks: string[]): string[] {
  return chunks.flatMap((chunk) =>
    chunk.split("\n").map((line) => line.replace(/【分镜单元\s*\d+】/, "").trim())
  );
}

function countWords(text: string): number {
  return text.match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)?/g)?.length ?? 0;
}

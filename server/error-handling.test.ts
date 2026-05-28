import assert from "node:assert/strict";
import { numberStoryboardShots, sortStoryboardShots, storyboardToCsv, storyboardToExcel } from "../src/shared/export";
import { buildDownloadFilename, deriveProjectTitleFromFilename, sanitizeDownloadBaseName } from "../src/shared/files";
import { buildStoryboardChunks, calculateDurationSeconds, calculateShotDurationSeconds, splitSentences } from "../src/shared/text";
import type { StoryboardShot } from "../src/shared/types";

process.env.JSSTORY_SKIP_SERVER_LISTEN = "1";

const { __test__ } = await import("./index");

const gatewayError = __test__.normalizeOpenAIError(
  new Error("500 invalid character 'e' looking for beginning of value")
);

assert.match(gatewayError.message, /非 JSON 或损坏的 JSON/);
assert.doesNotMatch(gatewayError.message, /模型 gpt-5\.4 不可用或当前账号无权限/);
assert.equal(__test__.isGatewayNonJsonError("500 invalid character 'e' looking for beginning of value"), true);
assert.equal(__test__.shouldFallbackToChat(new Error("500 invalid character 'e' looking for beginning of value")), true);

const modelError = __test__.normalizeOpenAIError(new Error("model gpt-5.4 not found"));
assert.match(modelError.message, /模型 gpt-5\.4 不可用或当前账号无权限/);
assert.equal(__test__.shouldFallbackToChat(new Error("model gpt-5.4 not found")), false);

const responseFormatError = new Error("response_format json_schema is unsupported");
assert.equal(__test__.shouldFallbackToChat(responseFormatError), true);

const overloadedError = __test__.normalizeOpenAIError(new Error("503 system cpu overloaded"));
assert.match(overloadedError.message, /上游服务返回 503/);
assert.match(overloadedError.message, /system cpu overloaded/);
assert.equal(__test__.isTransientGatewayError(new Error("503 system cpu overloaded")), true);
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

assert.equal(__test__.getParallelLimit(), 2);

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
assert.match(safetyPrompt, /安全画面化规则/);
assert.match(safetyPrompt, /非露骨影视表达/);
assert.match(safetyPrompt, /不得把伤害过程、身体细节或操作步骤画面化/);
assert.match(safetyPrompt, /安全部位和相对位置/);
assert.match(safetyPrompt, /\[镜头语法 \/ 视角 \/ 景别 \/ 焦距 \/ 焦点变化 \/\/ 运动或强度\]/);
assert.doesNotMatch(safetyPrompt, /景别或景别切换 \/ 焦段或焦距变化/);
assert.match(safetyPrompt, /中景 -> 近景/);
assert.match(safetyPrompt, /焦距变化/);
assert.match(safetyPrompt, /焦点转移/);
assert.match(safetyPrompt, /默认保持单一景别、单一焦距和稳定焦点/);
assert.match(safetyPrompt, /没有明确叙事原因时，只写一个最合适的景别/);
assert.match(safetyPrompt, /表情细节/);
assert.match(safetyPrompt, /手部动作/);
assert.match(safetyPrompt, /身体姿态/);
assert.match(safetyPrompt, /嘴角状态/);
assert.match(safetyPrompt, /眼部状态/);
assert.match(safetyPrompt, /面部状态/);
assert.match(safetyPrompt, /视线方向/);
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
assert.match(singleQuotedDialogueShot.prompt, /旁白：“Adam whispered\.”；【停顿0\.4s】；Adam（低声）：“I know,”/);

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
}, "【分镜单元 1】First sentence.\n【分镜单元 2】Second sentence that the model dropped.");
assert.equal(repairedChunkResult.shots.length, 2);
assert.equal(repairedChunkResult.shots[1].sourceText, "Second sentence that the model dropped.");
assert.equal(repairedChunkResult.shots[1].narration, "Second sentence that the model dropped.");
assert.match(repairedChunkResult.shots[1].prompt, /\[台词\/旁白\] 旁白：“Second sentence that the model dropped\.”/);

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
assert.equal(unsupportedSceneResult.shots[0].scene, "医院急救室");
assert.match(unsupportedSceneResult.shots[0].imageDescription, /医院|急救室|手术台/);
assert.match(unsupportedSceneResult.shots[0].prompt, /医院|急救室|手术台/);

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
assert.equal(visualAnchorOnlySceneResult.shots[0].scene, "顶层公寓");
assert.match(visualAnchorOnlySceneResult.shots[0].imageDescription, /顶层公寓|penthouse/);

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
assert.equal(inheritedSceneResult.shots[1].scene, "医院急救室");
assert.match(inheritedSceneResult.shots[1].imageDescription, /医院|急救室/);
assert.match(inheritedSceneResult.shots[1].prompt, /医院|急救室/);

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
assert.equal(nextInheritedSceneResult.shots[0].scene, "未明确场景");
assert.match(nextInheritedSceneResult.shots[0].imageDescription, /空白背景/);

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
assert.equal(previousScenePreferredResult.shots[1].scene, "未明确场景");
assert.match(previousScenePreferredResult.shots[1].imageDescription, /空白背景/);

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
assert.equal(blockedInheritedSceneResult.shots[1].scene, "顶层公寓");
assert.match(blockedInheritedSceneResult.shots[1].imageDescription, /顶层公寓|沙发/);

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
assert.deepEqual(unsupportedCharacterResult.shots[0].characters, ["Adam", "Vivian"]);
assert.match(unsupportedCharacterResult.shots[0].imageDescription, /Vivian/);
assert.match(unsupportedCharacterResult.shots[0].prompt.split("[台词/旁白]")[0], /Vivian/);

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
assert.deepEqual(unsupportedGenericCharacterResult.shots[0].characters, ["Adam", "Vivian"]);
assert.match(unsupportedGenericCharacterResult.shots[0].imageDescription, /女孩|身边|冷笑/);
assert.match(unsupportedGenericCharacterResult.shots[0].prompt.split("[台词/旁白]")[0], /女孩|身边|冷笑/);

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
assert.match(visualOnlyGenericCharacterResult.shots[0].imageDescription, /医生|旁边|记录/);
assert.match(visualOnlyGenericCharacterResult.shots[0].prompt.split("[台词/旁白]")[0], /医生|旁边|记录/);

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
assert.match(repeatedConservativePromptResult.shots[0].prompt.split("[台词/旁白]")[0], /医生|旁边|记录/);

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
assert.deepEqual(dialogueSpeakerCharacterResult.shots[0].characters, []);

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
assert.ok(shoutedDialogueUnits.includes("I grabbed the baseball bat from my desk,"));
assert.ok(shoutedDialogueUnits.includes("ready to smash the speaker that was blasting the recording."));
assert.ok(shoutedDialogueUnits.every((unitText) => !/^Stop it!/.test(unitText)));
assert.ok(shoutedDialogueUnits.every((unitText) => !/^Stop!”/.test(unitText)));

const quotedCommaDialogueText = "\"Lucy, come downstairs.\" I heard my mother calling from the kitchen, her voice echoing through the silent hallway as I froze beside the door.";
const quotedCommaChunks = buildStoryboardChunks(quotedCommaDialogueText, "en", 0.4, "secondsPerWord");
const quotedCommaUnits = quotedCommaChunks.flatMap((chunk) =>
  chunk.split("\n").map((line) => line.replace(/【分镜单元\s*\d+】/, "").trim())
);
assert.ok(quotedCommaUnits.some((unitText) => unitText.includes("\"Lucy, come downstairs.\"")));
assert.ok(quotedCommaUnits.every((unitText) => !/^"Lucy,$/.test(unitText)));
assert.ok(quotedCommaUnits.every((unitText) => !/^come downstairs/.test(unitText)));

const longChineseText = "林昭猛地推开门，发现走廊尽头站着那个陌生男人，他的影子被灯拉得很长，邻居听见动静后从门缝里看出来，整条楼道忽然安静得像被掐住了喉咙。";
const storyboardChunks = buildStoryboardChunks(longChineseText, "zh", 0.25, "secondsPerChar");
assert.ok(storyboardChunks.length >= 1);
assert.ok(storyboardChunks.every((chunk) => chunk.includes("【分镜单元")));
assert.ok(storyboardChunks.every((chunk) => chunk.length <= 1200));
assert.ok(storyboardChunks.length <= 2);
for (const chunk of storyboardChunks) {
  for (const unitText of chunk.split("\n").map((line) => line.replace(/【分镜单元\s*\d+】/, ""))) {
    assert.ok(calculateDurationSeconds(unitText, "zh", 1 / 6, "secondsPerChar") <= 8);
  }
}

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
assert.ok(longNarrationShotDuration <= 6);
assert.ok(longNarrationShotDuration >= 4);

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

function countWords(text: string): number {
  return text.match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)?/g)?.length ?? 0;
}

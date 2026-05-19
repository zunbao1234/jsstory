import assert from "node:assert/strict";
import { sortStoryboardShots, storyboardToExcel } from "../src/shared/export";
import { buildStoryboardChunks, calculateDurationSeconds, calculateShotDurationSeconds } from "../src/shared/text";
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

assert.equal(__test__.getParallelLimit(), 2);

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
assert.match(storyboardToExcel(unorderedShots), /<table>/);
assert.match(storyboardToExcel(unorderedShots), /镜头时长秒/);

console.log("error handling tests passed");

function makeShot(id: string, index: number, episodeNumber: number): StoryboardShot {
  return {
    id,
    index,
    episodeNumber,
    sourceText: "source",
    anchorSentence: "anchor",
    narration: "narration",
    imageDescription: "image",
    shotType: "中景",
    characters: ["林昭"],
    scene: "走廊",
    emotion: "紧张",
    prompt: "prompt",
    durationSeconds: 4
  };
}

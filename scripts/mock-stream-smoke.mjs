const target = process.env.JSSTORY_SMOKE_URL ?? "http://localhost:8899/api/generate/stream";

const text = Array.from({ length: 96 }, (_, index) =>
  `第${index + 1}句，林昭在走廊里发现新的线索，灯光闪烁，脚步声逐渐靠近，她必须在门被推开前做出选择。`
).join("");

const body = {
  text,
  settings: {
    visualStyle: "photoreal",
    scriptStyle: "惊悚",
    language: "zh",
    readingRate: 0.95,
    readingRateUnit: "secondsPerChar",
    episodeCount: 3
  }
};

const response = await fetch(target, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
});

if (!response.ok || !response.body) {
  throw new Error(`stream request failed: ${response.status}`);
}

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let storyboardChunks = 0;
let totalShots = 0;
let done = false;
const eventTypes = new Set();

while (true) {
  const { value, done: streamDone } = await reader.read();
  if (streamDone) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";

  for (const line of lines) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    eventTypes.add(event.type);
    if (event.type === "error") throw new Error(event.error);
    if (event.type === "storyboard_chunk") {
      storyboardChunks = event.completedChunks;
      totalShots = event.completedShots;
    }
    if (event.type === "done") {
      done = true;
      totalShots = event.totalShots;
    }
  }
}

if (!done) throw new Error("stream ended without done event");
if (storyboardChunks <= 0) throw new Error("no storyboard chunks received");
if (totalShots <= 0) throw new Error("no shots generated");
if (!eventTypes.has("storyboard_progress")) throw new Error("no storyboard progress event received");

console.log(JSON.stringify({
  ok: true,
  eventTypes: Array.from(eventTypes),
  storyboardChunks,
  totalShots
}, null, 2));

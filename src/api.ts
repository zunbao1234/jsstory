import type {
  AnalysisResult,
  ConfigResponse,
  ConfigUpdateRequest,
  GenerationStreamEvent,
  ModelListResponse,
  StorySettings,
  StoryboardResult,
  TranslationResponse
} from "./shared/types";

export async function fetchConfig(): Promise<ConfigResponse> {
  return requestJson<ConfigResponse>("/api/config");
}

export async function updateConfig(config: ConfigUpdateRequest): Promise<ConfigResponse> {
  return requestJson<ConfigResponse>("/api/config", {
    method: "POST",
    body: JSON.stringify(config)
  });
}

export async function fetchModels(): Promise<ModelListResponse> {
  return requestJson<ModelListResponse>("/api/models");
}

export async function translateNovel(text: string): Promise<TranslationResponse> {
  return requestJson<TranslationResponse>("/api/translate", {
    method: "POST",
    body: JSON.stringify({ text })
  });
}

export async function analyzeNovel(text: string, settings: StorySettings): Promise<AnalysisResult> {
  return requestJson<AnalysisResult>("/api/analyze", {
    method: "POST",
    body: JSON.stringify({ text, settings })
  });
}

export async function generateStoryboard(
  text: string,
  settings: StorySettings,
  analysis: AnalysisResult
): Promise<StoryboardResult> {
  return requestJson<StoryboardResult>("/api/storyboard", {
    method: "POST",
    body: JSON.stringify({ text, settings, analysis })
  });
}

export async function generateStoryboardStream(
  text: string,
  settings: StorySettings,
  onEvent: (event: GenerationStreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  await readGenerationStream("/api/generate/stream", { text, settings }, onEvent, signal);
}

export async function resumeStoryboardStream(
  text: string,
  settings: StorySettings,
  analysis: AnalysisResult,
  existingShots: StoryboardResult["shots"],
  startChunkIndex: number,
  onEvent: (event: GenerationStreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  await readGenerationStream("/api/generate/storyboard/resume", {
    text,
    settings,
    analysis,
    existingShots,
    startChunkIndex
  }, onEvent, signal);
}

async function readGenerationStream(
  url: string,
  body: unknown,
  onEvent: (event: GenerationStreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error ?? `请求失败：${response.status}`);
  }
  if (!response.body) throw new Error("当前浏览器不支持流式读取。");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const clean = line.trim();
      if (!clean) continue;
      const event = JSON.parse(clean) as GenerationStreamEvent;
      onEvent(event);
      if (event.type === "error") throw new Error(event.error);
    }
  }

  buffer += decoder.decode();
  const clean = buffer.trim();
  if (clean) {
    const event = JSON.parse(clean) as GenerationStreamEvent;
    onEvent(event);
    if (event.type === "error") throw new Error(event.error);
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...init?.headers
    },
    ...init
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error ?? `请求失败：${response.status}`);
  }

  return data as T;
}

import type { AnalysisResult, ProjectState, StoryboardShot } from "./types";

const CSV_HEADERS = [
  "分集",
  "镜头编号",
  "旁白",
  "落点句",
  "画面描述",
  "镜头类型",
  "角色",
  "场景",
  "情绪",
  "提示词",
  "时长秒"
];

export function storyboardToCsv(shots: StoryboardShot[]): string {
  const rows = shots.map((shot) => [
    shot.episodeNumber,
    shot.index,
    shot.narration,
    shot.anchorSentence,
    shot.imageDescription,
    shot.shotType,
    shot.characters.join("、"),
    shot.scene,
    shot.emotion,
    shot.prompt,
    shot.durationSeconds
  ]);

  return [CSV_HEADERS, ...rows].map((row) => row.map(escapeCsv).join(",")).join("\n");
}

export function projectToJson(project: ProjectState): string {
  return JSON.stringify(project, null, 2);
}

export function summarizeAnalysis(analysis: AnalysisResult | null): string {
  if (!analysis) return "尚未生成理解结果";
  return [
    `故事钩子：${analysis.logline}`,
    `人物：${analysis.characters.map((item) => item.name).join("、") || "未识别"}`,
    `场景：${analysis.scenes.map((item) => item.name).join("、") || "未识别"}`,
    `连续性：${analysis.continuityNotes.join("；") || "无"}`
  ].join("\n");
}

function escapeCsv(value: unknown): string {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

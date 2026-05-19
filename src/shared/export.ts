import type { AnalysisResult, ProjectState, StoryboardShot } from "./types";

const STORYBOARD_HEADERS = [
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
  "镜头时长秒"
];

export function storyboardToCsv(shots: StoryboardShot[]): string {
  const rows = sortStoryboardShots(shots).map((shot) => [
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

  return [STORYBOARD_HEADERS, ...rows].map((row) => row.map(escapeCsv).join(",")).join("\n");
}

export function storyboardToExcel(shots: StoryboardShot[]): string {
  const rows = sortStoryboardShots(shots).map((shot) => [
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
    shot.durationSeconds.toFixed(1)
  ]);

  const tableRows = [STORYBOARD_HEADERS, ...rows]
    .map((row, rowIndex) => {
      const tag = rowIndex === 0 ? "th" : "td";
      return `<tr>${row.map((cell) => `<${tag}>${escapeHtml(cell)}</${tag}>`).join("")}</tr>`;
    })
    .join("");

  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    '<meta charset="utf-8" />',
    "<style>",
    "table{border-collapse:collapse;font-family:Arial,'Microsoft YaHei',sans-serif;font-size:12px;}",
    "th,td{border:1px solid #999;padding:6px;vertical-align:top;white-space:pre-wrap;mso-number-format:'\\@';}",
    "th{background:#20201d;color:#fff;font-weight:700;}",
    "</style>",
    "</head>",
    "<body>",
    `<table>${tableRows}</table>`,
    "</body>",
    "</html>"
  ].join("");
}

export function projectToJson(project: ProjectState): string {
  return JSON.stringify({ ...project, shots: sortStoryboardShots(project.shots) }, null, 2);
}

export function sortStoryboardShots(shots: StoryboardShot[]): StoryboardShot[] {
  return [...shots].sort((a, b) => {
    const episodeOrder = a.episodeNumber - b.episodeNumber;
    if (episodeOrder !== 0) return episodeOrder;
    return a.index - b.index;
  });
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

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

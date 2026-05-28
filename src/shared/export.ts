import type { AnalysisResult, ProjectState, StoryboardShot } from "./types";

export interface NumberedStoryboardShot {
  shot: StoryboardShot;
  globalShotNumber: number;
  episodeShotNumber: number;
}

const STORYBOARD_HEADERS = [
  "分集",
  "镜头编号",
  "旁白",
  "角色对白",
  "落点句",
  "画面描述",
  "镜头类型",
  "角色",
  "场景",
  "情绪",
  "提示词",
  "镜头时长秒"
];
const PROMPT_COLUMN_INDEX = STORYBOARD_HEADERS.indexOf("提示词");
const DIALOGUE_COLUMN_INDEX = STORYBOARD_HEADERS.indexOf("角色对白");

export function storyboardToCsv(shots: StoryboardShot[]): string {
  const rows = numberStoryboardShots(shots).map(({ shot, episodeShotNumber }) => [
    shot.episodeNumber,
    episodeShotNumber,
    shot.narration,
    formatDialogueLines(shot.dialogueLines),
    shot.anchorSentence,
    shot.imageDescription,
    shot.shotType,
    shot.characters.join("、"),
    shot.scene,
    shot.emotion,
    formatPromptForExport(shot.prompt),
    shot.durationSeconds
  ]);

  return [STORYBOARD_HEADERS, ...rows].map((row) => row.map(escapeCsv).join(",")).join("\n");
}

export function storyboardToExcel(shots: StoryboardShot[]): string {
  const rows = numberStoryboardShots(shots).map(({ shot, episodeShotNumber }) => [
    shot.episodeNumber,
    episodeShotNumber,
    shot.narration,
    formatDialogueLines(shot.dialogueLines),
    shot.anchorSentence,
    shot.imageDescription,
    shot.shotType,
    shot.characters.join("、"),
    shot.scene,
    shot.emotion,
    formatPromptForExport(shot.prompt),
    shot.durationSeconds.toFixed(1)
  ]);

  const tableRows = [STORYBOARD_HEADERS, ...rows]
    .map((row, rowIndex) => {
      const tag = rowIndex === 0 ? "th" : "td";
      return `<tr>${row.map((cell, cellIndex) => `<${tag}${getCellClass(cellIndex)}>${escapeExcelCell(cell, cellIndex)}</${tag}>`).join("")}</tr>`;
    })
    .join("");

  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    '<meta charset="utf-8" />',
    "<style>",
    "table{border-collapse:collapse;font-family:Arial,'Microsoft YaHei',sans-serif;font-size:12px;}",
    "th,td{border:1px solid #999;padding:6px;vertical-align:top;mso-number-format:'\\@';}",
    "td{white-space:normal;}",
    ".multiline{mso-data-placement:same-cell;}",
    ".prompt-cell{min-width:520px;line-height:1.45;}",
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

export function numberStoryboardShots(shots: StoryboardShot[]): NumberedStoryboardShot[] {
  const episodeCounts = new Map<number, number>();
  return sortStoryboardShots(shots).map((shot, index) => {
    const episodeShotNumber = (episodeCounts.get(shot.episodeNumber) ?? 0) + 1;
    episodeCounts.set(shot.episodeNumber, episodeShotNumber);
    return {
      shot,
      globalShotNumber: index + 1,
      episodeShotNumber
    };
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
  const text = normalizeLineBreaks(String(value ?? ""));
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function escapeHtml(value: unknown): string {
  return normalizeLineBreaks(String(value ?? ""))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeExcelCell(value: unknown, cellIndex: number): string {
  const escaped = escapeHtml(value);
  if (cellIndex !== PROMPT_COLUMN_INDEX && cellIndex !== DIALOGUE_COLUMN_INDEX) return escaped;
  return escaped.replace(/\n/g, '<br style="mso-data-placement:same-cell" />');
}

function formatDialogueLines(lines: StoryboardShot["dialogueLines"]): string {
  if (!lines || lines.length === 0) return "";
  return lines.map((line) => `${line.speaker}（${line.delivery}）：“${line.text}”`).join("\n");
}

function formatPromptForExport(prompt: string): string {
  const normalized = normalizeLineBreaks(prompt)
    .replace(/\s*(?=\[(?:\d{2}:\d{2}-\d{2}:\d{2}s\]|镜头语法|画面细节|摄影机补充状态|声音设计|台词\/旁白|导演批注))/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return normalized.trim();
}

function normalizeLineBreaks(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function getCellClass(cellIndex: number): string {
  if (cellIndex === PROMPT_COLUMN_INDEX) return ' class="multiline prompt-cell"';
  if (cellIndex === DIALOGUE_COLUMN_INDEX) return ' class="multiline"';
  return "";
}

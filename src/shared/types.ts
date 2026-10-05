export type LanguageMode = "zh" | "en";
export type ApiConnectionStatus = "unknown" | "checking" | "connected" | "failed";
export type ReadingRateUnit = "secondsPerChar" | "secondsPerWord";

export interface StorySettings {
  visualStyle: string;
  scriptStyle: string;
  language: LanguageMode;
  readingRate: number;
  readingRateUnit: ReadingRateUnit;
  episodeCount: number;
}

export type VerificationStatus = "verified" | "partial" | "unsupported" | "conflict";

export interface EvidenceQuote {
  quote: string;
  chunkIndex?: number;
  field?: string;
}

export interface CharacterProfile {
  name: string;
  role: string;
  appearance: string;
  costume: string;
  continuityNote: string;
  evidence?: EvidenceQuote[];
  verificationStatus?: VerificationStatus;
}

export interface SceneProfile {
  name: string;
  location: string;
  mood: string;
  visualAnchor: string;
  evidence?: EvidenceQuote[];
  verificationStatus?: VerificationStatus;
}

export interface AnalysisResult {
  logline: string;
  characters: CharacterProfile[];
  scenes: SceneProfile[];
  keyEvents: string[];
  emotionalRhythm: string[];
  continuityNotes: string[];
}

export interface StoryboardShot {
  id: string;
  index: number;
  episodeNumber: number;
  sourceText: string;
  anchorSentence: string;
  narration: string;
  dialogueLines: DialogueLine[];
  imageDescription: string;
  shotType: string;
  characters: string[];
  scene: string;
  emotion: string;
  prompt: string;
  durationSeconds: number;
  generationStatus?: "pending" | "generating" | "completed" | "failed";
  generationError?: string;
  generationChunkIndex?: number;
}

export interface StoryboardUnit {
  id: string;
  index: number;
  text: string;
  chunkIndex: number;
}

export interface StoryboardPlan {
  chunks: string[];
  units: StoryboardUnit[];
}

export interface DialogueLine {
  speaker: string;
  delivery: string;
  text: string;
}

export interface StoryboardResult {
  shots: StoryboardShot[];
  notes: string[];
}

export interface ProjectState {
  id: string;
  title: string;
  sourceFilename?: string;
  novelText: string;
  translatedText?: string;
  settings: StorySettings;
  analysis: AnalysisResult | null;
  shots: StoryboardShot[];
  updatedAt: number;
  createdAt?: number;
  status?: "draft" | "generating" | "completed" | "failed";
  lastError?: string;
}

export interface ConfigResponse {
  model: string;
  hasApiKey: boolean;
  baseURL: string;
  apiKeySource: "env" | "runtime" | "missing";
}

export interface ConfigUpdateRequest {
  model: string;
  apiKey?: string;
  baseURL?: string;
}

export interface ModelListResponse {
  models: string[];
}

export interface ModelConnectionCheckResponse {
  model: string;
  api: "responses" | "chat_completions";
  elapsedMs: number;
}

export interface TranslationResponse {
  translatedText: string;
}

export type GenerationStreamEvent =
  | { type: "heartbeat"; phase: "connected" | "analysis" | "analysis_merge" | "storyboard"; elapsedSeconds: number }
  | { type: "started"; chunkTotal: number }
  | { type: "analysis_started"; chunkTotal: number }
  | { type: "analysis_chunk"; chunkIndex: number; chunkTotal: number; completedChunks: number }
  | { type: "analysis_merge"; completedBatches: number; totalBatches: number }
  | { type: "analysis_merge_progress"; activeBatch: number; totalBatches: number; completedBatches: number; elapsedSeconds: number }
  | { type: "analysis_completed"; analysis: AnalysisResult }
  | { type: "storyboard_started"; chunkTotal: number; startChunkIndex?: number; completedChunks?: number; completedShots?: number }
  | { type: "storyboard_chunk_started"; chunkIndex: number; chunkTotal: number; completedChunks: number }
  | {
      type: "storyboard_retrying";
      chunkIndex: number;
      chunkTotal: number;
      depth: number;
      partIndex: number;
      partTotal: number;
      reason: string;
    }
  | { type: "storyboard_progress"; chunkIndex: number; chunkTotal: number; finishedChunks: number; displayedChunks: number }
  | {
      type: "storyboard_chunk";
      chunkIndex: number;
      chunkTotal: number;
      completedChunks: number;
      completedShots: number;
      shots: StoryboardShot[];
      notes: string[];
    }
  | {
      type: "storyboard_chunk_failed";
      chunkIndex: number;
      chunkTotal: number;
      completedChunks: number;
      error: string;
    }
  | { type: "done"; totalShots: number; notes: string[]; shots: StoryboardShot[] }
  | { type: "error"; error: string };

export interface Estimate {
  unitCount: number;
  sentenceCount: number;
  chunkCount: number;
  readingSeconds: number;
}

export type LanguageMode = "zh" | "en";
export type ReadingRateUnit = "secondsPerChar" | "secondsPerWord";

export interface StorySettings {
  visualStyle: string;
  scriptStyle: string;
  language: LanguageMode;
  readingRate: number;
  readingRateUnit: ReadingRateUnit;
  episodeCount: number;
}

export interface CharacterProfile {
  name: string;
  role: string;
  appearance: string;
  costume: string;
  continuityNote: string;
}

export interface SceneProfile {
  name: string;
  location: string;
  mood: string;
  visualAnchor: string;
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
  imageDescription: string;
  shotType: string;
  characters: string[];
  scene: string;
  emotion: string;
  prompt: string;
  durationSeconds: number;
}

export interface StoryboardResult {
  shots: StoryboardShot[];
  notes: string[];
}

export interface ProjectState {
  id: string;
  title: string;
  novelText: string;
  translatedText?: string;
  settings: StorySettings;
  analysis: AnalysisResult | null;
  shots: StoryboardShot[];
  updatedAt: number;
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

export interface TranslationResponse {
  translatedText: string;
}

export type GenerationStreamEvent =
  | { type: "started"; chunkTotal: number }
  | { type: "analysis_started"; chunkTotal: number }
  | { type: "analysis_chunk"; chunkIndex: number; chunkTotal: number; completedChunks: number }
  | { type: "analysis_merge"; completedBatches: number; totalBatches: number }
  | { type: "analysis_completed"; analysis: AnalysisResult }
  | { type: "storyboard_started"; chunkTotal: number }
  | {
      type: "storyboard_chunk";
      chunkIndex: number;
      chunkTotal: number;
      completedChunks: number;
      completedShots: number;
      shots: StoryboardShot[];
      notes: string[];
    }
  | { type: "done"; totalShots: number; notes: string[]; shots: StoryboardShot[] }
  | { type: "error"; error: string };

export interface Estimate {
  unitCount: number;
  sentenceCount: number;
  chunkCount: number;
  readingSeconds: number;
}

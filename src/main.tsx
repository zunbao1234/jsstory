import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertCircle,
  CheckCircle2,
  Languages,
  Clapperboard,
  Eye,
  EyeOff,
  Download,
  FileText,
  FileSpreadsheet,
  FileJson,
  Film,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Settings2,
  Trash2,
  Square,
  ChevronDown,
  WandSparkles
} from "lucide-react";
import { fetchConfig, fetchModels, generateStoryboardStream, resumeStoryboardStream, translateNovel, updateConfig } from "./api";
import { deleteProject, loadLatestProject, loadProjects, saveProject } from "./storage";
import { numberStoryboardShots, projectToJson, sortStoryboardShots, storyboardToCsv, storyboardToExcel, summarizeAnalysis } from "./shared/export";
import { buildDownloadFilename, deriveProjectTitleFromFilename } from "./shared/files";
import {
  estimateNovel,
  formatDuration,
  recalculateShotDurations,
  splitSentences
} from "./shared/text";
import type {
  AnalysisResult,
  ConfigResponse,
  ProjectState,
  StorySettings,
  StoryboardShot
} from "./shared/types";
import "./styles.css";

const scriptStyles = ["爽文", "悬疑", "言情", "玄幻", "都市", "惊悚"];
const visualStyles: Array<{ value: string; label: string }> = [
  { value: "2D", label: "2D" },
  { value: "3D", label: "3D" },
  { value: "3D高精度CG", label: "3D高精度CG" },
  { value: "photoreal", label: "仿真人" },
  { value: "custom", label: "自定义" }
];

const defaultSettings: StorySettings = {
  visualStyle: "photoreal",
  scriptStyle: "悬疑",
  language: "zh",
  readingRate: 0.95,
  readingRateUnit: "secondsPerChar",
  episodeCount: 1
};

const sampleText =
  "夜色压在旧城上空，林昭推开出租屋的门，发现桌上多了一封没有署名的信。信纸上只有一句话：别相信今晚来找你的人。她还没来得及细想，楼道里就响起了缓慢的脚步声。";

const API_CONFIG_STORAGE_KEY = "jsstory-api-config";

type ApiConnectionStatus = "unknown" | "checking" | "connected" | "failed";
type GenerationPhase = "analysis" | "analysis_merge" | "storyboard" | "done" | "failed";

interface GenerationProgress {
  phase: GenerationPhase;
  chunkTotal: number;
  completedChunks: number;
  completedShots: number;
}

interface ResumeState {
  phase: "analysis" | "storyboard";
  startChunkIndex: number;
  chunkTotal: number;
  completedShots: number;
  error: string;
}

interface SavedApiConfig {
  model: string;
  apiKey: string;
  baseURL: string;
}

function App() {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [settings, setSettings] = useState<StorySettings>(defaultSettings);
  const [novelText, setNovelText] = useState(sampleText);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [shots, setShots] = useState<StoryboardShot[]>([]);
  const [translatedText, setTranslatedText] = useState("");
  const [status, setStatus] = useState("准备就绪");
  const [error, setError] = useState("");
  const [configMessage, setConfigMessage] = useState("");
  const [connectionStatus, setConnectionStatus] = useState<ApiConnectionStatus>("unknown");
  const [connectionMessage, setConnectionMessage] = useState("未检测");
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [modelInput, setModelInput] = useState("");
  const [useCustomModel, setUseCustomModel] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [baseUrlInput, setBaseUrlInput] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState<GenerationProgress | null>(null);
  const [generationAbort, setGenerationAbort] = useState<AbortController | null>(null);
  const [generationClock, setGenerationClock] = useState({ elapsedSeconds: 0, idleSeconds: 0 });
  const [resumeState, setResumeState] = useState<ResumeState | null>(null);
  const [customVisualStyle, setCustomVisualStyle] = useState("");
  const [customScriptStyle, setCustomScriptStyle] = useState("");
  const [isAnalysisExpanded, setIsAnalysisExpanded] = useState(false);
  const [restored, setRestored] = useState(false);
  const [activeProjectId, setActiveProjectId] = useState("local-main");
  const [activeSourceFilename, setActiveSourceFilename] = useState<string | undefined>();
  const [projectHistory, setProjectHistory] = useState<ProjectState[]>([]);
  const shotsRef = useRef<StoryboardShot[]>([]);
  const generationProgressRef = useRef<GenerationProgress | null>(null);
  const generationStartedAtRef = useRef(0);
  const lastGenerationEventAtRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const estimate = useMemo(
    () => estimateNovel(novelText, settings.language, settings.readingRate, settings.readingRateUnit),
    [novelText, settings]
  );

  const recalculatedShots = useMemo(
    () => recalculateShotDurations(shots, settings.language, settings.readingRate, settings.readingRateUnit, settings.episodeCount),
    [shots, settings.language, settings.readingRate, settings.readingRateUnit, settings.episodeCount]
  );
  const orderedShots = useMemo(() => sortStoryboardShots(recalculatedShots), [recalculatedShots]);
  const numberedShots = useMemo(() => numberStoryboardShots(recalculatedShots), [recalculatedShots]);

  const totalVisualDuration = orderedShots.reduce((sum, shot) => sum + shot.durationSeconds, 0);
  const averageShotDuration = orderedShots.length > 0 ? totalVisualDuration / orderedShots.length : 0;

  useEffect(() => {
    initializeConfig().catch((err: Error) => setError(err.message));

    loadLatestProject().then((project) => {
      if (!project) return;
      applyProject(project);
      setRestored(true);
    });
    refreshProjectHistory().catch((err) => console.warn("读取历史记录失败", err));
  }, []);

  useEffect(() => {
    const project = buildProject(settings, novelText, translatedText, analysis, shots, {
      id: activeProjectId,
      sourceFilename: activeSourceFilename,
      status: inferProjectStatus(shots, analysis)
    });
    const timer = window.setTimeout(() => {
      saveProject(project)
        .then(() => refreshProjectHistory())
        .catch((err) => console.warn("保存项目失败", err));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [settings, novelText, translatedText, analysis, shots, activeProjectId, activeSourceFilename]);

  useEffect(() => {
    if (settings.language !== "en") {
      setTranslatedText("");
      return;
    }
    const cleanText = novelText.trim();
    if (cleanText.length < 20 || !config?.hasApiKey) return;

    const timer = window.setTimeout(() => {
      void runTranslation(cleanText);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [novelText, settings.language, config?.hasApiKey]);

  useEffect(() => {
    if (!isGenerating) {
      setGenerationClock({ elapsedSeconds: 0, idleSeconds: 0 });
      return;
    }
    const timer = window.setInterval(() => {
      const now = Date.now();
      setGenerationClock({
        elapsedSeconds: Math.max(0, Math.round((now - generationStartedAtRef.current) / 1000)),
        idleSeconds: Math.max(0, Math.round((now - lastGenerationEventAtRef.current) / 1000))
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isGenerating]);

  function updateSettings(patch: Partial<StorySettings>) {
    setSettings((current) => ({ ...current, ...patch }));
  }

  function updateVisualStyle(value: string) {
    if (value === "custom") {
      const nextStyle = customVisualStyle.trim() || "自定义视觉风格";
      setCustomVisualStyle(nextStyle);
      updateSettings({ visualStyle: nextStyle });
      return;
    }
    updateSettings({ visualStyle: value });
  }

  function updateCustomVisualStyle(value: string) {
    setCustomVisualStyle(value);
    updateSettings({ visualStyle: value.trim() || "自定义视觉风格" });
  }

  function updateScriptStyle(value: string) {
    if (value === "custom") {
      const nextStyle = customScriptStyle.trim() || "自定义剧本风格";
      setCustomScriptStyle(nextStyle);
      updateSettings({ scriptStyle: nextStyle });
      return;
    }
    updateSettings({ scriptStyle: value });
  }

  function updateCustomScriptStyle(value: string) {
    setCustomScriptStyle(value);
    updateSettings({ scriptStyle: value.trim() || "自定义剧本风格" });
  }

  function applyProject(project: ProjectState) {
    setActiveProjectId(project.id);
    setActiveSourceFilename(project.sourceFilename);
    setSettings({ ...defaultSettings, ...project.settings });
    setNovelText(project.novelText);
    setTranslatedText(project.translatedText ?? "");
    setAnalysis(project.analysis);
    setShots(project.shots);
    shotsRef.current = project.shots;
    setGenerationProgress(null);
    generationProgressRef.current = null;
    setResumeState(null);
    setStatus(`已载入：${project.title}`);
  }

  async function refreshProjectHistory() {
    const projects = await loadProjects();
    setProjectHistory(projects);
  }

  async function handleTxtFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError("");
    const txtFiles = Array.from(files).filter((file) => /\.txt$/i.test(file.name));
    if (txtFiles.length === 0) {
      setError("请选择 .txt 文件。");
      return;
    }

    try {
      const importedProjects = await Promise.all(txtFiles.map(async (file) => {
        const text = await file.text();
        const now = Date.now();
        const id = createProjectId(file.name, now);
        const detectedLanguage = detectLanguageMode(text);
        const nextSettings = detectedLanguage
          ? {
            ...settings,
            language: detectedLanguage,
            readingRateUnit: detectedLanguage === "en" ? "secondsPerWord" as const : "secondsPerChar" as const
          }
          : settings;
        return buildProject(nextSettings, text, "", null, [], {
          id,
          title: deriveProjectTitleFromFilename(file.name),
          sourceFilename: file.name,
          createdAt: now,
          status: "draft"
        });
      }));

      await Promise.all(importedProjects.map((project) => saveProject(project)));
      await refreshProjectHistory();
      applyProject(importedProjects[0]);
      setStatus(`已导入 ${importedProjects.length} 个 TXT 文件`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function openProject(project: ProjectState) {
    if (isGenerating) return;
    applyProject(project);
  }

  async function removeProject(project: ProjectState) {
    if (isGenerating) return;
    await deleteProject(project.id);
    await refreshProjectHistory();
    if (project.id === activeProjectId) {
      resetSample();
      setActiveProjectId("local-main");
      setActiveSourceFilename(undefined);
    }
  }

  function handleNovelTextChange(value: string) {
    setNovelText(value);
    setAnalysis(null);
    setShots([]);
    shotsRef.current = [];
    setGenerationProgress(null);
    generationProgressRef.current = null;
    setResumeState(null);

    const detectedLanguage = detectLanguageMode(value);
    if (detectedLanguage === "en" && (settings.language !== "en" || settings.readingRateUnit !== "secondsPerWord")) {
      updateSettings({ language: "en", readingRateUnit: "secondsPerWord" });
    }
    if (detectedLanguage === "zh" && settings.language !== "zh") {
      updateSettings({ language: "zh", readingRateUnit: "secondsPerChar" });
    }
  }

  async function initializeConfig() {
    const savedConfig = readSavedApiConfig();
    if (savedConfig) {
      setModelInput(savedConfig.model);
      setBaseUrlInput(savedConfig.baseURL);
      setApiKeyInput(savedConfig.apiKey);
      setConnectionStatus("checking");
      setConnectionMessage("正在恢复本地 API 配置");
      const nextConfig = await updateConfig(savedConfig);
      setConfig(nextConfig);
      setModelInput(nextConfig.model);
      setBaseUrlInput(nextConfig.baseURL);
      setConfigMessage("已从本地恢复 API 配置。");
      await loadModels(nextConfig.model);
      return;
    }

    const nextConfig = await fetchConfig();
    setConfig(nextConfig);
    setModelInput(nextConfig.model);
    setBaseUrlInput(nextConfig.baseURL);
    if (nextConfig.hasApiKey) {
      await loadModels(nextConfig.model);
    } else {
      setConnectionStatus("unknown");
      setConnectionMessage("未配置 API Key");
    }
  }

  async function saveRuntimeConfig() {
    setError("");
    setConfigMessage("");
    if (!modelInput.trim()) {
      setError("请填写模型名称。");
      return;
    }

    try {
      setIsSavingConfig(true);
      setConnectionStatus("checking");
      setConnectionMessage("正在应用配置");
      const nextRuntimeConfig = {
        model: modelInput.trim(),
        apiKey: apiKeyInput.trim() || undefined,
        baseURL: baseUrlInput.trim()
      };
      const nextConfig = await updateConfig(nextRuntimeConfig);
      setConfig(nextConfig);
      setModelInput(nextConfig.model);
      setBaseUrlInput(nextConfig.baseURL);
      const savedApiKey = apiKeyInput.trim() || readSavedApiConfig()?.apiKey || "";
      if (savedApiKey) {
        saveApiConfig({ model: nextConfig.model, apiKey: savedApiKey, baseURL: nextConfig.baseURL });
        setApiKeyInput(savedApiKey);
      }
      setConfigMessage("API 配置已应用并保存到本地浏览器。");
      await loadModels(nextConfig.model);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setConnectionStatus("failed");
      setConnectionMessage("配置失败");
    } finally {
      setIsSavingConfig(false);
    }
  }

  async function loadModels(currentModel = modelInput.trim()) {
    setError("");
    try {
      setIsLoadingModels(true);
      setConnectionStatus("checking");
      setConnectionMessage("正在读取模型列表");
      const result = await fetchModels();
      setModelOptions(result.models);
      if (result.models.length > 0 && !result.models.includes(currentModel)) {
        setModelInput(result.models[0]);
        setUseCustomModel(false);
      } else if (result.models.length > 0) {
        setUseCustomModel(false);
      }
      setConnectionStatus("connected");
      setConnectionMessage(result.models.length > 0 ? `已连通，读取到 ${result.models.length} 个模型` : "已连通，但未返回模型列表");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setConnectionStatus("failed");
      setConnectionMessage("连通失败");
    } finally {
      setIsLoadingModels(false);
    }
  }

  async function runTranslation(text: string) {
    setError("");
    try {
      setIsTranslating(true);
      const result = await translateNovel(text);
      setTranslatedText(result.translatedText);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsTranslating(false);
    }
  }

  async function runGeneration() {
    setError("");
    setConfigMessage("");
    if (novelText.trim().length < 20) {
      setError("请至少输入 20 个字符的小说正文。");
      return;
    }
    if (!config?.hasApiKey) {
      setError("请先配置 API Key 并应用配置。");
      setStatus("等待 API 配置");
      return;
    }
    if (connectionStatus !== "connected") {
      setError("API 尚未连通。请先点击“应用配置”或“读取模型”，确认模型列表读取成功后再开始。");
      setStatus("等待 API 连通");
      return;
    }

    try {
      setIsGenerating(true);
      generationStartedAtRef.current = Date.now();
      lastGenerationEventAtRef.current = Date.now();
      setAnalysis(null);
      setShots([]);
      shotsRef.current = [];
      generationProgressRef.current = null;
      setResumeState(null);
      setProgress({
        phase: "analysis",
        chunkTotal: estimate.chunkCount,
        completedChunks: 0,
        completedShots: 0
      });
      setStatus(`开始创作：预计 ${estimate.chunkCount} 段，正在理解小说`);
      const controller = new AbortController();
      setGenerationAbort(controller);
      await generateStoryboardStream(
        novelText,
        settings,
        (event) => {
          lastGenerationEventAtRef.current = Date.now();
          if (event.type === "heartbeat") {
            setStatus(`创作连接正常：已运行 ${event.elapsedSeconds} 秒，等待模型返回阶段结果`);
          }
          if (event.type === "started") {
            setProgress({
              phase: "analysis",
              chunkTotal: event.chunkTotal,
              completedChunks: 0,
              completedShots: 0
            });
            setStatus(`开始创作：预计 ${event.chunkTotal} 段`);
          }
          if (event.type === "analysis_started") {
            setStatus(`理解阶段：0/${event.chunkTotal} 段`);
          }
          if (event.type === "analysis_chunk") {
            updateProgress((current) => ({
              phase: "analysis",
              chunkTotal: event.chunkTotal,
              completedChunks: event.completedChunks,
              completedShots: current?.completedShots ?? 0
            }));
            setStatus(`理解阶段：${event.completedChunks}/${event.chunkTotal} 段`);
          }
          if (event.type === "analysis_merge") {
            updateProgress((current) => current ? { ...current, phase: "analysis_merge" } : current);
            setStatus(`理解合并：${event.completedBatches}/${event.totalBatches} 批`);
          }
          if (event.type === "analysis_merge_progress") {
            updateProgress((current) => current ? { ...current, phase: "analysis_merge" } : current);
            setStatus(`理解合并：正在处理第 ${event.activeBatch}/${event.totalBatches} 批，已完成 ${event.completedBatches} 批，已等待 ${event.elapsedSeconds} 秒`);
          }
          if (event.type === "analysis_completed") {
            setAnalysis(event.analysis);
            setResumeState(null);
            setStatus("理解完成，开始生成分镜");
          }
          if (event.type === "storyboard_started") {
            updateProgress((current) => ({
              phase: "storyboard",
              chunkTotal: event.chunkTotal,
              completedChunks: event.completedChunks ?? 0,
              completedShots: event.completedShots ?? current?.completedShots ?? 0
            }));
            setStatus(`分镜阶段：${event.completedChunks ?? 0}/${event.chunkTotal} 段`);
          }
          if (event.type === "storyboard_chunk") {
            appendShots(event.shots);
            setProgress({
              phase: "storyboard",
              chunkTotal: event.chunkTotal,
              completedChunks: event.completedChunks,
              completedShots: event.completedShots
            });
            setStatus(`分镜阶段：${event.completedChunks}/${event.chunkTotal} 段，已生成 ${event.completedShots} 个镜头`);
          }
          if (event.type === "storyboard_progress") {
            updateProgress((current) => current ? {
              ...current,
              phase: "storyboard",
              chunkTotal: event.chunkTotal
            } : current);
            setStatus(`分镜后台进度：已完成 ${event.finishedChunks}/${event.chunkTotal} 段，已显示到第 ${event.displayedChunks} 段`);
          }
          if (event.type === "done") {
            replaceShots(event.shots);
            setResumeState(null);
            updateProgress((current) => current ? { ...current, phase: "done", completedShots: event.totalShots } : current);
            setStatus(`完成：生成 ${event.totalShots} 个镜头`);
            void saveCurrentProjectSnapshot({ shots: event.shots, status: "completed" });
          }
        },
        controller.signal
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setStatus("已取消生成，已保留当前结果");
      } else {
        const message = err instanceof Error ? err.message : String(err);
        const nextResumeState = buildResumeState(message, generationProgressRef.current, shotsRef.current);
        setResumeState(nextResumeState);
        updateProgress((current) => current ? { ...current, phase: "failed" } : current);
        setError(formatGenerationError(message, nextResumeState));
        setStatus(nextResumeState?.phase === "storyboard"
          ? `分镜中断：已保留当前结果，可从第 ${nextResumeState.startChunkIndex + 1}/${nextResumeState.chunkTotal} 段继续重试`
          : nextResumeState?.phase === "analysis"
            ? `理解中断：可重新尝试理解第 ${nextResumeState.startChunkIndex + 1}/${nextResumeState.chunkTotal} 段`
            : "生成失败，已保留当前结果");
        void saveCurrentProjectSnapshot({ status: "failed", lastError: message });
      }
    } finally {
      setIsGenerating(false);
      setGenerationAbort(null);
    }
  }

  function cancelGeneration() {
    generationAbort?.abort();
  }

  function setProgress(progress: GenerationProgress | null) {
    generationProgressRef.current = progress;
    setGenerationProgress(progress);
  }

  function updateProgress(updater: (current: GenerationProgress | null) => GenerationProgress | null) {
    const nextProgress = updater(generationProgressRef.current);
    setProgress(nextProgress);
  }

  function appendShots(nextShots: StoryboardShot[]) {
    setShots((current) => {
      const merged = [...current, ...nextShots];
      shotsRef.current = merged;
      return merged;
    });
  }

  function replaceShots(nextShots: StoryboardShot[]) {
    shotsRef.current = nextShots;
    setShots(nextShots);
  }

  async function retryFailedStoryboard() {
    setError("");
    setConfigMessage("");
    if (!resumeState) return;
    if (resumeState.phase === "analysis") {
      await runGeneration();
      return;
    }
    if (!analysis) {
      setError("缺少理解档案，无法只重试分镜。请重新开始创作。");
      return;
    }
    if (!config?.hasApiKey || connectionStatus !== "connected") {
      setError("API 尚未连通。请先确认配置和模型可用后再继续重试。");
      return;
    }

    try {
      setIsGenerating(true);
      generationStartedAtRef.current = Date.now();
      lastGenerationEventAtRef.current = Date.now();
      setStatus(`继续重试：从第 ${resumeState.startChunkIndex + 1}/${resumeState.chunkTotal} 段开始`);
      setProgress({
        phase: "storyboard",
        chunkTotal: resumeState.chunkTotal,
        completedChunks: resumeState.startChunkIndex,
        completedShots: shotsRef.current.length
      });
      const controller = new AbortController();
      setGenerationAbort(controller);
      await resumeStoryboardStream(
        novelText,
        settings,
        analysis,
        shotsRef.current,
        resumeState.startChunkIndex,
        (event) => {
          lastGenerationEventAtRef.current = Date.now();
          if (event.type === "heartbeat") {
            setStatus(`继续重试连接正常：已运行 ${event.elapsedSeconds} 秒，等待模型返回阶段结果`);
          }
          if (event.type === "storyboard_started") {
            setProgress({
              phase: "storyboard",
              chunkTotal: event.chunkTotal,
              completedChunks: event.completedChunks ?? resumeState.startChunkIndex,
              completedShots: event.completedShots ?? shotsRef.current.length
            });
            setStatus(`继续重试：${event.completedChunks ?? resumeState.startChunkIndex}/${event.chunkTotal} 段`);
          }
          if (event.type === "storyboard_chunk") {
            appendShots(event.shots);
            setProgress({
              phase: "storyboard",
              chunkTotal: event.chunkTotal,
              completedChunks: event.completedChunks,
              completedShots: event.completedShots
            });
            setStatus(`继续重试：${event.completedChunks}/${event.chunkTotal} 段，已生成 ${event.completedShots} 个镜头`);
          }
          if (event.type === "storyboard_progress") {
            setStatus(`继续重试后台进度：已完成 ${event.finishedChunks}/${event.chunkTotal} 段，已显示到第 ${event.displayedChunks} 段`);
          }
          if (event.type === "done") {
            replaceShots(event.shots);
            setResumeState(null);
            updateProgress((current) => current ? { ...current, phase: "done", completedShots: event.totalShots } : current);
            setStatus(`完成：生成 ${event.totalShots} 个镜头`);
            void saveCurrentProjectSnapshot({ shots: event.shots, status: "completed" });
          }
        },
        controller.signal
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setStatus("已取消继续重试，已保留当前结果");
      } else {
        const message = err instanceof Error ? err.message : String(err);
        const nextResumeState = buildResumeState(message, generationProgressRef.current, shotsRef.current);
        setError(formatGenerationError(message, nextResumeState));
        setResumeState(nextResumeState);
        setStatus(nextResumeState?.phase === "storyboard"
          ? `继续重试中断：已保留当前结果，可从第 ${nextResumeState.startChunkIndex + 1}/${nextResumeState.chunkTotal} 段再次重试`
          : "继续重试失败，已保留当前结果");
        void saveCurrentProjectSnapshot({ status: "failed", lastError: message });
      }
    } finally {
      setIsGenerating(false);
      setGenerationAbort(null);
    }
  }

  function updateShot(id: string, field: keyof StoryboardShot, value: string) {
    setShots((current) => {
      const nextShots = current.map((shot) => {
        if (shot.id !== id) return shot;
        if (field === "characters") {
          return { ...shot, characters: value.split(/[、,，]/).map((item) => item.trim()).filter(Boolean) };
        }
        if (field === "durationSeconds") {
          return { ...shot, durationSeconds: Number(value) || 0 };
        }
        if (field === "dialogueLines") {
          return { ...shot, dialogueLines: parseDialogueLines(value) };
        }
        return { ...shot, [field]: value };
      });
      shotsRef.current = nextShots;
      return nextShots;
    });
  }

  function downloadCsv() {
    downloadFile(buildDownloadFilename(activeSourceFilename, "csv"), storyboardToCsv(orderedShots), "text/csv;charset=utf-8");
  }

  function downloadExcel() {
    downloadFile(buildDownloadFilename(activeSourceFilename, "xls"), storyboardToExcel(orderedShots), "application/vnd.ms-excel;charset=utf-8");
  }

  function downloadJson() {
    downloadFile(
      buildDownloadFilename(activeSourceFilename, "json"),
      projectToJson(buildProject(settings, novelText, translatedText, analysis, orderedShots, {
        id: activeProjectId,
        sourceFilename: activeSourceFilename,
        status: inferProjectStatus(orderedShots, analysis)
      })),
      "application/json"
    );
  }

  function downloadCompletedExcelFiles() {
    const completedProjects = projectHistory.filter((project) => project.shots.length > 0);
    for (const project of completedProjects) {
      downloadProjectExcel(project);
    }
  }

  function downloadProjectExcel(project: ProjectState) {
    downloadFile(
      buildDownloadFilename(project.sourceFilename ?? project.title, "xls"),
      storyboardToExcel(recalculateShotDurations(
        project.shots,
        project.settings.language,
        project.settings.readingRate,
        project.settings.readingRateUnit,
        project.settings.episodeCount
      )),
      "application/vnd.ms-excel;charset=utf-8"
    );
  }

  async function saveCurrentProjectSnapshot(patch: Partial<ProjectState> = {}) {
    const project = buildProject(settings, novelText, translatedText, analysis, patch.shots ?? shotsRef.current, {
      id: activeProjectId,
      sourceFilename: activeSourceFilename,
      status: patch.status ?? inferProjectStatus(patch.shots ?? shotsRef.current, analysis),
      lastError: patch.lastError
    });
    await saveProject(project);
    await refreshProjectHistory();
  }

  function resetSample() {
    setActiveProjectId("local-main");
    setActiveSourceFilename(undefined);
    setNovelText(sampleText);
    setTranslatedText("");
    setAnalysis(null);
    setShots([]);
    shotsRef.current = [];
    setGenerationProgress(null);
    generationProgressRef.current = null;
    setResumeState(null);
    setStatus("已载入示例文本");
  }

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <p className="eyebrow">Narrated Novel Storyboard</p>
          <h1>解说剧分镜工坊</h1>
          <p className="lead">把整本小说拆成可编辑的镜头表，让每一句旁白都有画面承接，并生成通用中文提示词。</p>
        </div>
        <div className="model-badge" title="后端读取环境变量，也可在本页临时覆盖当前会话配置">
          {config?.hasApiKey ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
          <span>{config?.model ?? "读取配置中"}</span>
        </div>
      </section>

      {restored && <div className="notice">已恢复上次本地保存的项目。</div>}
      {error && <div className="error"><AlertCircle size={18} />{error}</div>}
      {configMessage && <div className="notice"><CheckCircle2 size={18} />{configMessage}</div>}

      <section className="api-config-panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Local API</p>
            <h2>API 配置</h2>
          </div>
          <div className="config-source">
            <Settings2 size={16} />
            {renderApiKeySource(config)}
          </div>
        </div>
        <div className={`connection-strip ${connectionStatus}`}>
          {connectionStatus === "connected" ? <CheckCircle2 size={16} /> : connectionStatus === "checking" ? <Loader2 className="spin" size={16} /> : <AlertCircle size={16} />}
          <span>{connectionMessage}</span>
        </div>
        <div className="api-config-grid">
          <label className="field">
            <span>模型</span>
            <div className="model-picker">
              {modelOptions.length > 0 && !useCustomModel ? (
                <select value={modelInput} onChange={(event) => setModelInput(event.target.value)}>
                  {modelOptions.map((model) => (
                    <option key={model} value={model}>{model}</option>
                  ))}
                </select>
              ) : (
                <input
                  value={modelInput}
                  onChange={(event) => setModelInput(event.target.value)}
                  placeholder="gpt-5.4"
                />
              )}
              {modelOptions.length > 0 && (
                <button type="button" onClick={() => setUseCustomModel((value) => !value)}>
                  {useCustomModel ? "选择" : "手填"}
                </button>
              )}
            </div>
          </label>
          <label className="field api-key-field">
            <span>API Key</span>
            <div className="secret-input">
              <input
                type={showApiKey ? "text" : "password"}
                value={apiKeyInput}
                onChange={(event) => setApiKeyInput(event.target.value)}
                placeholder={config?.hasApiKey ? "已保存，可直接沿用" : "sk-..."}
              />
              <button type="button" onClick={() => setShowApiKey((value) => !value)} title={showApiKey ? "隐藏 API Key" : "显示 API Key"}>
                {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </label>
          <label className="field">
            <span>Base URL</span>
            <input value={baseUrlInput} onChange={(event) => setBaseUrlInput(event.target.value)} placeholder="默认 OpenAI API" />
            <small>第三方网关请填写 OpenAI-compatible API 根地址，通常以 /v1 结尾，不是控制台首页。</small>
          </label>
          <button className="secondary" onClick={saveRuntimeConfig} disabled={isSavingConfig}>
            {isSavingConfig ? <Loader2 className="spin" size={17} /> : <Save size={17} />}
            应用配置
          </button>
          <button className="secondary ghost" onClick={() => loadModels()} disabled={isLoadingModels || !config?.hasApiKey}>
            {isLoadingModels ? <Loader2 className="spin" size={17} /> : <RefreshCw size={17} />}
            读取模型
          </button>
        </div>
      </section>

      <section className="control-band">
        <Segmented
          label="视觉风格"
          value={getVisualStyleControlValue(settings.visualStyle)}
          options={visualStyles}
          onChange={updateVisualStyle}
        />
        <label className="field custom-style-field">
          <span>视觉描述</span>
          <input
            value={isCustomVisualStyle(settings.visualStyle) ? customVisualStyle || settings.visualStyle : renderVisualStyleLabel(settings.visualStyle)}
            onChange={(event) => updateCustomVisualStyle(event.target.value)}
            onFocus={() => {
              if (!isCustomVisualStyle(settings.visualStyle)) {
                updateCustomVisualStyle(renderVisualStyleLabel(settings.visualStyle));
              }
            }}
            placeholder="例如：3D高精度CG、悬疑童话、赛博朋克电影感、水墨国风..."
          />
        </label>
        <label className="field">
          <span>剧本风格</span>
          <select value={getScriptStyleControlValue(settings.scriptStyle)} onChange={(event) => updateScriptStyle(event.target.value)}>
            {scriptStyles.map((style) => <option key={style}>{style}</option>)}
            <option value="custom">自定义</option>
          </select>
        </label>
        {isCustomScriptStyle(settings.scriptStyle) && (
          <label className="field custom-style-field">
            <span>自定义剧本</span>
            <input
              value={customScriptStyle || settings.scriptStyle}
              onChange={(event) => updateCustomScriptStyle(event.target.value)}
              placeholder="例如：悬念解谜、热血升级、黑色幽默..."
            />
          </label>
        )}
        <Segmented
          label="语言"
          value={settings.language}
          options={[
            { value: "zh", label: "中文" },
            { value: "en", label: "英文" }
          ]}
          onChange={(value) => updateSettings({ language: value as StorySettings["language"] })}
        />
        <label className="field compact">
          <span>阅读速率</span>
          <input
            type="number"
            min="0.05"
            step="0.05"
            value={settings.readingRate}
            onChange={(event) => updateSettings({ readingRate: Number(event.target.value) || 0.95 })}
          />
        </label>
        <label className="field">
          <span>单位</span>
          <select
            value={settings.readingRateUnit}
            onChange={(event) => updateSettings({ readingRateUnit: event.target.value as StorySettings["readingRateUnit"] })}
          >
            <option value="secondsPerChar">秒/字</option>
            <option value="secondsPerWord">秒/词</option>
          </select>
        </label>
        <label className="field compact">
          <span>分集数</span>
          <input
            type="number"
            min="1"
            max="999"
            step="1"
            value={settings.episodeCount}
            onChange={(event) => updateSettings({ episodeCount: clampInteger(event.target.value, 1, 999) })}
          />
        </label>
      </section>

      <section className="workspace">
        <div className="editor-panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Novel Input</p>
              <h2>{activeSourceFilename ? activeSourceFilename : "小说正文"}</h2>
            </div>
            <div className="panel-actions">
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,text/plain"
                multiple
                hidden
                onChange={(event) => void handleTxtFiles(event.target.files)}
              />
              <button className="icon-button" onClick={() => fileInputRef.current?.click()} title="导入 TXT 文件">
                <FileText size={18} />
              </button>
              <button className="icon-button" onClick={resetSample} title="载入示例">
                <RefreshCw size={18} />
              </button>
            </div>
          </div>
          <textarea
            value={novelText}
            onChange={(event) => handleNovelTextChange(event.target.value)}
            spellCheck={false}
          />
          <div className="metrics">
            <Metric label="阅读单位" value={estimate.unitCount.toLocaleString()} />
            <Metric label="句子" value={estimate.sentenceCount.toLocaleString()} />
            <Metric label="预计分段" value={estimate.chunkCount.toLocaleString()} />
            <Metric label="阅读总时长" value={formatDuration(estimate.readingSeconds)} />
          </div>
          <div className="chunk-plan">
            <strong>分段处理</strong>
            <span>当前文本会拆为 {estimate.chunkCount} 段；分镜阶段会按段流式返回，生成一段显示一段。</span>
          </div>
          {generationProgress && (
            <div className="stream-progress">
              <div>
                <strong>{renderProgressTitle(generationProgress.phase)}</strong>
                <span>{generationProgress.completedChunks}/{generationProgress.chunkTotal} 段 · {generationProgress.completedShots} 个镜头</span>
              </div>
              {isGenerating && (
                <p className="progress-heartbeat">
                  已运行 {generationClock.elapsedSeconds} 秒 · 距离上次后端事件 {generationClock.idleSeconds} 秒
                  {generationClock.idleSeconds >= 30 ? " · 正在等待模型或网关返回，请继续观察或取消后重试" : ""}
                </p>
              )}
              <div className="progress-track">
                <span style={{ width: `${getProgressPercent(generationProgress)}%` }} />
              </div>
            </div>
          )}
          {resumeState && (
            <div className="resume-panel">
              <div>
                <strong>{resumeState.phase === "analysis" ? "可重新尝试理解" : "可继续重试分镜"}</strong>
                <span>
                  {resumeState.phase === "analysis"
                    ? `理解阶段在第 ${resumeState.startChunkIndex + 1}/${resumeState.chunkTotal} 段中断；会保留当前文本和设置，重新尝试理解。`
                    : `从第 ${resumeState.startChunkIndex + 1}/${resumeState.chunkTotal} 段继续，保留已生成的 ${resumeState.completedShots} 个镜头。`}
                </span>
              </div>
              <button className="secondary" onClick={retryFailedStoryboard} disabled={isGenerating || (resumeState.phase === "storyboard" && !analysis)}>
                {isGenerating ? <Loader2 className="spin" size={17} /> : <RotateCcw size={17} />}
                {resumeState.phase === "analysis" ? "重新尝试理解" : "继续重试"}
              </button>
            </div>
          )}
          <div className="actions">
            <button className="primary" onClick={runGeneration} disabled={isGenerating || connectionStatus === "checking"}>
              {isGenerating ? <Loader2 className="spin" size={18} /> : <WandSparkles size={18} />}
              {isGenerating ? "创作中" : "开始创作"}
            </button>
            {isGenerating && (
              <button className="secondary ghost" onClick={cancelGeneration} type="button">
                <Square size={16} />
                取消
              </button>
            )}
            <span className="status">{status}</span>
          </div>
          {settings.language === "en" && (
            <div className="translation-panel">
              <div className="panel-head">
                <div>
                  <p className="eyebrow">Chinese Reference</p>
                  <h2>中文译文</h2>
                </div>
                <button
                  className="icon-button"
                  onClick={() => runTranslation(novelText.trim())}
                  disabled={isTranslating || novelText.trim().length < 1}
                  title="重新翻译"
                >
                  {isTranslating ? <Loader2 className="spin" size={18} /> : <Languages size={18} />}
                </button>
              </div>
              <textarea
                value={isTranslating && !translatedText ? "正在翻译为中文..." : translatedText}
                onChange={(event) => setTranslatedText(event.target.value)}
                placeholder={config?.hasApiKey ? "英文正文会自动翻译成中文，方便对照查看。" : "配置 API Key 后会自动生成中文译文。"}
                spellCheck={false}
              />
            </div>
          )}
        </div>

        <aside className="insight-panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Understanding Skill</p>
              <h2>理解档案</h2>
            </div>
            <button
              className="icon-button"
              type="button"
              onClick={() => setIsAnalysisExpanded((value) => !value)}
              title={isAnalysisExpanded ? "收起理解档案" : "展开理解档案"}
            >
              {isAnalysisExpanded ? <ChevronDown className="flip" size={18} /> : <ChevronDown size={18} />}
            </button>
          </div>
          <pre className={isAnalysisExpanded ? "expanded" : ""}>{summarizeAnalysis(analysis)}</pre>
        </aside>
      </section>

      <section className="report-band">
        <Metric label="镜头数" value={orderedShots.length.toString()} />
        <Metric label="目标分集" value={`${settings.episodeCount}集`} />
        <Metric label="画面总时长" value={formatDuration(totalVisualDuration)} />
        <Metric label="平均镜头" value={`${averageShotDuration.toFixed(1)}秒`} />
        <Metric label="拆句预览" value={`${splitSentences(novelText, settings.language).slice(0, 1)[0]?.slice(0, 18) ?? "无"}...`} />
        <div className="export-actions">
          <button onClick={downloadCsv} disabled={orderedShots.length === 0}>
            <Download size={17} /> CSV
          </button>
          <button onClick={downloadExcel} disabled={orderedShots.length === 0}>
            <FileSpreadsheet size={17} /> Excel
          </button>
          <button onClick={downloadCompletedExcelFiles} disabled={!projectHistory.some((project) => project.shots.length > 0)}>
            <FileSpreadsheet size={17} /> 已完成
          </button>
          <button onClick={downloadJson}>
            <FileJson size={17} /> JSON
          </button>
        </div>
      </section>

      <section className="history-panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Local History</p>
            <h2>文件队列与历史记录</h2>
          </div>
          <button className="secondary ghost compact-button" type="button" onClick={() => void refreshProjectHistory()}>
            <RefreshCw size={16} />
            刷新
          </button>
        </div>
        {projectHistory.length === 0 ? (
          <p className="history-empty">还没有历史记录。导入 TXT 或开始创作后会自动保存在本地。</p>
        ) : (
          <div className="history-list">
            {projectHistory.map((project) => (
              <div className={`history-item ${project.id === activeProjectId ? "active" : ""}`} key={project.id}>
                <button type="button" className="history-open" onClick={() => openProject(project)} disabled={isGenerating}>
                  <FileText size={18} />
                  <span>
                    <strong>{project.sourceFilename ?? project.title}</strong>
                    <small>{renderProjectMeta(project)}</small>
                  </span>
                </button>
                <div className="history-actions">
                  <button type="button" onClick={() => downloadProjectExcel(project)} disabled={project.shots.length === 0} title="导出同名 Excel">
                    <FileSpreadsheet size={16} />
                  </button>
                  <button type="button" onClick={() => void removeProject(project)} disabled={isGenerating} title="删除本地记录">
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

        <StoryboardTable shots={numberedShots} onChange={updateShot} />
    </main>
  );
}

function StoryboardTable({
  shots,
  onChange
}: {
  shots: ReturnType<typeof numberStoryboardShots>;
  onChange: (id: string, field: keyof StoryboardShot, value: string) => void;
}) {
  if (shots.length === 0) {
    return (
      <section className="empty">
        <Film size={30} />
        <h2>还没有分镜</h2>
        <p>输入小说后点击生成。表格会在这里显示旁白、落点句、画面描述、提示词和镜头秒数。</p>
      </section>
    );
  }

  return (
    <section className="table-wrap">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Storyboard Sheet</p>
          <h2>分镜表</h2>
        </div>
        <Play size={18} />
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>分集</th>
              <th>镜头</th>
              <th>旁白</th>
              <th>对白</th>
              <th>落点句</th>
              <th>画面描述</th>
              <th>镜头</th>
              <th>角色</th>
              <th>场景</th>
              <th>情绪</th>
              <th>镜头秒数</th>
            </tr>
          </thead>
          <tbody>
            {shots.map(({ shot, episodeShotNumber, globalShotNumber }) => (
              <React.Fragment key={shot.id}>
                <tr className="shot-main-row">
                  <td className="shot-index">{shot.episodeNumber}</td>
                  <td className="shot-index" title={`全片镜头 ${globalShotNumber}`}>{episodeShotNumber}</td>
                  <EditableText value={shot.narration} onChange={(value) => onChange(shot.id, "narration", value)} />
                  <EditableText value={formatDialogueLines(shot.dialogueLines)} onChange={(value) => onChange(shot.id, "dialogueLines", value)} />
                  <EditableText value={shot.anchorSentence} onChange={(value) => onChange(shot.id, "anchorSentence", value)} />
                  <EditableText value={shot.imageDescription} onChange={(value) => onChange(shot.id, "imageDescription", value)} />
                  <EditableInput value={shot.shotType} onChange={(value) => onChange(shot.id, "shotType", value)} />
                  <EditableInput value={shot.characters.join("、")} onChange={(value) => onChange(shot.id, "characters", value)} />
                  <EditableInput value={shot.scene} onChange={(value) => onChange(shot.id, "scene", value)} />
                  <EditableInput value={shot.emotion} onChange={(value) => onChange(shot.id, "emotion", value)} />
                  <td className="seconds">{shot.durationSeconds.toFixed(1)}</td>
                </tr>
                <tr className="prompt-row">
                  <td colSpan={11}>
                    <div className="prompt-stage">
                      <div className="prompt-stage-head">
                        <div>
                          <p className="eyebrow">Prompt Director Sheet</p>
                          <h3>
                            <Clapperboard size={18} />
                            第 {shot.episodeNumber} 集 · 镜头 {episodeShotNumber} 提示词
                          </h3>
                        </div>
                        <span>镜头 {shot.durationSeconds.toFixed(1)} 秒</span>
                      </div>
                      <textarea
                        className="prompt-textarea"
                        value={shot.prompt}
                        onChange={(event) => onChange(shot.id, "prompt", event.target.value)}
                      />
                    </div>
                  </td>
                </tr>
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function EditableText({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <td>
      <textarea className="cell-textarea" value={value} onChange={(event) => onChange(event.target.value)} />
    </td>
  );
}

function EditableInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <td>
      <input className="cell-input" value={value} onChange={(event) => onChange(event.target.value)} />
    </td>
  );
}

function Segmented({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="segmented-field">
      <span>{label}</span>
      <div className="segmented">
        {options.map((option) => (
          <button
            key={option.value}
            className={option.value === value ? "active" : ""}
            onClick={() => onChange(option.value)}
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatDialogueLines(lines: StoryboardShot["dialogueLines"]): string {
  return lines.map((line) => `${line.speaker}（${line.delivery}）：“${line.text}”`).join("\n");
}

function parseDialogueLines(value: string): StoryboardShot["dialogueLines"] {
  return value
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(.+?)（(.+?)）[：:][“"](.+?)[”"]$/);
      if (match) {
        return { speaker: match[1].trim(), delivery: match[2].trim(), text: match[3].trim() };
      }
      return { speaker: "未指明说话者", delivery: "平静+说", text: line.replace(/^["“]|["”]$/g, "") };
    });
}

function buildResumeState(
  errorMessage: string,
  progress: GenerationProgress | null,
  currentShots: StoryboardShot[]
): ResumeState | null {
  if (!progress || progress.phase === "done") return null;
  if (progress.phase === "analysis" || progress.phase === "analysis_merge") {
    const failedChunk = parseFailedAnalysisChunk(errorMessage);
    const startChunkIndex = Math.min(failedChunk ?? progress.completedChunks, progress.completedChunks);
    return {
      phase: "analysis",
      startChunkIndex: Math.max(0, startChunkIndex),
      chunkTotal: progress.chunkTotal,
      completedShots: currentShots.length,
      error: errorMessage
    };
  }
  if (progress.phase !== "storyboard") return null;
  const failedChunk = parseFailedStoryboardChunk(errorMessage);
  const startChunkIndex = Math.min(failedChunk ?? progress.completedChunks, progress.completedChunks);
  if (startChunkIndex >= progress.chunkTotal) return null;
  return {
    phase: "storyboard",
    startChunkIndex: Math.max(0, startChunkIndex),
    chunkTotal: progress.chunkTotal,
    completedShots: currentShots.length,
    error: errorMessage
  };
}

function formatGenerationError(message: string, resumeState: ResumeState | null): string {
  if (resumeState?.phase === "storyboard") {
    return `${message}\n已保留已生成镜头，可点击“继续重试”从第 ${resumeState.startChunkIndex + 1}/${resumeState.chunkTotal} 段继续分镜。`;
  }
  if (resumeState?.phase === "analysis") {
    return `${message}\n已保留当前文本和设置，可点击“重新尝试理解”重新发起理解阶段。`;
  }
  return message;
}

function parseFailedAnalysisChunk(message: string): number | null {
  const match = message.match(/理解阶段第\s*(\d+)\/(\d+)\s*段失败/);
  if (!match) return null;
  return Math.max(0, Number(match[1]) - 1);
}

function parseFailedStoryboardChunk(message: string): number | null {
  const match = message.match(/分镜阶段第\s*(\d+)\/(\d+)\s*段失败/);
  if (!match) return null;
  return Math.max(0, Number(match[1]) - 1);
}

function renderProgressTitle(phase: GenerationPhase): string {
  if (phase === "analysis") return "理解进度";
  if (phase === "analysis_merge") return "理解合并";
  if (phase === "storyboard") return "分镜流式生成";
  if (phase === "failed") return "生成中断";
  return "生成完成";
}

function getProgressPercent(progress: GenerationProgress): number {
  if (progress.phase === "failed") return Math.max(0, Math.min(100, Math.round((progress.completedChunks / Math.max(1, progress.chunkTotal)) * 100)));
  if (progress.phase === "done") return 100;
  const total = Math.max(1, progress.chunkTotal);
  return Math.min(100, Math.round((progress.completedChunks / total) * 100));
}

function getVisualStyleControlValue(style: string): string {
  return visualStyles.some((option) => option.value === style) ? style : "custom";
}

function isCustomVisualStyle(style: string): boolean {
  return getVisualStyleControlValue(style) === "custom";
}

function renderVisualStyleLabel(style: string): string {
  return visualStyles.find((option) => option.value === style)?.label ?? style;
}

function getScriptStyleControlValue(style: string): string {
  return scriptStyles.includes(style) ? style : "custom";
}

function isCustomScriptStyle(style: string): boolean {
  return getScriptStyleControlValue(style) === "custom";
}

function renderApiKeySource(config: ConfigResponse | null): string {
  if (!config) return "读取中";
  if (config.apiKeySource === "env") return "使用本地环境变量";
  if (config.apiKeySource === "runtime") return "使用页面配置";
  return "未配置 API Key";
}

function createProjectId(filename: string, timestamp: number): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `txt-${timestamp}-${sanitizeIdPart(filename)}-${random}`;
}

function sanitizeIdPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "file";
}

function inferProjectStatus(shots: StoryboardShot[], analysis: AnalysisResult | null): ProjectState["status"] {
  if (shots.length > 0) return "completed";
  if (analysis) return "generating";
  return "draft";
}

function renderProjectMeta(project: ProjectState): string {
  const updatedAt = new Date(project.updatedAt).toLocaleString();
  return `${renderProjectStatus(project)} · ${project.shots.length} 镜头 · ${updatedAt}`;
}

function renderProjectStatus(project: ProjectState): string {
  if (project.status === "failed") return "失败";
  if (project.shots.length > 0 || project.status === "completed") return "已完成";
  if (project.analysis || project.status === "generating") return "处理中";
  return "草稿";
}

function clampInteger(value: string, min: number, max: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

function readSavedApiConfig(): SavedApiConfig | null {
  try {
    const raw = window.localStorage.getItem(API_CONFIG_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedApiConfig>;
    if (!parsed.model || !parsed.apiKey) return null;
    return {
      model: parsed.model,
      apiKey: parsed.apiKey,
      baseURL: parsed.baseURL ?? ""
    };
  } catch {
    return null;
  }
}

function saveApiConfig(config: SavedApiConfig): void {
  window.localStorage.setItem(API_CONFIG_STORAGE_KEY, JSON.stringify(config));
}

function detectLanguageMode(text: string): StorySettings["language"] | null {
  const clean = text.trim();
  if (clean.length < 80) return null;

  const cjkCount = clean.match(/[\u4e00-\u9fa5]/g)?.length ?? 0;
  const latinWordCount = clean.match(/[A-Za-z]+(?:['-][A-Za-z]+)?/g)?.length ?? 0;

  if (latinWordCount >= 40 && latinWordCount > cjkCount * 2) return "en";
  if (cjkCount >= 40 && cjkCount > latinWordCount) return "zh";
  return null;
}

function buildProject(
  settings: StorySettings,
  novelText: string,
  translatedText: string,
  analysis: AnalysisResult | null,
  shots: StoryboardShot[],
  metadata: Partial<Pick<ProjectState, "id" | "title" | "sourceFilename" | "createdAt" | "status" | "lastError">> = {}
): ProjectState {
  return {
    id: metadata.id ?? "local-main",
    title: metadata.title ?? deriveProjectTitleFromFilename(metadata.sourceFilename ?? "解说剧分镜项目"),
    sourceFilename: metadata.sourceFilename,
    settings,
    novelText,
    translatedText,
    analysis,
    shots,
    updatedAt: Date.now(),
    createdAt: metadata.createdAt,
    status: metadata.status,
    lastError: metadata.lastError
  };
}

function downloadFile(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

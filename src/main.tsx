import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertCircle,
  CheckCircle2,
  Languages,
  Clapperboard,
  Eye,
  EyeOff,
  Download,
  FileJson,
  Film,
  Loader2,
  Play,
  RefreshCw,
  Save,
  Settings2,
  Square,
  WandSparkles
} from "lucide-react";
import { fetchConfig, fetchModels, generateStoryboardStream, translateNovel, updateConfig } from "./api";
import { loadLatestProject, saveProject } from "./storage";
import { projectToJson, storyboardToCsv, summarizeAnalysis } from "./shared/export";
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
  ScriptStyle,
  StorySettings,
  StoryboardShot,
  VisualStyle
} from "./shared/types";
import "./styles.css";

const scriptStyles: ScriptStyle[] = ["爽文", "悬疑", "言情", "玄幻", "都市", "恐怖"];
const visualStyles: Array<{ value: VisualStyle; label: string }> = [
  { value: "2D", label: "2D" },
  { value: "3D", label: "3D" },
  { value: "photoreal", label: "仿真人" }
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
type GenerationPhase = "analysis" | "analysis_merge" | "storyboard" | "done";

interface GenerationProgress {
  phase: GenerationPhase;
  chunkTotal: number;
  completedChunks: number;
  completedShots: number;
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
  const [restored, setRestored] = useState(false);

  const estimate = useMemo(
    () => estimateNovel(novelText, settings.language, settings.readingRate, settings.readingRateUnit),
    [novelText, settings]
  );

  const recalculatedShots = useMemo(
    () => recalculateShotDurations(shots, settings.language, settings.readingRate, settings.readingRateUnit, settings.episodeCount),
    [shots, settings.language, settings.readingRate, settings.readingRateUnit, settings.episodeCount]
  );

  const totalShotDuration = recalculatedShots.reduce((sum, shot) => sum + shot.durationSeconds, 0);
  const averageShotDuration = recalculatedShots.length > 0 ? totalShotDuration / recalculatedShots.length : 0;

  useEffect(() => {
    initializeConfig().catch((err: Error) => setError(err.message));

    loadLatestProject().then((project) => {
      if (!project) return;
      setSettings({ ...defaultSettings, ...project.settings });
      setNovelText(project.novelText);
      setTranslatedText(project.translatedText ?? "");
      setAnalysis(project.analysis);
      setShots(project.shots);
      setRestored(true);
    });
  }, []);

  useEffect(() => {
    const project = buildProject(settings, novelText, translatedText, analysis, shots);
    const timer = window.setTimeout(() => {
      saveProject(project).catch((err) => console.warn("保存项目失败", err));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [settings, novelText, translatedText, analysis, shots]);

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

  function updateSettings(patch: Partial<StorySettings>) {
    setSettings((current) => ({ ...current, ...patch }));
  }

  function handleNovelTextChange(value: string) {
    setNovelText(value);
    setAnalysis(null);
    setShots([]);
    setGenerationProgress(null);

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
      setAnalysis(null);
      setShots([]);
      setGenerationProgress({
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
          if (event.type === "started") {
            setGenerationProgress({
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
            setGenerationProgress((current) => ({
              phase: "analysis",
              chunkTotal: event.chunkTotal,
              completedChunks: event.completedChunks,
              completedShots: current?.completedShots ?? 0
            }));
            setStatus(`理解阶段：${event.completedChunks}/${event.chunkTotal} 段`);
          }
          if (event.type === "analysis_merge") {
            setGenerationProgress((current) => current ? { ...current, phase: "analysis_merge" } : current);
            setStatus(`理解合并：${event.completedBatches}/${event.totalBatches} 批`);
          }
          if (event.type === "analysis_completed") {
            setAnalysis(event.analysis);
            setStatus("理解完成，开始生成分镜");
          }
          if (event.type === "storyboard_started") {
            setGenerationProgress((current) => ({
              phase: "storyboard",
              chunkTotal: event.chunkTotal,
              completedChunks: 0,
              completedShots: current?.completedShots ?? 0
            }));
            setStatus(`分镜阶段：0/${event.chunkTotal} 段`);
          }
          if (event.type === "storyboard_chunk") {
            setShots((current) => [...current, ...event.shots]);
            setGenerationProgress({
              phase: "storyboard",
              chunkTotal: event.chunkTotal,
              completedChunks: event.completedChunks,
              completedShots: event.completedShots
            });
            setStatus(`分镜阶段：${event.completedChunks}/${event.chunkTotal} 段，已生成 ${event.completedShots} 个镜头`);
          }
          if (event.type === "done") {
            setShots(event.shots);
            setGenerationProgress((current) => current ? { ...current, phase: "done", completedShots: event.totalShots } : current);
            setStatus(`完成：生成 ${event.totalShots} 个镜头`);
          }
        },
        controller.signal
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setStatus("已取消生成，已保留当前结果");
      } else {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("生成失败，已保留当前结果");
      }
    } finally {
      setIsGenerating(false);
      setGenerationAbort(null);
    }
  }

  function cancelGeneration() {
    generationAbort?.abort();
  }

  function updateShot(id: string, field: keyof StoryboardShot, value: string) {
    setShots((current) =>
      current.map((shot) => {
        if (shot.id !== id) return shot;
        if (field === "characters") {
          return { ...shot, characters: value.split(/[、,，]/).map((item) => item.trim()).filter(Boolean) };
        }
        if (field === "durationSeconds") {
          return { ...shot, durationSeconds: Number(value) || 0 };
        }
        return { ...shot, [field]: value };
      })
    );
  }

  function downloadCsv() {
    downloadFile("storyboard.csv", storyboardToCsv(recalculatedShots), "text/csv;charset=utf-8");
  }

  function downloadJson() {
    downloadFile("storyboard-project.json", projectToJson(buildProject(settings, novelText, translatedText, analysis, recalculatedShots)), "application/json");
  }

  function resetSample() {
    setNovelText(sampleText);
    setTranslatedText("");
    setAnalysis(null);
    setShots([]);
    setGenerationProgress(null);
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
          value={settings.visualStyle}
          options={visualStyles}
          onChange={(value) => updateSettings({ visualStyle: value as VisualStyle })}
        />
        <label className="field">
          <span>剧本风格</span>
          <select value={settings.scriptStyle} onChange={(event) => updateSettings({ scriptStyle: event.target.value as ScriptStyle })}>
            {scriptStyles.map((style) => <option key={style}>{style}</option>)}
          </select>
        </label>
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
              <h2>小说正文</h2>
            </div>
            <button className="icon-button" onClick={resetSample} title="载入示例">
              <RefreshCw size={18} />
            </button>
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
              <div className="progress-track">
                <span style={{ width: `${getProgressPercent(generationProgress)}%` }} />
              </div>
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
            <Save size={18} />
          </div>
          <pre>{summarizeAnalysis(analysis)}</pre>
        </aside>
      </section>

      <section className="report-band">
        <Metric label="镜头数" value={recalculatedShots.length.toString()} />
        <Metric label="目标分集" value={`${settings.episodeCount}集`} />
        <Metric label="镜头总时长" value={formatDuration(totalShotDuration)} />
        <Metric label="平均镜头" value={`${averageShotDuration.toFixed(1)}秒`} />
        <Metric label="拆句预览" value={`${splitSentences(novelText, settings.language).slice(0, 1)[0]?.slice(0, 18) ?? "无"}...`} />
        <div className="export-actions">
          <button onClick={downloadCsv} disabled={recalculatedShots.length === 0}>
            <Download size={17} /> CSV
          </button>
          <button onClick={downloadJson}>
            <FileJson size={17} /> JSON
          </button>
        </div>
      </section>

      <StoryboardTable shots={recalculatedShots} onChange={updateShot} />
    </main>
  );
}

function StoryboardTable({
  shots,
  onChange
}: {
  shots: StoryboardShot[];
  onChange: (id: string, field: keyof StoryboardShot, value: string) => void;
}) {
  if (shots.length === 0) {
    return (
      <section className="empty">
        <Film size={30} />
        <h2>还没有分镜</h2>
        <p>输入小说后点击生成。表格会在这里显示旁白、落点句、画面描述、提示词和时长。</p>
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
              <th>落点句</th>
              <th>画面描述</th>
              <th>镜头</th>
              <th>角色</th>
              <th>场景</th>
              <th>情绪</th>
              <th>秒</th>
            </tr>
          </thead>
          <tbody>
            {shots.map((shot) => (
              <React.Fragment key={shot.id}>
                <tr className="shot-main-row">
                  <td className="shot-index">{shot.episodeNumber}</td>
                  <td className="shot-index">{shot.index}</td>
                  <EditableText value={shot.narration} onChange={(value) => onChange(shot.id, "narration", value)} />
                  <EditableText value={shot.anchorSentence} onChange={(value) => onChange(shot.id, "anchorSentence", value)} />
                  <EditableText value={shot.imageDescription} onChange={(value) => onChange(shot.id, "imageDescription", value)} />
                  <EditableInput value={shot.shotType} onChange={(value) => onChange(shot.id, "shotType", value)} />
                  <EditableInput value={shot.characters.join("、")} onChange={(value) => onChange(shot.id, "characters", value)} />
                  <EditableInput value={shot.scene} onChange={(value) => onChange(shot.id, "scene", value)} />
                  <EditableInput value={shot.emotion} onChange={(value) => onChange(shot.id, "emotion", value)} />
                  <td className="seconds">{shot.durationSeconds.toFixed(1)}</td>
                </tr>
                <tr className="prompt-row">
                  <td colSpan={10}>
                    <div className="prompt-stage">
                      <div className="prompt-stage-head">
                        <div>
                          <p className="eyebrow">Prompt Director Sheet</p>
                          <h3>
                            <Clapperboard size={18} />
                            第 {shot.episodeNumber} 集 · 镜头 {shot.index} 提示词
                          </h3>
                        </div>
                        <span>{shot.durationSeconds.toFixed(1)} 秒</span>
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

function renderProgressTitle(phase: GenerationPhase): string {
  if (phase === "analysis") return "理解进度";
  if (phase === "analysis_merge") return "理解合并";
  if (phase === "storyboard") return "分镜流式生成";
  return "生成完成";
}

function getProgressPercent(progress: GenerationProgress): number {
  if (progress.phase === "done") return 100;
  const total = Math.max(1, progress.chunkTotal);
  return Math.min(100, Math.round((progress.completedChunks / total) * 100));
}

function renderApiKeySource(config: ConfigResponse | null): string {
  if (!config) return "读取中";
  if (config.apiKeySource === "env") return "使用本地环境变量";
  if (config.apiKeySource === "runtime") return "使用页面配置";
  return "未配置 API Key";
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
  shots: StoryboardShot[]
): ProjectState {
  return {
    id: "local-main",
    title: "解说剧分镜项目",
    settings,
    novelText,
    translatedText,
    analysis,
    shots,
    updatedAt: Date.now()
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

export const DEFAULT_MODEL = "gpt-6.1-sol";

export interface PreferredModelSelection {
  model: string;
  useCustomModel: boolean;
}

export function selectPreferredModel(models: string[], currentModel: string): PreferredModelSelection {
  const availableModels = [...new Set(models.map((model) => model.trim()).filter(Boolean))];
  const exactPreferred = availableModels.find((model) => model.toLowerCase() === DEFAULT_MODEL);
  if (exactPreferred) return { model: exactPreferred, useCustomModel: false };

  const compatiblePreferred = availableModels.find((model) => /(?:^|[/_-])gpt-6\.1-sol(?:$|[/_-])/i.test(model));
  if (compatiblePreferred) return { model: compatiblePreferred, useCustomModel: false };

  const sol6 = availableModels.find((model) => model.toLowerCase() === "gpt-6-sol");
  if (sol6) return { model: sol6, useCustomModel: false };

  const cleanCurrentModel = currentModel.trim();
  const listedCurrentModel = availableModels.find((model) => model === cleanCurrentModel);
  if (listedCurrentModel) return { model: listedCurrentModel, useCustomModel: false };
  if (cleanCurrentModel) return { model: cleanCurrentModel, useCustomModel: true };

  return { model: availableModels[0] ?? DEFAULT_MODEL, useCustomModel: availableModels.length === 0 };
}

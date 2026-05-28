export function deriveProjectTitleFromFilename(filename: string): string {
  const cleanName = filename.trim().replace(/\.[^.\\/]+$/, "");
  return cleanName || "storyboard";
}

export function sanitizeDownloadBaseName(value: string): string {
  const safeName = deriveProjectTitleFromFilename(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/_+/g, "_")
    .trim()
    .replace(/^\.+$/, "");
  return safeName || "storyboard";
}

export function buildDownloadFilename(sourceName: string | undefined, extension: string): string {
  const normalizedExtension = extension.replace(/^\.+/, "") || "txt";
  return `${sanitizeDownloadBaseName(sourceName || "storyboard")}.${normalizedExtension}`;
}

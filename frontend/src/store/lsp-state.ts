import { createSignal, createEffect } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import { lspApi, type LspDiagnostic, type LspDiagnosticEvent, type LspServerInfo } from "@/api/lsp";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FileDiagnostics {
  uri: string;
  diagnostics: LspDiagnostic[];
}

// ─── State ──────────────────────────────────────────────────────────────────

const [servers, setServers] = createSignal<Record<string, string>>({}); // language -> serverId
const [diagnosticsByFile, setDiagnosticsByFile] = createSignal<Record<string, LspDiagnostic[]>>({});
const [availableServers, setAvailableServers] = createSignal<LspServerInfo[]>([]);
const [initialized, setInitialized] = createSignal(false);

// ─── Language mapping ───────────────────────────────────────────────────────

const EXT_TO_LSP_LANGUAGE: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "typescript", jsx: "typescript",
  mjs: "typescript", mts: "typescript", cjs: "typescript", cts: "typescript",
  rs: "rust",
  py: "python",
  go: "go",
  c: "c_cpp", cpp: "c_cpp", cc: "c_cpp", h: "c_cpp", hpp: "c_cpp",
};

const LANGUAGE_TO_LSP_ID: Record<string, string> = {
  typescript: "typescript",
  rust: "rust",
  python: "python",
  go: "go",
  c_cpp: "c_cpp",
};

export function getLspLanguageForFile(filePath: string): string | null {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_LSP_LANGUAGE[ext] ?? null;
}

export function getLspLanguageId(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  if (["ts", "tsx"].includes(ext)) return "typescript";
  if (["js", "jsx", "mjs", "cjs"].includes(ext)) return "javascript";
  if (ext === "rs") return "rust";
  if (ext === "py") return "python";
  if (ext === "go") return "go";
  if (["c", "h"].includes(ext)) return "c";
  if (["cpp", "cc", "hpp", "cxx"].includes(ext)) return "cpp";
  return "plaintext";
}

// ─── Actions ────────────────────────────────────────────────────────────────

/** Detect available LSP servers on the system */
export async function detectLspServers() {
  try {
    const servers = await lspApi.detectServers();
    setAvailableServers(servers);
    setInitialized(true);
  } catch {
    setInitialized(true);
  }
}

/** Start an LSP server for a language if not already running */
export async function ensureLspServer(language: string, rootPath: string): Promise<string | null> {
  const existing = servers()[language];
  if (existing) return existing;

  // Check if this language has an available server
  const available = availableServers().find(
    (s) => s.language === language && s.installed,
  );
  if (!available) return null;

  try {
    const serverId = await lspApi.startServer(language, rootPath);
    setServers((prev) => ({ ...prev, [language]: serverId }));

    // Listen for diagnostics from this server
    listen<LspDiagnosticEvent>(`lsp-diagnostics:${serverId}`, (evt) => {
      const { uri, diagnostics } = evt.payload;
      setDiagnosticsByFile((prev) => ({ ...prev, [uri]: diagnostics }));
    });

    return serverId;
  } catch (e) {
    console.warn(`Failed to start LSP for ${language}:`, e);
    return null;
  }
}

/** Notify LSP that a file was opened */
export async function notifyFileOpened(filePath: string, content: string, rootPath: string) {
  const language = getLspLanguageForFile(filePath);
  if (!language) return;

  const serverId = await ensureLspServer(language, rootPath);
  if (!serverId) return;

  const languageId = getLspLanguageId(filePath);
  try {
    await lspApi.didOpen(serverId, filePath, content, languageId);
  } catch {
    // Silently fail
  }
}

/** Notify LSP that a file was closed */
export async function notifyFileClosed(filePath: string) {
  const language = getLspLanguageForFile(filePath);
  if (!language) return;
  const serverId = servers()[language];
  if (!serverId) return;
  try {
    await lspApi.didClose(serverId, filePath);
  } catch {
    // Silently fail
  }
}

/** Get hover info for a position */
export async function getHoverInfo(
  filePath: string,
  line: number,
  character: number,
): Promise<string | null> {
  const language = getLspLanguageForFile(filePath);
  if (!language) return null;
  const serverId = servers()[language];
  if (!serverId) return null;
  try {
    return await lspApi.hover(serverId, filePath, line, character);
  } catch {
    return null;
  }
}

/** Go to definition */
export async function gotoDefinition(
  filePath: string,
  line: number,
  character: number,
): Promise<{ uri: string; line: number; character: number } | null> {
  const language = getLspLanguageForFile(filePath);
  if (!language) return null;
  const serverId = servers()[language];
  if (!serverId) return null;
  try {
    const locations = await lspApi.gotoDefinition(serverId, filePath, line, character);
    if (locations.length === 0) return null;
    const loc = locations[0];
    // Convert file:// URI to path
    const uri = loc.uri.startsWith("file://") ? loc.uri.slice(7) : loc.uri;
    return { uri, line: loc.range_start_line, character: loc.range_start_char };
  } catch {
    return null;
  }
}

// ─── Exports ────────────────────────────────────────────────────────────────

export function getDiagnosticsForFile(filePath: string): LspDiagnostic[] {
  // Try both with and without file:// prefix
  const byUri = diagnosticsByFile();
  return byUri[`file://${filePath}`] ?? byUri[filePath] ?? [];
}

export { servers, diagnosticsByFile, availableServers, initialized };

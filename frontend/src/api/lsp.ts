import { invoke } from "@tauri-apps/api/core";

export interface LspServerInfo {
  language: string;
  command: string;
  args: string[];
  installed: boolean;
}

export interface LspLocation {
  uri: string;
  range_start_line: number;
  range_start_char: number;
  range_end_line: number;
  range_end_char: number;
}

export interface LspDiagnostic {
  range_start_line: number;
  range_start_char: number;
  range_end_line: number;
  range_end_char: number;
  severity: number; // 1=error, 2=warning, 3=info, 4=hint
  message: string;
  source: string | null;
}

export interface LspDiagnosticEvent {
  server_id: string;
  uri: string;
  diagnostics: LspDiagnostic[];
}

export const lspApi = {
  detectServers(): Promise<LspServerInfo[]> {
    return invoke<LspServerInfo[]>("lsp_detect_servers");
  },

  startServer(language: string, rootPath: string): Promise<string> {
    return invoke<string>("lsp_start_server", { language, rootPath });
  },

  stopServer(serverId: string): Promise<void> {
    return invoke<void>("lsp_stop_server", { serverId });
  },

  hover(serverId: string, filePath: string, line: number, character: number): Promise<string | null> {
    return invoke<string | null>("lsp_hover", { serverId, filePath, line, character });
  },

  gotoDefinition(serverId: string, filePath: string, line: number, character: number): Promise<LspLocation[]> {
    return invoke<LspLocation[]>("lsp_goto_definition", { serverId, filePath, line, character });
  },

  didOpen(serverId: string, filePath: string, content: string, languageId: string): Promise<void> {
    return invoke<void>("lsp_did_open", { serverId, filePath, content, languageId });
  },

  didClose(serverId: string, filePath: string): Promise<void> {
    return invoke<void>("lsp_did_close", { serverId, filePath });
  },
};

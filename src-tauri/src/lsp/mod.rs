mod detect;
mod rpc;
mod server;

use std::sync::Arc;

use dashmap::DashMap;
use serde_json::Value;

pub use detect::{lsp_detect_servers_impl, LspServerInfo};
pub use server::LspServer;

pub struct LspState {
    pub servers: Arc<DashMap<String, LspServer>>,
}

impl LspState {
    pub fn new() -> Self {
        Self {
            servers: Arc::new(DashMap::new()),
        }
    }
}

// ─── Tauri commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn lsp_detect_servers() -> Vec<LspServerInfo> {
    lsp_detect_servers_impl()
}

#[tauri::command]
pub fn lsp_start_server(
    language: String,
    root_path: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<LspState>,
) -> Result<String, String> {
    // Look up the server info for this language
    let servers = lsp_detect_servers_impl();
    let info = servers
        .into_iter()
        .find(|s| s.language == language && s.installed)
        .ok_or_else(|| format!("No installed LSP server found for language '{}'", language))?;

    let server_id = uuid::Uuid::new_v4().to_string();

    let server = LspServer::start(
        &info.command,
        &info.args,
        &root_path,
        &server_id,
        app_handle,
    )?;

    state.servers.insert(server_id.clone(), server);

    Ok(server_id)
}

#[tauri::command]
pub fn lsp_stop_server(server_id: String, state: tauri::State<LspState>) -> Result<(), String> {
    let (_, server) = state
        .servers
        .remove(&server_id)
        .ok_or_else(|| format!("LSP server '{}' not found", server_id))?;

    server.shutdown();
    Ok(())
}

#[tauri::command]
pub fn lsp_hover(
    server_id: String,
    file_path: String,
    line: u32,
    character: u32,
    state: tauri::State<LspState>,
) -> Result<Value, String> {
    let server = state
        .servers
        .get(&server_id)
        .ok_or_else(|| format!("LSP server '{}' not found", server_id))?;

    let uri = format!("file://{}", file_path);
    let params = serde_json::json!({
        "textDocument": { "uri": uri },
        "position": { "line": line, "character": character },
    });

    let response = server.send_request("textDocument/hover", params)?;

    // Extract the result field from the response
    Ok(response.get("result").cloned().unwrap_or(Value::Null))
}

#[tauri::command]
pub fn lsp_goto_definition(
    server_id: String,
    file_path: String,
    line: u32,
    character: u32,
    state: tauri::State<LspState>,
) -> Result<Value, String> {
    let server = state
        .servers
        .get(&server_id)
        .ok_or_else(|| format!("LSP server '{}' not found", server_id))?;

    let uri = format!("file://{}", file_path);
    let params = serde_json::json!({
        "textDocument": { "uri": uri },
        "position": { "line": line, "character": character },
    });

    let response = server.send_request("textDocument/definition", params)?;

    Ok(response.get("result").cloned().unwrap_or(Value::Null))
}

#[tauri::command]
pub fn lsp_did_open(
    server_id: String,
    file_path: String,
    content: String,
    language_id: String,
    state: tauri::State<LspState>,
) -> Result<(), String> {
    let server = state
        .servers
        .get(&server_id)
        .ok_or_else(|| format!("LSP server '{}' not found", server_id))?;

    let uri = format!("file://{}", file_path);
    let params = serde_json::json!({
        "textDocument": {
            "uri": uri,
            "languageId": language_id,
            "version": 1,
            "text": content,
        },
    });

    server.send_notification("textDocument/didOpen", params)
}

#[tauri::command]
pub fn lsp_did_close(
    server_id: String,
    file_path: String,
    state: tauri::State<LspState>,
) -> Result<(), String> {
    let server = state
        .servers
        .get(&server_id)
        .ok_or_else(|| format!("LSP server '{}' not found", server_id))?;

    let uri = format!("file://{}", file_path);
    let params = serde_json::json!({
        "textDocument": { "uri": uri },
    });

    server.send_notification("textDocument/didClose", params)
}

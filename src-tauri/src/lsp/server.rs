use std::collections::HashMap;
use std::io::{BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tauri::Emitter;

use super::rpc;

#[derive(serde::Serialize, Clone)]
pub struct DiagnosticEvent {
    pub server_id: String,
    pub uri: String,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(serde::Serialize, Clone)]
pub struct Diagnostic {
    pub range_start_line: u32,
    pub range_start_char: u32,
    pub range_end_line: u32,
    pub range_end_char: u32,
    pub severity: u8,
    pub message: String,
    pub source: Option<String>,
}

type PendingMap = Arc<Mutex<HashMap<u64, std::sync::mpsc::Sender<Value>>>>;

pub struct LspServer {
    pub process: Mutex<Child>,
    pub stdin: Mutex<ChildStdin>,
    pub request_id: AtomicU64,
    pub pending: PendingMap,
    pub language: String,
    pub root_path: String,
}

impl LspServer {
    pub fn start(
        command: &str,
        args: &[String],
        root_path: &str,
        server_id: &str,
        app_handle: tauri::AppHandle,
    ) -> Result<Self, String> {
        let mut child = Command::new(command)
            .args(args)
            .current_dir(root_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to spawn {}: {}", command, e))?;

        let stdin = child.stdin.take().ok_or("Failed to capture stdin")?;
        let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;

        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));

        // Spawn reader thread
        let reader_pending = pending.clone();
        let reader_server_id = server_id.to_string();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let msg = match rpc::decode_message(&mut reader) {
                    Some(m) => m,
                    None => break, // EOF or error
                };

                // Check if this is a response (has "id" and no "method")
                if let Some(id) = msg.get("id").and_then(|v| v.as_u64()) {
                    if msg.get("method").is_none() {
                        // This is a response to a request
                        let sender = {
                            let mut map = match reader_pending.lock() {
                                Ok(m) => m,
                                Err(_) => break,
                            };
                            map.remove(&id)
                        };
                        if let Some(tx) = sender {
                            let _ = tx.send(msg);
                        }
                        continue;
                    }
                }

                // Check if this is a notification
                if let Some(method) = msg.get("method").and_then(|v| v.as_str()) {
                    if method == "textDocument/publishDiagnostics" {
                        if let Some(params) = msg.get("params") {
                            let uri = params
                                .get("uri")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();

                            let diagnostics = params
                                .get("diagnostics")
                                .and_then(|v| v.as_array())
                                .map(|arr| {
                                    arr.iter()
                                        .map(|d| parse_diagnostic(d))
                                        .collect::<Vec<_>>()
                                })
                                .unwrap_or_default();

                            let event = DiagnosticEvent {
                                server_id: reader_server_id.clone(),
                                uri,
                                diagnostics,
                            };

                            let event_name =
                                format!("lsp-diagnostics:{}", reader_server_id);
                            let _ = app_handle.emit(&event_name, event);
                        }
                    }
                }
            }
        });

        let server = LspServer {
            process: Mutex::new(child),
            stdin: Mutex::new(stdin),
            request_id: AtomicU64::new(1),
            pending,
            language: command.to_string(),
            root_path: root_path.to_string(),
        };

        // Send initialize request
        let root_uri = format!("file://{}", root_path);
        let init_params = serde_json::json!({
            "processId": std::process::id(),
            "rootUri": root_uri,
            "rootPath": root_path,
            "capabilities": {
                "textDocument": {
                    "hover": { "contentFormat": ["markdown", "plaintext"] },
                    "definition": { "dynamicRegistration": false },
                    "publishDiagnostics": { "relatedInformation": true },
                    "synchronization": {
                        "didOpen": true,
                        "didClose": true,
                    },
                },
                "workspace": {
                    "workspaceFolders": true,
                },
            },
            "workspaceFolders": [{
                "uri": root_uri,
                "name": std::path::Path::new(root_path)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy(),
            }],
        });

        let _init_result = server.send_request("initialize", init_params)?;

        // Send initialized notification
        server.send_notification("initialized", serde_json::json!({}))?;

        Ok(server)
    }

    pub fn send_request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.request_id.fetch_add(1, Ordering::SeqCst);
        let msg = rpc::build_request(id, method, params);
        let encoded = rpc::encode_message(&msg);

        let (tx, rx) = std::sync::mpsc::channel();

        {
            let mut map = self.pending.lock().map_err(|e| e.to_string())?;
            map.insert(id, tx);
        }

        {
            let mut stdin = self.stdin.lock().map_err(|e| e.to_string())?;
            stdin.write_all(&encoded).map_err(|e| e.to_string())?;
            stdin.flush().map_err(|e| e.to_string())?;
        }

        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|e| format!("LSP request '{}' timed out or channel closed: {}", method, e))
    }

    pub fn send_notification(&self, method: &str, params: Value) -> Result<(), String> {
        let msg = rpc::build_notification(method, params);
        let encoded = rpc::encode_message(&msg);

        let mut stdin = self.stdin.lock().map_err(|e| e.to_string())?;
        stdin.write_all(&encoded).map_err(|e| e.to_string())?;
        stdin.flush().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn shutdown(&self) {
        // Try graceful shutdown
        let _ = self.send_request("shutdown", Value::Null);
        let _ = self.send_notification("exit", Value::Null);

        // Force kill if still running
        if let Ok(mut child) = self.process.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn parse_diagnostic(d: &Value) -> Diagnostic {
    let range = d.get("range").cloned().unwrap_or(Value::Null);
    let start = range.get("start").cloned().unwrap_or(Value::Null);
    let end = range.get("end").cloned().unwrap_or(Value::Null);

    Diagnostic {
        range_start_line: start.get("line").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        range_start_char: start
            .get("character")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32,
        range_end_line: end.get("line").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        range_end_char: end
            .get("character")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32,
        severity: d.get("severity").and_then(|v| v.as_u64()).unwrap_or(4) as u8,
        message: d
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        source: d
            .get("source")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    }
}

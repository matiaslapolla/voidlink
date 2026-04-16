pub mod highlight;

use std::collections::HashMap;
use std::sync::Mutex;

use ropey::Rope;
use serde::Serialize;

use highlight::{HighlightEngine, TokenizedLine};

// ─── Buffer ─────────────────────────────────────────────────────────────────

struct Buffer {
    rope: Rope,
    version: u64,
}

// ─── Manager ────────────────────────────────────────────────────────────────

pub struct BufferManager {
    buffers: HashMap<String, Buffer>,
    highlight_engine: HighlightEngine,
}

impl BufferManager {
    pub fn new() -> Self {
        Self {
            buffers: HashMap::new(),
            highlight_engine: HighlightEngine::new(),
        }
    }

    pub fn open(&mut self, path: &str) -> Result<(String, u64), String> {
        if let Some(buf) = self.buffers.get(path) {
            return Ok((buf.rope.to_string(), buf.version));
        }
        let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        let rope = Rope::from_str(&content);
        self.buffers
            .insert(path.to_string(), Buffer { rope, version: 0 });
        Ok((content, 0))
    }

    pub fn update(&mut self, path: &str, content: &str) -> u64 {
        if let Some(buf) = self.buffers.get_mut(path) {
            buf.rope = Rope::from_str(content);
            buf.version += 1;
            buf.version
        } else {
            let rope = Rope::from_str(content);
            self.buffers
                .insert(path.to_string(), Buffer { rope, version: 1 });
            1
        }
    }

    pub fn get_tokens(
        &self,
        path: &str,
        start_line: usize,
        end_line: usize,
        theme_mode: &str,
    ) -> Result<(Vec<TokenizedLine>, u64), String> {
        let buf = self.buffers.get(path).ok_or("Buffer not open")?;
        let tokens =
            self.highlight_engine
                .highlight_range(&buf.rope, path, start_line, end_line, theme_mode)?;
        Ok((tokens, buf.version))
    }

    pub fn save(&self, path: &str) -> Result<(), String> {
        let buf = self.buffers.get(path).ok_or("Buffer not open")?;
        std::fs::write(path, buf.rope.to_string()).map_err(|e| e.to_string())
    }

    pub fn close(&mut self, path: &str) {
        self.buffers.remove(path);
    }
}

// ─── State ─────────────────────────────────────────────────────────────────

pub struct BufferState(pub Mutex<BufferManager>);

impl BufferState {
    pub fn new() -> Self {
        Self(Mutex::new(BufferManager::new()))
    }
}

// ─── Result types ──────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct BufferOpenResult {
    pub content: String,
    pub version: u64,
}

#[derive(Serialize)]
pub struct BufferHighlightResult {
    pub lines: Vec<TokenizedLine>,
    pub version: u64,
}

// ─── Public API (no Tauri) ─────────────────────────────────────────────────

pub fn buffer_open(state: &BufferState, path: &str) -> Result<BufferOpenResult, String> {
    let mut mgr = state.0.lock().map_err(|e| e.to_string())?;
    let (content, version) = mgr.open(path)?;
    Ok(BufferOpenResult { content, version })
}

pub fn buffer_highlight(
    state: &BufferState,
    path: &str,
    content: &str,
    start_line: usize,
    end_line: usize,
    theme_mode: &str,
) -> Result<BufferHighlightResult, String> {
    let mut mgr = state.0.lock().map_err(|e| e.to_string())?;
    mgr.update(path, content);
    let (lines, version) = mgr.get_tokens(path, start_line, end_line, theme_mode)?;
    Ok(BufferHighlightResult { lines, version })
}

pub fn buffer_get_tokens(
    state: &BufferState,
    path: &str,
    start_line: usize,
    end_line: usize,
    theme_mode: &str,
) -> Result<BufferHighlightResult, String> {
    let mgr = state.0.lock().map_err(|e| e.to_string())?;
    let (lines, version) = mgr.get_tokens(path, start_line, end_line, theme_mode)?;
    Ok(BufferHighlightResult { lines, version })
}

pub fn buffer_save(state: &BufferState, path: &str, content: Option<&str>) -> Result<(), String> {
    let mut mgr = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(c) = content {
        mgr.update(path, c);
    }
    mgr.save(path)
}

pub fn buffer_close(state: &BufferState, path: &str) -> Result<(), String> {
    let mut mgr = state.0.lock().map_err(|e| e.to_string())?;
    mgr.close(path);
    Ok(())
}

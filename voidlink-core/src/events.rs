/// Trait for emitting events to the frontend (or any subscriber).
///
/// In the Tauri shell this is implemented via `AppHandle::emit()`.
/// In the egui desktop app this will use `mpsc` channels or similar.
pub trait EventEmitter: Send + Sync + 'static {
    /// Emit a named event with a JSON-serializable payload.
    fn emit(&self, event: &str, payload: serde_json::Value) -> Result<(), String>;

    /// Emit a named event with raw bytes (used for PTY output).
    fn emit_bytes(&self, event: &str, data: Vec<u8>) -> Result<(), String>;
}

/// No-op emitter for contexts where events are not needed (e.g. tests).
#[derive(Clone)]
pub struct NoopEmitter;

impl EventEmitter for NoopEmitter {
    fn emit(&self, _event: &str, _payload: serde_json::Value) -> Result<(), String> {
        Ok(())
    }
    fn emit_bytes(&self, _event: &str, _data: Vec<u8>) -> Result<(), String> {
        Ok(())
    }
}

use async_trait::async_trait;
use serde_json::Value;
use std::fs;
use std::path::Path;

#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    async fn execute(&self, args: Value) -> Result<Value, String>;
}

pub struct FilesystemTool;

#[async_trait]
impl Tool for FilesystemTool {
    fn name(&self) -> &str {
        "filesystem"
    }

    fn description(&self) -> &str {
        "Read and write files"
    }

    async fn execute(&self, args: Value) -> Result<Value, String> {
        let action = args.get("action")
            .and_then(|v| v.as_str())
            .ok_or("Action required")?;

        match action {
            "read" => {
                let path = args.get("path")
                    .and_then(|v| v.as_str())
                    .ok_or("Path required")?;

                let content = fs::read_to_string(Path::new(path))
                    .map_err(|e| format!("Failed to read file: {}", e))?;

                Ok(serde_json::json!({
                    "content": content,
                    "path": path
                }))
            }
            "write" => {
                let path = args.get("path")
                    .and_then(|v| v.as_str())
                    .ok_or("Path required")?;

                let content = args.get("content")
                    .and_then(|v| v.as_str())
                    .ok_or("Content required")?;

                fs::write(Path::new(path), content)
                    .map_err(|e| format!("Failed to write file: {}", e))?;

                Ok(serde_json::json!({
                    "success": true,
                    "path": path
                }))
            }
            _ => Err(format!("Unknown action: {}", action))
        }
    }
}

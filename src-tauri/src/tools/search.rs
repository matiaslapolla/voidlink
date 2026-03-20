use async_trait::async_trait;
use serde_json::Value;
use std::process::Command;

#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    async fn execute(&self, args: Value) -> Result<Value, String>;
}

pub struct SearchTool;

#[async_trait]
impl Tool for SearchTool {
    fn name(&self) -> &str {
        "search"
    }

    fn description(&self) -> &str {
        "Search the web for information"
    }

    async fn execute(&self, args: Value) -> Result<Value, String> {
        let query = args.get("query")
            .and_then(|v| v.as_str())
            .ok_or("Query required")?;

        let output = Command::new("ddgr")
            .args([&query, "--json", "-n", "5"])
            .output()
            .map_err(|e| format!("Failed to search: {}", e))?;

        let json_str = String::from_utf8(output.stdout)
            .map_err(|e| format!("Failed to parse output: {}", e))?;

        let results: Value = serde_json::from_str(&json_str)
            .map_err(|e| format!("Failed to parse JSON: {}", e))?;

        Ok(results)
    }
}

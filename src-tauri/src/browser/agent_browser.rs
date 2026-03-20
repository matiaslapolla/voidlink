use std::process::Command;

#[tauri::command]
async fn agent_browser_open(url: String) -> Result<String, String> {
    let output = Command::new("agent-browser")
        .args(&["open", &url])
        .output()
        .map_err(|e| format!("Failed to spawn agent-browser: {}", e))?;

    String::from_utf8(output.stdout)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn agent_browser_click(selector: String) -> Result<String, String> {
    let output = Command::new("agent-browser")
        .args(&["click", &selector])
        .output()
        .map_err(|e| e.to_string())?;

    Ok(String::from_utf8(output.stdout)?)
}

#[tauri::command]
async fn agent_browser_fill(
    selector: String,
    value: String,
) -> Result<String, String> {
    let output = Command::new("agent-browser")
        .args(&["fill", &selector, &value])
        .output()
        .map_err(|e| e.to_string())?;

    Ok(String::from_utf8(output.stdout)?)
}

#[tauri::command]
async fn agent_browser_snapshot() -> Result<serde_json::Value, String> {
    let output = Command::new("agent-browser")
        .args(&["snapshot", "--json"])
        .output()
        .map_err(|e| e.to_string())?;

    let json_str = String::from_utf8(output.stdout)?;
    let result: serde_json::Value = serde_json::from_str(&json_str)
        .map_err(|e| e.to_string())?;

    Ok(result)
}

#[tauri::command]
async fn agent_browser_screenshot(path: String) -> Result<String, String> {
    let output = Command::new("agent-browser")
        .args(&["screenshot", &path])
        .output()
        .map_err(|e| e.to_string())?;

    Ok(String::from_utf8(output.stdout)?)
}

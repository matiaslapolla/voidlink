use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const KEYRING_SERVICE: &str = "voidlink";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettings {
    pub active_provider: Option<String>,
    pub models: HashMap<String, String>,
}

fn settings_path() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME env var not set".to_string())?;
    Ok(std::path::PathBuf::from(home)
        .join(".voidlink")
        .join("provider_settings.json"))
}

pub fn save_api_key(provider: &str, key: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &format!("provider_{provider}"))
        .map_err(|e| e.to_string())?;
    if key.is_empty() {
        let _ = entry.delete_password();
    } else {
        entry.set_password(key).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn load_api_key(provider: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &format!("provider_{provider}"))
        .map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Ok(None),
    }
}

pub fn save_provider_settings(settings: &ProviderSettings) -> Result<(), String> {
    let path = settings_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

pub fn load_provider_settings() -> Result<ProviderSettings, String> {
    let path = settings_path()?;
    if !path.exists() {
        return Ok(ProviderSettings::default());
    }
    let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

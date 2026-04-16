use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::{json, Value};
use std::time::Duration;

use super::chunks::{deterministic_embedding, truncate_plain, DETERMINISTIC_EMBED_MODEL};
use super::path_utils::{first_env, first_env_or_default};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderKind {
    OpenAi,
    Anthropic,
    Gemini,
    Groq,
    Fireworks,
    OpenRouter,
    Ollama,
    Kimi,
    MiniMax,
}

impl ProviderKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderKind::OpenAi => "openai",
            ProviderKind::Anthropic => "anthropic",
            ProviderKind::Gemini => "gemini",
            ProviderKind::Groq => "groq",
            ProviderKind::Fireworks => "fireworks",
            ProviderKind::OpenRouter => "openrouter",
            ProviderKind::Ollama => "ollama",
            ProviderKind::Kimi => "kimi",
            ProviderKind::MiniMax => "minimax",
        }
    }

    pub fn from_name(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "openai" => Some(ProviderKind::OpenAi),
            "anthropic" => Some(ProviderKind::Anthropic),
            "gemini" => Some(ProviderKind::Gemini),
            "groq" => Some(ProviderKind::Groq),
            "fireworks" => Some(ProviderKind::Fireworks),
            "openrouter" => Some(ProviderKind::OpenRouter),
            "ollama" => Some(ProviderKind::Ollama),
            "kimi" | "moonshot" => Some(ProviderKind::Kimi),
            "minimax" => Some(ProviderKind::MiniMax),
            _ => None,
        }
    }

    pub fn default_model(self) -> &'static str {
        match self {
            ProviderKind::OpenAi => "gpt-4.1-mini",
            ProviderKind::Anthropic => "claude-sonnet-4-6",
            ProviderKind::Gemini => "gemini-2.5-flash",
            ProviderKind::Groq => "llama-3.3-70b-versatile",
            ProviderKind::Fireworks => "accounts/fireworks/models/llama-v3p3-70b-instruct",
            ProviderKind::OpenRouter => "openai/gpt-4.1-mini",
            ProviderKind::Ollama => "llama3.2",
            ProviderKind::Kimi => "kimi-k2.5",
            ProviderKind::MiniMax => "MiniMax-M2",
        }
    }

    fn from_env_or_auto() -> Self {
        if let Ok(raw) = std::env::var("VOIDLINK_LLM_PROVIDER") {
            if let Some(kind) = Self::from_name(&raw) {
                return kind;
            }
        }
        if std::env::var("VOIDLINK_OLLAMA_BASE_URL").is_ok()
            || std::env::var("OLLAMA_HOST").is_ok()
        {
            ProviderKind::Ollama
        } else if std::env::var("ANTHROPIC_API_KEY").is_ok() {
            ProviderKind::Anthropic
        } else if std::env::var("OPENROUTER_API_KEY").is_ok() {
            ProviderKind::OpenRouter
        } else if std::env::var("GROQ_API_KEY").is_ok() {
            ProviderKind::Groq
        } else if std::env::var("GEMINI_API_KEY").is_ok() {
            ProviderKind::Gemini
        } else if std::env::var("FIREWORKS_API_KEY").is_ok() {
            ProviderKind::Fireworks
        } else if std::env::var("KIMI_API_KEY").is_ok()
            || std::env::var("MOONSHOT_API_KEY").is_ok()
        {
            ProviderKind::Kimi
        } else if std::env::var("MINIMAX_API_KEY").is_ok() {
            ProviderKind::MiniMax
        } else {
            ProviderKind::OpenAi
        }
    }
}

// ─── Stored settings helpers ──────────────────────────────────────────────────

fn settings_json() -> Option<Value> {
    let home = std::env::var("HOME").ok()?;
    let path = std::path::PathBuf::from(home)
        .join(".voidlink")
        .join("provider_settings.json");
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn load_stored_active_provider() -> Option<ProviderKind> {
    let parsed = settings_json()?;
    let name = parsed.get("activeProvider")?.as_str()?;
    ProviderKind::from_name(name)
}

fn load_stored_model(provider: &str) -> Option<String> {
    let parsed = settings_json()?;
    parsed
        .get("models")?
        .get(provider)?
        .as_str()
        .map(|s| s.to_string())
}

fn get_keyring_api_key(provider: &str) -> Option<String> {
    let entry = keyring::Entry::new("voidlink", &format!("provider_{provider}")).ok()?;
    entry.get_password().ok()
}

fn get_env_api_key(kind: ProviderKind) -> Option<String> {
    match kind {
        ProviderKind::OpenAi => first_env(&["OPENAI_API_KEY"]),
        ProviderKind::Anthropic => first_env(&["ANTHROPIC_API_KEY"]),
        ProviderKind::Gemini => first_env(&["GEMINI_API_KEY", "GOOGLE_API_KEY"]),
        ProviderKind::Groq => first_env(&["GROQ_API_KEY"]),
        ProviderKind::Fireworks => first_env(&["FIREWORKS_API_KEY"]),
        ProviderKind::OpenRouter => first_env(&["OPENROUTER_API_KEY"]),
        ProviderKind::Ollama => first_env(&["OLLAMA_API_KEY"]),
        ProviderKind::Kimi => first_env(&["KIMI_API_KEY", "MOONSHOT_API_KEY"]),
        ProviderKind::MiniMax => first_env(&["MINIMAX_API_KEY"]),
    }
}

fn get_env_model(kind: ProviderKind) -> String {
    let default = kind.default_model();
    match kind {
        ProviderKind::OpenAi => first_env_or_default(&["VOIDLINK_OPENAI_MODEL"], default),
        ProviderKind::Anthropic => first_env_or_default(&["VOIDLINK_ANTHROPIC_MODEL"], default),
        ProviderKind::Gemini => first_env_or_default(&["VOIDLINK_GEMINI_MODEL"], default),
        ProviderKind::Groq => first_env_or_default(&["VOIDLINK_GROQ_MODEL"], default),
        ProviderKind::Fireworks => first_env_or_default(&["VOIDLINK_FIREWORKS_MODEL"], default),
        ProviderKind::OpenRouter => first_env_or_default(&["VOIDLINK_OPENROUTER_MODEL"], default),
        ProviderKind::Ollama => first_env_or_default(&["VOIDLINK_OLLAMA_MODEL"], default),
        ProviderKind::Kimi => first_env_or_default(&["VOIDLINK_KIMI_MODEL"], default),
        ProviderKind::MiniMax => first_env_or_default(&["VOIDLINK_MINIMAX_MODEL"], default),
    }
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct EmbeddingOutput {
    pub model_id: String,
    pub vectors: Vec<Vec<f32>>,
}

#[derive(Clone)]
pub struct ProviderAdapter {
    kind: ProviderKind,
    model: String,
    embedding_model: Option<String>,
    api_key: Option<String>,
    base_url: String,
    client: Client,
    extra_headers: HeaderMap,
    supports_response_format: bool,
    uses_anthropic_format: bool,
}

impl ProviderAdapter {
    pub fn new() -> Self {
        // Prefer stored settings (keyring API key + saved model/provider)
        if let Some(kind) = load_stored_active_provider() {
            let api_key = get_keyring_api_key(kind.as_str())
                .or_else(|| get_env_api_key(kind));
            let model = load_stored_model(kind.as_str())
                .unwrap_or_else(|| get_env_model(kind));
            return Self::build(kind, api_key, model);
        }

        // Fall back to env var detection
        let kind = ProviderKind::from_env_or_auto();
        let api_key = get_env_api_key(kind);
        let model = get_env_model(kind);
        Self::build(kind, api_key, model)
    }

    fn build(kind: ProviderKind, api_key: Option<String>, model: String) -> Self {
        let timeout_secs = first_env(&["VOIDLINK_LLM_TIMEOUT_SECS"])
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(30);
        let client = Client::builder()
            .timeout(Duration::from_secs(timeout_secs))
            .build()
            .unwrap_or_else(|_| Client::new());

        match kind {
            ProviderKind::OpenAi => Self {
                kind,
                model,
                embedding_model: Some(first_env_or_default(
                    &["VOIDLINK_OPENAI_EMBED_MODEL"],
                    "text-embedding-3-small",
                )),
                api_key,
                base_url: first_env_or_default(
                    &["VOIDLINK_OPENAI_BASE_URL"],
                    "https://api.openai.com/v1",
                )
                .trim_end_matches('/')
                .to_string(),
                client,
                extra_headers: HeaderMap::new(),
                supports_response_format: true,
                uses_anthropic_format: false,
            },
            ProviderKind::Anthropic => Self {
                kind,
                model,
                // Anthropic does not expose a public embeddings API
                embedding_model: None,
                api_key,
                base_url: "https://api.anthropic.com/v1".to_string(),
                client,
                extra_headers: HeaderMap::new(),
                supports_response_format: false,
                uses_anthropic_format: true,
            },
            ProviderKind::Gemini => Self {
                kind,
                model,
                embedding_model: None,
                api_key,
                // Google's OpenAI-compatible shim
                base_url: "https://generativelanguage.googleapis.com/v1beta/openai".to_string(),
                client,
                extra_headers: HeaderMap::new(),
                supports_response_format: true,
                uses_anthropic_format: false,
            },
            ProviderKind::Groq => Self {
                kind,
                model,
                embedding_model: None,
                api_key,
                base_url: first_env_or_default(
                    &["VOIDLINK_GROQ_BASE_URL"],
                    "https://api.groq.com/openai/v1",
                )
                .trim_end_matches('/')
                .to_string(),
                client,
                extra_headers: HeaderMap::new(),
                supports_response_format: false,
                uses_anthropic_format: false,
            },
            ProviderKind::Fireworks => Self {
                kind,
                model,
                embedding_model: Some("nomic-ai/nomic-embed-text-v1.5".to_string()),
                api_key,
                base_url: "https://api.fireworks.ai/inference/v1".to_string(),
                client,
                extra_headers: HeaderMap::new(),
                supports_response_format: true,
                uses_anthropic_format: false,
            },
            ProviderKind::OpenRouter => {
                let mut extra_headers = HeaderMap::new();
                let site_url = first_env_or_default(
                    &["VOIDLINK_OPENROUTER_SITE_URL"],
                    "https://voidlink.local",
                );
                let app_name =
                    first_env_or_default(&["VOIDLINK_OPENROUTER_APP_NAME"], "VoidLink");
                if let Ok(v) = HeaderValue::from_str(&site_url) {
                    extra_headers.insert(HeaderName::from_static("http-referer"), v);
                }
                if let Ok(v) = HeaderValue::from_str(&app_name) {
                    extra_headers.insert(HeaderName::from_static("x-title"), v);
                }
                Self {
                    kind,
                    model,
                    embedding_model: Some(first_env_or_default(
                        &["VOIDLINK_OPENROUTER_EMBED_MODEL"],
                        "openai/text-embedding-3-small",
                    )),
                    api_key,
                    base_url: "https://openrouter.ai/api/v1".to_string(),
                    client,
                    extra_headers,
                    supports_response_format: true,
                    uses_anthropic_format: false,
                }
            }
            ProviderKind::Ollama => Self {
                kind,
                model,
                embedding_model: Some(first_env_or_default(
                    &["VOIDLINK_OLLAMA_EMBED_MODEL"],
                    "nomic-embed-text",
                )),
                api_key,
                base_url: first_env_or_default(
                    &["VOIDLINK_OLLAMA_BASE_URL", "OLLAMA_HOST"],
                    "http://localhost:11434/v1",
                )
                .trim_end_matches('/')
                .to_string(),
                client,
                extra_headers: HeaderMap::new(),
                supports_response_format: false,
                uses_anthropic_format: false,
            },
            ProviderKind::Kimi => Self {
                kind,
                model,
                embedding_model: None,
                api_key,
                base_url: "https://api.moonshot.ai/v1".to_string(),
                client,
                extra_headers: HeaderMap::new(),
                supports_response_format: true,
                uses_anthropic_format: false,
            },
            ProviderKind::MiniMax => Self {
                kind,
                model,
                embedding_model: None,
                api_key,
                base_url: "https://api.minimax.io/v1".to_string(),
                client,
                extra_headers: HeaderMap::new(),
                supports_response_format: true,
                uses_anthropic_format: false,
            },
        }
    }

    // ─── Public generation API ────────────────────────────────────────────────

    pub fn generate(&self, prompt: &str) -> String {
        match self.chat_completion(prompt, false) {
            Ok(text) => text,
            Err(_) => format!(
                "{}-offline:{} {}",
                self.kind.as_str(),
                self.model,
                truncate_plain(prompt, 180)
            ),
        }
    }

    pub fn structured_generate(&self, prompt: &str) -> Value {
        match self.chat_completion(prompt, true) {
            Ok(raw_json) => serde_json::from_str::<Value>(&raw_json).unwrap_or_else(|_| {
                json!({
                    "provider": self.kind.as_str(),
                    "model": self.model.as_str(),
                    "summary": truncate_plain(&raw_json, 200)
                })
            }),
            Err(_) => json!({
                "provider": format!("{}-offline", self.kind.as_str()),
                "model": self.model.as_str(),
                "summary": truncate_plain(prompt, 180)
            }),
        }
    }

    pub fn embed(&self, text: &str) -> (String, Vec<f32>) {
        let batch = self.embed_many(&[text.to_string()]);
        let vector = batch
            .vectors
            .into_iter()
            .next()
            .unwrap_or_else(|| deterministic_embedding(text, 16));
        (batch.model_id, vector)
    }

    pub fn embed_many(&self, texts: &[String]) -> EmbeddingOutput {
        if texts.is_empty() {
            return EmbeddingOutput {
                model_id: DETERMINISTIC_EMBED_MODEL.to_string(),
                vectors: Vec::new(),
            };
        }

        if let Ok(vectors) = self.embed_many_remote(texts) {
            let model = self
                .embedding_model
                .as_deref()
                .unwrap_or(DETERMINISTIC_EMBED_MODEL);
            return EmbeddingOutput {
                model_id: format!("{}:{model}", self.kind.as_str()),
                vectors,
            };
        }

        EmbeddingOutput {
            model_id: DETERMINISTIC_EMBED_MODEL.to_string(),
            vectors: texts
                .iter()
                .map(|text| deterministic_embedding(text, 16))
                .collect(),
        }
    }

    pub fn chat_completion(&self, prompt: &str, json_mode: bool) -> Result<String, String> {
        if self.uses_anthropic_format {
            return self.anthropic_chat_completion(prompt, json_mode);
        }

        let mut body = json!({
            "model": self.model.as_str(),
            "messages": [
                {
                    "role": "system",
                    "content": if json_mode {
                        "You are a strict JSON generator. Return only a valid JSON object."
                    } else {
                        "You are a concise software engineering assistant."
                    }
                },
                {
                    "role": "user",
                    "content": prompt
                }
            ],
            "temperature": 0.1
        });

        if json_mode && self.supports_response_format {
            body["response_format"] = json!({ "type": "json_object" });
        }

        let payload = match self.openai_chat_request(&body) {
            Ok(payload) => payload,
            Err(primary_err) => {
                if json_mode && self.supports_response_format {
                    let mut fallback = body.clone();
                    if let Some(obj) = fallback.as_object_mut() {
                        obj.remove("response_format");
                    }
                    self.openai_chat_request(&fallback)
                        .map_err(|_| primary_err)?
                } else {
                    return Err(primary_err);
                }
            }
        };

        extract_openai_content(&payload).ok_or_else(|| {
            format!("{} chat response had no message content", self.kind.as_str())
        })
    }

    // ─── Anthropic Messages API ───────────────────────────────────────────────

    fn anthropic_chat_completion(&self, prompt: &str, json_mode: bool) -> Result<String, String> {
        let api_key = self
            .api_key
            .as_deref()
            .ok_or("Anthropic API key not configured")?;

        let system_msg = if json_mode {
            "You are a strict JSON generator. Return only a valid JSON object."
        } else {
            "You are a concise software engineering assistant."
        };

        let body = json!({
            "model": self.model,
            "max_tokens": 4096,
            "system": system_msg,
            "messages": [{"role": "user", "content": prompt}]
        });

        let response = self
            .client
            .post(format!("{}/messages", self.base_url))
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .send()
            .map_err(|e| e.to_string())?;

        let status = response.status();
        if !status.is_success() {
            let err_body = response.text().unwrap_or_default();
            return Err(format!("anthropic error {status}: {err_body}"));
        }

        let payload: Value = response.json().map_err(|e| e.to_string())?;
        payload
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|items| {
                items
                    .iter()
                    .filter_map(|item| item.get("text")?.as_str())
                    .next()
                    .map(|s| s.trim().to_string())
            })
            .ok_or_else(|| "anthropic response had no text content".to_string())
    }

    // ─── OpenAI-compatible request helpers ───────────────────────────────────

    fn openai_chat_request(&self, body: &Value) -> Result<Value, String> {
        let api_key = if self.kind == ProviderKind::Ollama {
            self.api_key.as_deref()
        } else {
            Some(
                self.api_key
                    .as_deref()
                    .ok_or_else(|| format!("{} API key not configured", self.kind.as_str()))?,
            )
        };
        let response = self
            .request_builder(format!("{}/chat/completions", self.base_url), api_key)
            .json(body)
            .send()
            .map_err(|e| e.to_string())?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().unwrap_or_default();
            return Err(format!("{} chat error {status}: {body}", self.kind.as_str()));
        }
        response.json::<Value>().map_err(|e| e.to_string())
    }

    fn embed_many_remote(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        let embedding_model = self
            .embedding_model
            .as_ref()
            .ok_or_else(|| format!("{} embedding model not configured", self.kind.as_str()))?;
        let api_key = if self.kind == ProviderKind::Ollama {
            self.api_key.as_deref()
        } else {
            Some(
                self.api_key
                    .as_deref()
                    .ok_or_else(|| format!("{} API key not configured", self.kind.as_str()))?,
            )
        };

        let body = json!({
            "model": embedding_model.as_str(),
            "input": texts,
            "encoding_format": "float"
        });

        let response = self
            .request_builder(format!("{}/embeddings", self.base_url), api_key)
            .json(&body)
            .send()
            .map_err(|e| e.to_string())?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().unwrap_or_default();
            return Err(format!(
                "{} embeddings error {status}: {body}",
                self.kind.as_str()
            ));
        }
        let payload: Value = response.json().map_err(|e| e.to_string())?;
        let data = payload
            .get("data")
            .and_then(|v| v.as_array())
            .ok_or_else(|| {
                format!("{} embeddings response missing data", self.kind.as_str())
            })?;

        let mut indexed = data
            .iter()
            .filter_map(|item| {
                let index = item.get("index").and_then(|v| v.as_u64())?;
                let embedding = item.get("embedding")?.as_array()?;
                let vector = embedding
                    .iter()
                    .filter_map(|n| n.as_f64().map(|v| v as f32))
                    .collect::<Vec<_>>();
                Some((index as usize, vector))
            })
            .collect::<Vec<_>>();
        indexed.sort_by_key(|(index, _)| *index);

        if indexed.len() != texts.len() {
            return Err(format!(
                "{} embeddings response length mismatch",
                self.kind.as_str()
            ));
        }
        Ok(indexed.into_iter().map(|(_, v)| v).collect())
    }

    fn request_builder(
        &self,
        url: String,
        api_key: Option<&str>,
    ) -> reqwest::blocking::RequestBuilder {
        let mut builder = self.client.post(url);
        if let Some(key) = api_key {
            builder = builder.bearer_auth(key);
        }
        for (name, value) in &self.extra_headers {
            builder = builder.header(name, value);
        }
        builder
    }
}

fn extract_openai_content(payload: &Value) -> Option<String> {
    let content = payload
        .get("choices")
        .and_then(|v| v.as_array())
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|msg| msg.get("content"))?;

    if let Some(text) = content.as_str() {
        return Some(text.trim().to_string());
    }

    if let Some(parts) = content.as_array() {
        let mut out = String::new();
        for part in parts {
            if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(text.trim());
            }
        }
        if !out.is_empty() {
            return Some(out);
        }
    }

    None
}

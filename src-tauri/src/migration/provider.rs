use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::{json, Value};
use std::time::Duration;

use super::chunks::{deterministic_embedding, truncate_plain, DETERMINISTIC_EMBED_MODEL};
use super::path_utils::{first_env, first_env_or_default};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProviderKind {
    OpenAi,
    Groq,
    OpenRouter,
    Ollama,
}

impl ProviderKind {
    fn as_str(self) -> &'static str {
        match self {
            ProviderKind::OpenAi => "openai",
            ProviderKind::Groq => "groq",
            ProviderKind::OpenRouter => "openrouter",
            ProviderKind::Ollama => "ollama",
        }
    }

    fn from_env_or_auto() -> Self {
        if let Ok(raw) = std::env::var("VOIDLINK_LLM_PROVIDER") {
            match raw.trim().to_ascii_lowercase().as_str() {
                "openai" => return ProviderKind::OpenAi,
                "groq" => return ProviderKind::Groq,
                "openrouter" => return ProviderKind::OpenRouter,
                "ollama" => return ProviderKind::Ollama,
                _ => {}
            }
        }

        if std::env::var("VOIDLINK_OLLAMA_BASE_URL").is_ok()
            || std::env::var("OLLAMA_HOST").is_ok()
        {
            ProviderKind::Ollama
        } else if std::env::var("OPENROUTER_API_KEY").is_ok() {
            ProviderKind::OpenRouter
        } else if std::env::var("GROQ_API_KEY").is_ok() {
            ProviderKind::Groq
        } else {
            ProviderKind::OpenAi
        }
    }
}

#[derive(Clone)]
pub(crate) struct EmbeddingOutput {
    pub(crate) model_id: String,
    pub(crate) vectors: Vec<Vec<f32>>,
}

#[derive(Clone)]
pub(crate) struct ProviderAdapter {
    kind: ProviderKind,
    model: String,
    embedding_model: Option<String>,
    api_key: Option<String>,
    base_url: String,
    client: Client,
    extra_headers: HeaderMap,
    supports_response_format: bool,
}

impl ProviderAdapter {
    pub(crate) fn new() -> Self {
        let kind = ProviderKind::from_env_or_auto();
        let timeout_secs =
            first_env(&["VOIDLINK_LLM_TIMEOUT_SECS", "VOIDLINK_OPENAI_TIMEOUT_SECS"])
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(30);
        let client = Client::builder()
            .timeout(Duration::from_secs(timeout_secs))
            .build()
            .unwrap_or_else(|_| Client::new());

        match kind {
            ProviderKind::OpenAi => Self {
                kind,
                model: first_env_or_default(&["VOIDLINK_OPENAI_MODEL"], "gpt-5-mini"),
                embedding_model: Some(first_env_or_default(
                    &["VOIDLINK_OPENAI_EMBED_MODEL"],
                    "text-embedding-3-small",
                )),
                api_key: first_env(&["OPENAI_API_KEY"]),
                base_url: first_env_or_default(
                    &["VOIDLINK_OPENAI_BASE_URL"],
                    "https://api.openai.com/v1",
                )
                .trim_end_matches('/')
                .to_string(),
                client,
                extra_headers: HeaderMap::new(),
                supports_response_format: true,
            },
            ProviderKind::Groq => Self {
                kind,
                model: first_env_or_default(
                    &["VOIDLINK_GROQ_MODEL", "VOIDLINK_OPENAI_MODEL"],
                    "llama-3.3-70b-versatile",
                ),
                embedding_model: first_env(&["VOIDLINK_GROQ_EMBED_MODEL"]),
                api_key: first_env(&["GROQ_API_KEY", "OPENAI_API_KEY"]),
                base_url: first_env_or_default(
                    &["VOIDLINK_GROQ_BASE_URL"],
                    "https://api.groq.com/openai/v1",
                )
                .trim_end_matches('/')
                .to_string(),
                client,
                extra_headers: HeaderMap::new(),
                supports_response_format: false,
            },
            ProviderKind::OpenRouter => {
                let mut extra_headers = HeaderMap::new();
                let site_url = first_env_or_default(
                    &["VOIDLINK_OPENROUTER_SITE_URL"],
                    "https://voidlink.local",
                );
                let app_name =
                    first_env_or_default(&["VOIDLINK_OPENROUTER_APP_NAME"], "VoidLink");
                if let Ok(value) = HeaderValue::from_str(&site_url) {
                    extra_headers.insert(HeaderName::from_static("http-referer"), value);
                }
                if let Ok(value) = HeaderValue::from_str(&app_name) {
                    extra_headers.insert(HeaderName::from_static("x-title"), value);
                }

                Self {
                    kind,
                    model: first_env_or_default(
                        &["VOIDLINK_OPENROUTER_MODEL", "VOIDLINK_OPENAI_MODEL"],
                        "openai/gpt-4.1-mini",
                    ),
                    embedding_model: Some(first_env_or_default(
                        &[
                            "VOIDLINK_OPENROUTER_EMBED_MODEL",
                            "VOIDLINK_OPENAI_EMBED_MODEL",
                        ],
                        "openai/text-embedding-3-small",
                    )),
                    api_key: first_env(&["OPENROUTER_API_KEY", "OPENAI_API_KEY"]),
                    base_url: first_env_or_default(
                        &["VOIDLINK_OPENROUTER_BASE_URL"],
                        "https://openrouter.ai/api/v1",
                    )
                    .trim_end_matches('/')
                    .to_string(),
                    client,
                    extra_headers,
                    supports_response_format: true,
                }
            }
            ProviderKind::Ollama => Self {
                kind,
                model: first_env_or_default(
                    &["VOIDLINK_OLLAMA_MODEL", "VOIDLINK_OPENAI_MODEL"],
                    "llama3.2",
                ),
                embedding_model: Some(first_env_or_default(
                    &["VOIDLINK_OLLAMA_EMBED_MODEL", "VOIDLINK_OPENAI_EMBED_MODEL"],
                    "nomic-embed-text",
                )),
                api_key: first_env(&["OLLAMA_API_KEY", "OPENAI_API_KEY"]),
                base_url: first_env_or_default(
                    &["VOIDLINK_OLLAMA_BASE_URL", "OLLAMA_HOST"],
                    "http://localhost:11434/v1",
                )
                .trim_end_matches('/')
                .to_string(),
                client,
                extra_headers: HeaderMap::new(),
                supports_response_format: false,
            },
        }
    }

    pub(crate) fn generate(&self, prompt: &str) -> String {
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

    pub(crate) fn structured_generate(&self, prompt: &str) -> Value {
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

    pub(crate) fn embed(&self, text: &str) -> (String, Vec<f32>) {
        let batch = self.embed_many(&[text.to_string()]);
        let vector = batch
            .vectors
            .into_iter()
            .next()
            .unwrap_or_else(|| deterministic_embedding(text, 16));
        (batch.model_id, vector)
    }

    pub(crate) fn embed_many(&self, texts: &[String]) -> EmbeddingOutput {
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

    pub(crate) fn chat_completion(&self, prompt: &str, json_mode: bool) -> Result<String, String> {
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

        let payload = match self.chat_completion_request(&body) {
            Ok(payload) => payload,
            Err(primary_err) => {
                if json_mode && self.supports_response_format {
                    let mut fallback = body.clone();
                    if let Some(object) = fallback.as_object_mut() {
                        object.remove("response_format");
                    }
                    self.chat_completion_request(&fallback)
                        .map_err(|_| primary_err)?
                } else {
                    return Err(primary_err);
                }
            }
        };

        extract_chat_message_content(&payload).ok_or_else(|| {
            format!(
                "{} chat response had no message content",
                self.kind.as_str()
            )
        })
    }

    fn chat_completion_request(&self, body: &Value) -> Result<Value, String> {
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
            .and_then(|value| value.as_array())
            .ok_or_else(|| {
                format!("{} embeddings response missing data", self.kind.as_str())
            })?;

        let mut indexed = data
            .iter()
            .filter_map(|item| {
                let index = item.get("index").and_then(|value| value.as_u64())?;
                let embedding = item.get("embedding")?.as_array()?;
                let vector = embedding
                    .iter()
                    .filter_map(|number| number.as_f64().map(|value| value as f32))
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
        Ok(indexed.into_iter().map(|(_, vector)| vector).collect())
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
        for (header_name, header_value) in &self.extra_headers {
            builder = builder.header(header_name, header_value);
        }
        builder
    }
}

fn extract_chat_message_content(payload: &Value) -> Option<String> {
    let content = payload
        .get("choices")
        .and_then(|value| value.as_array())
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))?;

    if let Some(text) = content.as_str() {
        return Some(text.trim().to_string());
    }

    if let Some(parts) = content.as_array() {
        let mut out = String::new();
        for part in parts {
            if let Some(text) = part.get("text").and_then(|value| value.as_str()) {
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

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum LLMProviderType {
    #[serde(rename = "openai")]
    OpenAI,
    #[serde(rename = "ollama")]
    Ollama,
}

#[async_trait]
pub trait LLMProvider: Send + Sync {
    async fn invoke(&self, prompt: &str) -> Result<String, String>;
    fn provider_type(&self) -> LLMProviderType;
}

#[derive(Serialize)]
pub struct LLMConfig {
    pub provider: LLMProviderType,
    pub api_key: Option<String>,
    pub model: String,
    pub base_url: Option<String>,
}

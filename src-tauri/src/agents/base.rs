use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    pub id: String,
    pub name: String,
    pub model: String,
    pub temperature: f32,
    pub tools: Vec<String>,
}

#[async_trait]
pub trait Agent: Send + Sync {
    async fn execute(&mut self, input: &str) -> Result<String, String>;
    async fn stream_execute(&mut self, input: &str) -> Result<AgentStream, String>;
    fn config(&self) -> &AgentConfig;
}

#[derive(Serialize)]
pub struct AgentStream {
    pub chunk: String,
    pub done: bool,
}

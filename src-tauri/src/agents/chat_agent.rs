use crate::agents::base::{Agent, AgentConfig, AgentStream};
use async_trait::async_trait;

pub struct ChatAgent {
    config: AgentConfig,
}

impl ChatAgent {
    pub fn new(config: AgentConfig) -> Result<Self, String> {
        Ok(Self { config })
    }

    pub async fn invoke_llm(&self, prompt: &str) -> Result<String, String> {
        // Simple echo implementation for now
        // In production, this would call OpenAI/Ollama via langchain-rust
        Ok(format!("Agent response to: {}", prompt))
    }
}

#[async_trait]
impl Agent for ChatAgent {
    async fn execute(&mut self, input: &str) -> Result<String, String> {
        self.invoke_llm(input).await
    }

    async fn stream_execute(&mut self, input: &str) -> Result<AgentStream, String> {
        // For simplicity, return a single chunk
        let response = self.invoke_llm(input).await?;
        
        Ok(AgentStream {
            chunk: response,
            done: true,
        })
    }

    fn config(&self) -> &AgentConfig {
        &self.config
    }
}

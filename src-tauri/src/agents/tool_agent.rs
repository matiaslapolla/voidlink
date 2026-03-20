use crate::agents::base::{Agent, AgentConfig, AgentStream};
use crate::tools::{Tool, SearchTool, FilesystemTool};
use serde_json::Value;
use async_trait::async_trait;

pub struct ToolAgent {
    config: AgentConfig,
    tools: Vec<Box<dyn Tool>>,
}

impl ToolAgent {
    pub fn new(config: AgentConfig) -> Result<Self, String> {
        let mut tools: Vec<Box<dyn Tool>> = Vec::new();

        // Add configured tools
        for tool_name in &config.tools {
            match tool_name.as_str() {
                "search" => {
                    tools.push(Box::new(SearchTool));
                }
                "filesystem" => {
                    tools.push(Box::new(FilesystemTool));
                }
                _ => {
                    eprintln!("Unknown tool: {}", tool_name);
                }
            }
        }

        Ok(Self { config, tools })
    }

    async fn parse_tool_call(&self, response: &str) -> Option<(String, Value)> {
        // Simple pattern matching for tool calls
        // Format: USE_TOOL: tool_name {"arg": "value"}
        if let Some(captures) = response.split("USE_TOOL:").nth(1) {
            if let Some(tool_part) = captures.strip_prefix(" ") {
                if let Some(space_idx) = tool_part.find(' ') {
                    let tool_name = tool_part[..space_idx].to_string();
                    if let Some(args_str) = tool_part[space_idx + 1..].strip_prefix(' ') {
                        if let Ok(args) = serde_json::from_str::<Value>(args_str) {
                            return Some((tool_name, args));
                        }
                    }
                }
            }
        }
        None
    }

    async fn execute_tool(&self, tool_name: &str, args: Value) -> Result<Value, String> {
        for tool in &self.tools {
            if tool.name() == tool_name {
                return tool.execute(args).await;
            }
        }
        Err(format!("Tool not found: {}", tool_name))
    }
}

#[async_trait]
impl Agent for ToolAgent {
    async fn execute(&mut self, input: &str) -> Result<String, String> {
        let mut current_input = input.to_string();
        let mut iterations = 0;
        const MAX_ITERATIONS: usize = 10;

        while iterations < MAX_ITERATIONS {
            iterations += 1;

            // Get response from "LLM" (simplified for now)
            let response = format!("Response {} to: {}", iterations, current_input);

            // Check if response contains a tool call
            if let Some((tool_name, args)) = self.parse_tool_call(&response) {
                // Execute the tool
                let result = self.execute_tool(&tool_name, args).await?;
                
                // Feed result back as input
                current_input = format!("Tool result: {}", result);
            } else {
                // No tool call, this is the final answer
                return Ok(response);
            }
        }

        Err("Max iterations reached without final answer".to_string())
    }

    async fn stream_execute(&mut self, input: &str) -> Result<AgentStream, String> {
        let response = self.execute(input).await?;
        
        Ok(AgentStream {
            chunk: response,
            done: true,
        })
    }

    fn config(&self) -> &AgentConfig {
        &self.config
    }
}

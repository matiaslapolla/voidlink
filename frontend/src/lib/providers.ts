export interface ProviderDef {
  id: string;
  label: string;
  needsKey: boolean;
  models: string[];
}

// Model names shortened for display but full ID used for API calls
export const PROVIDERS: ProviderDef[] = [
  {
    id: "openai",
    label: "OpenAI",
    needsKey: true,
    models: [
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-4.1-nano",
      "gpt-4o",
      "gpt-4o-mini",
      "o3",
      "o4-mini",
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    needsKey: true,
    models: [
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
    ],
  },
  {
    id: "gemini",
    label: "Gemini",
    needsKey: true,
    models: [
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.0-flash",
      "gemini-2.0-flash-lite",
    ],
  },
  {
    id: "groq",
    label: "Groq",
    needsKey: true,
    models: [
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
      "moonshotai/kimi-k2-instruct",
      "qwen/qwen3-32b",
      "qwen-2.5-32b",
      "qwen-2.5-coder-32b",
      "gemma2-9b-it",
      "mixtral-8x7b-32768",
    ],
  },
  {
    id: "fireworks",
    label: "Fireworks",
    needsKey: true,
    models: [
      "accounts/fireworks/models/llama-v3p3-70b-instruct",
      "accounts/fireworks/models/llama-v3p1-405b-instruct",
      "accounts/fireworks/models/qwen3-235b-a22b",
      "accounts/fireworks/models/qwen3-coder-480b-a35b-instruct",
      "accounts/fireworks/models/qwen-qwq-32b-preview",
      "accounts/fireworks/models/qwen2p5-72b-instruct",
      "accounts/fireworks/models/mixtral-8x7b-instruct",
      "accounts/fireworks/models/deepseek-r1",
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    needsKey: true,
    models: [
      // OpenAI
      "openai/gpt-4.1",
      "openai/gpt-4.1-mini",
      // Anthropic
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-opus-4-6",
      // Google
      "google/gemini-2.5-pro",
      "google/gemini-2.5-flash",
      // Meta
      "meta-llama/llama-3.3-70b-instruct",
      // Kimi (Moonshot)
      "moonshotai/kimi-k2.5",
      "moonshotai/kimi-k2-instruct",
      "moonshotai/moonlight-16b-a3b-instruct",
      // MiniMax
      "minimax/minimax-m2.7",
      "minimax/minimax-m2.5",
      "minimax/minimax-01",
      // Qwen
      "qwen/qwen3-235b-a22b-instruct-2507",
      "qwen/qwen3-coder-480b-a35b-instruct",
      "qwen/qwen3-next-80b-a3b-instruct",
      "qwen/qwq-32b",
      // DeepSeek
      "deepseek/deepseek-r1",
    ],
  },
  {
    id: "ollama",
    label: "Ollama",
    needsKey: false,
    models: [
      "llama3.2",
      "llama3.1",
      "mistral",
      "codellama",
      "qwen2.5",
      "qwen2.5-coder",
      "qwen3",
      "deepseek-r1",
      "phi4",
    ],
  },
  {
    id: "kimi",
    label: "Kimi",
    needsKey: true,
    models: [
      "kimi-k2.5",
      "kimi-k2",
      "kimi-k2-turbo-preview",
      "moonlight-16b-a3b-instruct",
    ],
  },
  {
    id: "minimax",
    label: "MiniMax",
    needsKey: true,
    models: [
      "MiniMax-M2",
      "MiniMax-M2-Stable",
      "minimax-m2.1",
      "minimax-01",
    ],
  },
];

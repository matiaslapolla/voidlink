import { createSignal, For, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';

export function AgentConfigPanel() {
  const [model, setModel] = createSignal('gpt-4');
  const [temperature, setTemperature] = createSignal(0.7);
  const [agentName, setAgentName] = createSignal('New Agent');
  const [selectedTools, setSelectedTools] = createSignal<string[]>([]);

  const availableTools = [
    'search',
    'filesystem',
  ];

  async function handleCreate() {
    const config = {
      id: crypto.randomUUID(),
      name: agentName(),
      model: model(),
      temperature: temperature(),
      tools: selectedTools(),
    };

    try {
      await invoke('agent_create', { config });
      alert('Agent created successfully!');
    } catch (error) {
      alert(`Failed to create agent: ${error}`);
    }
  }

  return (
    <div class="agent-config-panel">
      <h2>Create Agent</h2>

      <div class="form-group">
        <label>
          Agent Name
          <input
            type="text"
            value={agentName()}
            onInput={(e) => setAgentName(e.currentTarget.value)}
          />
        </label>
      </div>

      <div class="form-group">
        <label>
          Model
          <select
            value={model()}
            onChange={(e) => setModel(e.currentTarget.value)}
          >
            <option value="gpt-4">GPT-4</option>
            <option value="gpt-3.5-turbo">GPT-3.5 Turbo</option>
            <option value="ollama-llama2">Ollama Llama2</option>
          </select>
        </label>
      </div>

      <div class="form-group">
        <label>
          Temperature
          <input
            type="range"
            min="0"
            max="2"
            step="0.1"
            value={temperature()}
            onInput={(e) => setTemperature(parseFloat(e.currentTarget.value))}
          />
          <span class="temperature-value">{temperature().toFixed(1)}</span>
        </label>
      </div>

      <div class="form-group">
        <fieldset>
          <legend>Tools</legend>
          <For each={availableTools}>
            {(tool) => (
              <label class="tool-option">
                <input
                  type="checkbox"
                  checked={selectedTools().includes(tool)}
                  onChange={(e) => {
                    if (e.currentTarget.checked) {
                      setSelectedTools([...selectedTools(), tool]);
                    } else {
                      setSelectedTools(selectedTools().filter(t => t !== tool));
                    }
                  }}
                />
                <span class="tool-name">
                  {tool === 'search' ? 'Web Search' : 'Filesystem'}
                </span>
              </label>
            )}
          </For>
        </fieldset>
      </div>

      <button onClick={handleCreate} class="create-btn">
        Create Agent
      </button>
    </div>
  );
}

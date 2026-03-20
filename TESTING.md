# LangChain Agents Testing Guide

This guide provides comprehensive test flows for the LangChain agent system, including basic chat agents, tool-using agents, and agent management.

---

## 🤖 Test Flow 1: Create and Use Basic Chat Agent

### Prerequisites
```bash
cd .git/worktrees/langchain-agents
make setup  # Install dependencies
make app     # Run Tauri app
```

### Steps

1. **Open Agent Configuration Panel**
   - Locate the AgentConfigPanel component in the UI
   - You should see form fields for creating a new agent

2. **Configure Basic Chat Agent**
   - **Agent Name**: Enter `Test Agent`
   - **Model**: Select `gpt-4` from dropdown
   - **Temperature**: Move slider to `0.7` (or type `0.7`)
   - **Tools**: Leave all checkboxes unchecked
   - Click "Create Agent" button

3. **Verify Agent Creation**
   - Success alert should appear: "Agent created successfully!"
   - Agent should appear in agent list (if agent list component exists)
   - Agent status should be "idle"

4. **Open Chat Interface**
   - Locate the Chat component for the new agent
   - You should see an empty chat interface with:
     - Message area (initially empty)
     - Input field with placeholder "Type a message..."
     - Send button

5. **Send First Message**
   - In the input field, type: `Hello, who are you?`
   - Press Enter or click "Send" button
   - Message should appear in chat history with:
     - Role: "user"
     - Content: "Hello, who are you?"
     - Timestamp (current time)
   - Send button should show "Sending..." and be disabled
   - Streaming indicator should appear (dots animation)

6. **Receive Agent Response**
   - Agent response should stream in (or appear all at once)
   - New message appears with:
     - Role: "assistant"
     - Content: Agent's response text
     - Timestamp
   - Send button returns to "Send" state
   - Streaming indicator disappears

7. **Continue Conversation**
   - Type: `What can you do?`
   - Send message
   - Agent should respond based on context
   - Chat history should show all messages in order

8. **Test Message History**
   - Verify all messages appear in chronological order
   - Check that user messages are styled differently from assistant messages
   - Scroll to see older messages if conversation is long

### What to Verify

- ✅ Agent configuration panel displays correctly
- ✅ Agent can be created with basic settings
- ✅ Success alert appears after creation
- ✅ Agent appears in agent list
- ✅ Chat interface opens for the agent
- ✅ User messages appear immediately
- ✅ Streaming indicator shows during processing
- ✅ Assistant responses appear (streaming or all at once)
- ✅ Message roles are correctly labeled
- ✅ Timestamps are formatted correctly
- ✅ Send button state changes (enabled/disabled)
- ✅ Multiple messages appear in correct order
- ✅ Chat history is scrollable

---

## 🛠️ Test Flow 2: Tool-Using Agent

### Prerequisites
```bash
cd .git/worktrees/langchain-agents
make setup
make app

# Note: This assumes tools like ddgr (DuckDuckGo) are available
```

### Steps

1. **Create Tool-Using Agent**
   - Open AgentConfigPanel
   - Configure agent:
     - **Agent Name**: `Search Agent`
     - **Model**: Select `gpt-3.5-turbo`
     - **Temperature**: Set to `0.5`
     - **Tools**: Enable both "Web Search" and "Filesystem"
   - Click "Create Agent"

2. **Open Chat for Search Agent**
   - Locate Chat component for the new agent
   - Verify it's the correct agent (check name/id)

3. **Test Search Tool**
   - In chat input, type: `Search for "Tauri framework" and tell me what you find`
   - Send message
   - Watch for tool invocation pattern in response:
     - Look for: `USE_TOOL: search {"query": "Tauri framework"}`
     - Or similar pattern indicating tool use
   - Agent should return search results
   - Response should be synthesized from search results

4. **Test Filesystem Tool**
   - Type: `Read /tmp/test.txt and tell me its contents`
   - Send message
   - First, create the file for testing:
     ```bash
     echo "This is a test file" > /tmp/test.txt
     ```
   - Now send the message to agent
   - Agent should attempt to read the file
   - Response should include file contents or error if not found

5. **Test Multi-Step Tool Use**
   - Type: `Search for "Rust programming" then search for "SolidJS framework"`
   - Send message
   - Agent should use search tool twice
   - Responses should show tool invocations
   - Final answer should synthesize both search results

6. **Test Tool Error Handling**
   - Type: `Read /nonexistent/file.txt`
   - Send message
   - Agent should attempt to use filesystem tool
   - Should receive error response
   - Agent should handle error gracefully in final response

### What to Verify

- ✅ Agent can be created with tools enabled
- ✅ Tool-using agent appears in agent list
- ✅ Chat interface works for tool-using agents
- ✅ Search tool can be invoked
- ✅ Filesystem tool can be invoked
- ✅ Tool invocations are visible (in logs or streaming)
- ✅ Agent receives tool results
- ✅ Agent synthesizes final answer from tool results
- ✅ Multi-step tool use works
- ✅ Tool errors are handled gracefully
- ✅ Agent doesn't get stuck in tool loops

---

## 🎛️ Test Flow 3: Multiple Agents

### Prerequisites
```bash
cd .git/worktrees/langchain-agents
make app
```

### Steps

1. **Create Multiple Agents**
   - **Agent 1 - Code Assistant**:
     - Name: `Code Writer`
     - Model: `gpt-4`
     - Tools: `filesystem`
     - Temperature: `0.3`
     - Create agent

   - **Agent 2 - Researcher**:
     - Name: `Researcher`
     - Model: `gpt-3.5-turbo`
     - Tools: `search`
     - Temperature: `0.7`
     - Create agent

   - **Agent 3 - General Chat**:
     - Name: `General Helper`
     - Model: `gpt-4`
     - Tools: (none)
     - Temperature: `0.5`
     - Create agent

2. **Verify All Agents Created**
   - All three agents should appear in agent list
   - Each should have:
     - Unique ID
     - Configured name
     - Selected model
     - Configured tools
     - Status: "idle"

3. **Open Separate Chat for Each Agent**
   - Open Chat for "Code Writer"
   - In a new tab/window, open Chat for "Researcher"
   - In another tab/window, open Chat for "General Helper"
   - All three chats should be independent

4. **Test Agent 1 (Code Writer)**
   - In Code Writer chat: `Write a Rust function that adds two numbers`
   - Send message
   - Agent should respond with Rust code
   - Agent might use filesystem tool if instructed to save

5. **Test Agent 2 (Researcher)**
   - In Researcher chat: `Find information about Tauri's latest features`
   - Send message
   - Agent should use search tool
   - Response should include current information

6. **Test Agent 3 (General Helper)**
   - In General Helper chat: `What's the weather like today?`
   - Send message
   - Agent should respond conversationally

7. **Test Agent Independence**
   - All three chats should remain separate
   - Messages from one agent shouldn't appear in another
   - Each agent should maintain its own context
   - Closing one chat shouldn't affect others

8. **Test Agent Status Tracking**
   - During agent execution, check status
   - Should change from "idle" → "running" → "idle"
   - Multiple agents can run simultaneously

### What to Verify

- ✅ Multiple agents can be created
- ✅ Each agent has independent configuration
- ✅ All agents appear in agent list
- ✅ Each agent has unique ID
- ✅ Separate chat sessions work for each agent
- ✅ Chat histories are isolated
- ✅ Agents respond independently
- ✅ Different models can be used
- ✅ Tool configurations are independent
- ✅ Agent status changes correctly
- ✅ Multiple agents can run simultaneously
- ✅ Closing one chat doesn't affect others

---

## 🧪 Test Flow 4: Agent Streaming

### Prerequisites
```bash
cd .git/worktrees/langchain-agents
make app
```

### Steps

1. **Create Agent with Streaming Enabled**
   - Configure agent with any model
   - Create the agent

2. **Open Chat for Agent**
   - Locate Chat component

3. **Test Streaming Response**
   - Type: `Count from 1 to 10`
   - Send message
   - Watch the assistant message area
   - Expected behavior:
     - Response appears incrementally
     - Tokens stream in (if backend supports it)
     - Or response appears in chunks
     - Final message appears complete

4. **Test Streaming Interruption**
   - Type a very long request: `Explain the entire history of computing`
   - Send message
   - While streaming, note how it looks
   - Response should eventually complete
   - No errors should occur during streaming

5. **Test Streaming with Long Messages**
   - Type: `Write a detailed 500-word article about AI`
   - Send message
   - Response should stream for a longer duration
   - Streaming indicator should remain visible
   - Complete message should appear when done

### What to Verify

- ✅ Streaming works for chat agents
- ✅ Streaming works for tool-using agents
- ✅ Streaming indicator shows during processing
- ✅ Streaming indicator disappears when complete
- ✅ Long messages stream properly
- ✅ No errors during streaming
- ✅ Final message is complete and coherent
- ✅ Streaming doesn't block UI

---

## 🔌 Test Flow 5: Agent Events

### Prerequisites
```bash
cd .git/worktrees/langchain-agents
make app
```

### Steps

1. **Listen for Agent Stream Events**
   - Open Chat component for an agent
   - Note that the component should be listening for events
   - Event listener pattern: `listen(\`agent-stream:${agentId}\`)`

2. **Trigger Agent Execution**
   - Send a message to the agent
   - Watch for events in console (if debugging)
   - Events should be emitted as agent processes

3. **Test Event Payload**
   - Verify event payload structure:
     ```typescript
     {
       chunk: string,
       done: boolean
     }
     ```
   - Chunks should contain partial responses
   - Final chunk should have `done: true`

4. **Test Multiple Events**
   - Send several messages in succession
   - Each should trigger separate stream events
   - Events should be in correct order
   - No events should be lost

5. **Test Event Cleanup**
   - Close the Chat component
   - Event listener should be cleaned up (unlisten)
   - No memory leaks should occur
   - Reopening chat should create new listener

### What to Verify

- ✅ Event listeners are registered
- ✅ Agent stream events are emitted
- ✅ Event payload has correct structure
- ✅ Multiple events work correctly
- ✅ Events are in chronological order
- ✅ Event cleanup works on unmount
- ✅ No memory leaks from event listeners

---

## 🐛 Troubleshooting

### Agent Creation Issues

**Problem**: Agent creation fails
- **Check configuration**: Verify all fields are filled
- **Check model**: Ensure model name is valid
- **Check tools**: If tools selected, verify tool names are correct
- **Check logs**: Review Rust logs for errors

**Problem**: Agent doesn't appear in list
- **Refresh agent list**: If list component exists
- **Check store**: Verify store function updates correctly
- **Check signals**: Ensure `setAgents` is called

### Chat Issues

**Problem**: Messages don't appear
- **Check state**: Verify `messages` signal is updated
- **Check For loop**: Ensure `<For>` is rendering correctly
- **Check styling**: Verify messages aren't hidden (CSS)
- **Check console**: Look for JavaScript errors

**Problem**: Agent doesn't respond
- **Check backend**: Verify agent_execute command is registered
- **Check agent ID**: Ensure correct agent ID is passed
- **Check input**: Verify input is not empty
- **Check logs**: Look for errors in Tauri logs

### Streaming Issues

**Problem**: Streaming doesn't work
- **Check event listener**: Ensure listener is registered correctly
- **Check event name**: Verify format: `agent-stream:${agentId}`
- **Check agent_stream**: Verify command is implemented in Rust
- **Check chunk handling**: Verify frontend processes chunks correctly

**Problem**: Streaming gets stuck
- **Check done flag**: Ensure final chunk has `done: true`
- **Check loop**: Verify streaming loop exits correctly
- **Check timeout**: Ensure no timeout is cutting off responses

### Tool Issues

**Problem**: Tools don't execute
- **Check tool registration**: Verify tools are added to agent
- **Check tool parsing**: Verify agent can parse tool calls
- **Check tool availability**: Ensure `ddgr` is installed for search
- **Check tool implementation**: Verify Rust tool implementation works

**Problem**: Tool results not fed back
- **Check tool execution**: Verify tool returns results
- **Check result passing**: Ensure results are passed to agent
- **Check context**: Verify agent incorporates tool results

### General Issues

**Problem**: App crashes
- **Check Rust panics**: Look for panic messages
- **Check memory**: Verify no infinite loops
- **Check serialization**: Ensure agent data serializes correctly
- **Check locks**: Verify `AgentStore` locks are used correctly

**Problem**: TypeScript errors
- **Check types**: Verify all interfaces match
- **Check imports**: Ensure `@tauri-apps/api/core` is imported
- **Check store**: Verify store functions return correct types

---

## 📊 Test Checklist

Use this checklist to verify all functionality:

### Agent Management
- [ ] AgentConfigPanel displays correctly
- [ ] Agents can be created
- [ ] Agent list shows all agents
- [ ] Agent configurations are saved
- [ ] Agents have unique IDs
- [ ] Agent status is tracked

### Basic Chat
- [ ] Chat interface opens
- [ ] User messages appear
- [ ] Assistant responses appear
- [ ] Streaming works
- [ ] Message history is correct
- [ ] Timestamps are formatted
- [ ] Send button state changes

### Tool-Using Agents
- [ ] Tools can be selected
- [ ] Search tool works
- [ ] Filesystem tool works
- [ ] Tool invocations are visible
- [ ] Tool results are fed back
- [ ] Multi-step tool use works
- [ ] Tool errors are handled

### Multiple Agents
- [ ] Multiple agents can be created
- [ ] Each agent has independent config
- [ ] Separate chats work for each agent
- [ ] Chat histories are isolated
- [ ] Agents respond independently
- [ ] Multiple agents can run simultaneously

### Streaming & Events
- [ ] Streaming works correctly
- [ ] Event listeners are registered
- [ ] Event payloads are correct
- [ ] Multiple events work
- [ ] Event cleanup works
- [ ] No memory leaks

---

## 🎓 Advanced Test Scenarios

### Scenario 1: Complex Tool Chain
```
User: "Search for 'Tauri tutorial', read the first result, and summarize it"
```
- Agent should use search tool
- Then use filesystem tool (if file is saved)
- Synthesize final answer
- Verify tool execution order

### Scenario 2: Error Recovery
```
User: "Read /nonexistent/file.txt, then search for 'error handling'"
```
- First tool should fail gracefully
- Agent should handle error
- Second tool should execute successfully
- Final answer acknowledges both results

### Scenario 3: Concurrent Agent Execution
- Open 3+ agent chats
- Send messages to all simultaneously
- All agents should respond independently
- Verify no race conditions or state mixing

### Scenario 4: Long-Running Agent
- Send a very long prompt (500+ words)
- Agent should process without timeout
- Response should stream and complete
- Verify no memory leaks

---

## 📝 Test Results Log

Record your test results here:

| Test | Status | Notes |
|------|--------|-------|
| Agent Creation | ☐ Passed ☐ Failed | |
| Chat Interface | ☐ Passed ☐ Failed | |
| Message Sending | ☐ Passed ☐ Failed | |
| Agent Response | ☐ Passed ☐ Failed | |
| Streaming | ☐ Passed ☐ Failed | |
| Tool Selection | ☐ Passed ☐ Failed | |
| Search Tool | ☐ Passed ☐ Failed | |
| Filesystem Tool | ☐ Passed ☐ Failed | |
| Multiple Agents | ☐ Passed ☐ Failed | |
| Agent Independence | ☐ Passed ☐ Failed | |
| Event Listeners | ☐ Passed ☐ Failed | |
| Event Cleanup | ☐ Passed ☐ Failed | |

---

## 🚀 Next Steps

After testing:
1. **Report issues** via GitHub Issues
2. **Check logs** in terminal for errors
3. **Verify dependencies** are up-to-date
4. **Test with real LLM**: Integrate actual OpenAI/Ollama backend
5. **Run full test suite**: `make check`
6. **Test integration** with browser and CMUX features

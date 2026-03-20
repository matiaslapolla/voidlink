# CMUX Workflows Testing Guide

This guide provides comprehensive test flows for the CMUX-style workflow orchestration, workspace management, and notification system.

---

## 🔄 Test Flow 1: Workspace Management

### Prerequisites
```bash
cd .git/worktrees/cmux-workflows
make setup  # Install dependencies
make app     # Run Tauri app
```

### Steps

1. **View Workspace Sidebar**
   - Locate the sidebar on the left side of the app
   - You should see existing workspaces (if any)
   - Look for workspace cards showing:
     - Name
     - Git branch (🌿 branch-name)
     - PR number (#123) if applicable

2. **Create New Workspace**
   - Click the "➕ New Workspace" button
   - A file picker dialog should appear
   - Select a directory (e.g., `/path/to/your/project`)
   - New workspace should appear in the sidebar
   - Workspace card should show:
     - Directory name as workspace name
     - Git branch if it's a git repository
     - "main" or branch name

3. **Select Active Workspace**
   - Click on any workspace card in the sidebar
   - The card should become highlighted (active state)
   - Other workspaces should lose highlighting

4. **Test Workspace Switching**
   - Click on a different workspace
   - Active state should transfer to new workspace
   - Previous workspace should no longer be highlighted

5. **Collapse/Expand Sidebar**
   - Click the "☰" toggle button at the top
   - Sidebar should collapse to show only icons
   - Click again to expand
   - All workspace cards should reappear

### What to Verify

- ✅ Workspace sidebar displays all workspaces
- ✅ New workspace creation works
- ✅ Git branch detection works (for git repos)
- ✅ Workspace cards show correct information
- ✅ Active workspace is visually indicated
- ✅ Workspace switching works smoothly
- ✅ Sidebar collapse/expand works
- ✅ Workspace names are derived from directory names

---

## 🔔 Test Flow 2: Notification System

### Prerequisites
```bash
cd .git/worktrees/cmux-workflows
make app
```

### Steps

1. **Open Notification Panel**
   - Click the notification bell icon (🔔) in the top bar
   - A notification panel should slide down or appear
   - If there are unread notifications, you should see a badge number

2. **View Notification List**
   - All notifications should be displayed
   - Each notification shows:
     - Title (e.g., "Agent Alert")
     - Body (e.g., "Waiting for input")
     - Timestamp (e.g., "2:30 PM")
     - Level indicator (info/warning/error)
     - Unread indicator (if still unread)

3. **Filter Notifications**
   - Click filter buttons: "all", "error", "warning", "info"
   - Notifications list should filter by selected level
   - Unread count should reflect only visible notifications

4. **Mark Notification as Read**
   - Click on any notification
   - The notification should lose its "unread" styling
   - Unread badge count should decrement by 1

5. **Mark All as Read**
   - Click "Mark all read" button
   - All notifications should lose unread styling
   - Unread badge should disappear or show "0"

6. **Dismiss Notifications**
   - Click the "×" button on a notification
   - Notification should be removed from the list
   - Unread count should update if needed

### Send Test Notifications via Terminal

7. **Send OSC 99 Sequence from Terminal**
   - Open a terminal
   - Run this command to send a notification:
     ```bash
     printf "\033]99;{\"type\":\"info\",\"level\":\"info\",\"title\":\"Build Complete\",\"body\":\"Tests passed\",\"workspaceId\":\"workspace-1\"}\007"
     ```
   - Notification should appear in the panel with unread indicator

8. **Send Error Notification**
   ```bash
   printf "\033]99;{\"type\":\"error\",\"level\":\"error\",\"title\":\"Build Failed\",\"body\":\"Tests failed\",\"workspaceId\":\"workspace-1\"}\007"
     ```
   - Notification should appear with error styling (red)
   - Should be marked as unread

9. **Send Warning Notification**
   ```bash
   printf "\033]99;{\"type\":\"git\",\"level\":\"warning\",\"title\":\"Merge Conflict\",\"body\":\"Resolve conflicts\",\"workspaceId\":\"workspace-1\"}\007"
     ```
   - Notification should appear with warning styling (yellow)

10. **Send Multiple Notifications**
    - Send several notifications in quick succession
    - Unread count should increment
    - Notifications should appear in chronological order (newest first)

### What to Verify

- ✅ Notification panel opens/closes correctly
- ✅ Unread badge shows correct count
- ✅ Notifications display with all fields
- ✅ Filtering works (all/error/warning/info)
- ✅ Mark as read works
- ✅ Mark all as read works
- ✅ Dismiss works
- ✅ OSC 99 sequences are parsed correctly
- ✅ Notifications are ordered by timestamp
- ✅ Level styling is applied (info=blue, warning=yellow, error=red)
- ✅ Timestamps are formatted correctly

---

## 🔌 Test Flow 3: Socket API Control

### Prerequisites
```bash
cd .git/worktrees/cmux-workflows
make app

# Ensure the app is running and listening on port 7676
```

### Steps

1. **Test Socket Connection**
   ```bash
   # Using netcat (nc)
   echo '{"test":"connection"}' | nc localhost 7676
   
   # Or using a simple client
   ```
   - Connection should succeed
   - Check app logs for connection message

2. **Create Workspace via Socket**
   ```bash
   echo '{"command":"workspace.create","args":{"path":"/path/to/project"},"id":"test-1"}' | nc localhost 7676
   ```
   - New workspace should appear in UI
   - Check WorkspaceSidebar for new workspace

3. **Set Active Workspace via Socket**
   ```bash
   echo '{"command":"workspace.set_active","args":{"id":"workspace-123"},"id":"test-2"}' | nc localhost 7676
   ```
   - Specified workspace should become active
   - Visual highlighting should update

4. **Add Notification via Socket**
   ```bash
   echo '{"command":"notification.add","args":{"title":"Agent Alert","body":"Waiting for input","level":"warning","type":"agent","workspaceId":"workspace-1"},"id":"test-3"}' | nc localhost 7676
   ```
   - Notification should appear in panel
   - Should be marked as unread

5. **Multiple Socket Commands**
   - Send several commands in sequence:
     ```bash
     echo '{"command":"notification.add","args":{"title":"Test 1","body":"Body 1","level":"info"}}' | nc localhost 7676
     echo '{"command":"notification.add","args":{"title":"Test 2","body":"Body 2","level":"warning"}}' | nc localhost 7676
     echo '{"command":"notification.add","args":{"title":"Test 3","body":"Body 3","level":"error"}}' | nc localhost 7676
     ```
   - All notifications should appear
   - Order should be chronological

6. **Test Auto-Reconnection**
   - Stop the app
   - Wait a few seconds
   - Start the app again
   - Socket should auto-reconnect
   - Connection indicator should show "connected"

7. **Test Invalid Commands**
   ```bash
   echo '{"command":"invalid.command","args":{}}' | nc localhost 7676
   ```
   - App should handle gracefully
   - Check logs for "Unknown command" warning

### What to Verify

- ✅ Socket connects to port 7676
- ✅ Workspace creation works via socket
- ✅ Active workspace can be set via socket
- ✅ Notifications can be added via socket
- ✅ Multiple commands execute in sequence
- ✅ Auto-reconnection works after disconnect
- ✅ Invalid commands are handled gracefully
- ✅ Connection status is displayed (if applicable)
- ✅ Socket events are logged

---

## 🎯 Test Flow 4: Workflow Execution (If Workflow UI Exists)

### Prerequisites
```bash
cd .git/worktrees/cmux-workflows
make app

# This assumes a WorkflowEditor or similar component exists
```

### Steps

1. **Create Simple Workflow**
   - Open workflow editor (if available)
   - Add nodes:
     - Agent node: Configure with agent ID
     - Tool node: Configure with tool ID
   - Connect nodes: Draw connection from agent to tool
   - Set start node: Mark agent node as start
   - Save workflow

2. **Execute Workflow**
   - Click "Execute" or "Run" button
   - Provide initial input: `{"query": "test"}`
   - Workflow should start running

3. **Monitor Execution**
   - Check execution history panel
   - Should see:
     - Execution steps with timestamps
     - Each step's input and output
     - Duration of each step
   - Status should show "running" then "completed"

4. **Test Conditional Logic**
   - Create a workflow with condition node
   - Set condition: `input.value > 10`
   - Execute with input: `{"value": 15}`
   - Workflow should follow "true" path
   - Execute with input: `{"value": 5}`
   - Workflow should follow "false" path

5. **Test Loops**
   - Create a workflow with loop node
   - Set loop iterations: 3
   - Execute workflow
   - Should see 3 iterations in execution history
   - Each iteration should have separate step records

### What to Verify

- ✅ Workflow can be created and saved
- ✅ Nodes can be added and configured
- ✅ Connections can be drawn between nodes
- ✅ Start node can be set
- ✅ Workflow executes successfully
- ✅ Execution history tracks all steps
- ✅ Status updates (pending → running → completed)
- ✅ Conditional logic works
- ✅ Loops execute correct number of times
- ✅ Step durations are recorded
- ✅ Inputs/outputs are captured

---

## 🐛 Troubleshooting

### Workspace Issues

**Problem**: Workspaces don't appear
- **Check directory**: Ensure you selected a valid directory
- **Check permissions**: Ensure directory is readable
- **Check git**: Verify `.git` folder exists for branch detection

**Problem**: Git branch not showing
- **Verify it's a git repo**: Run `git status` in the directory
- **Check commits**: Ensure at least one commit exists
- **Check branch**: Run `git branch --show-current`

### Notification Issues

**Problem**: OSC sequences don't trigger
- **Verify terminal supports OSC 99**: Try a terminal like iTerm2
- **Check formatting**: Ensure sequence is properly escaped
- **Test manually**: Run the printf command and observe output

**Problem**: Notifications not appearing
- **Check event listener**: Ensure event is registered
- **Check parsing**: Verify JSON parsing in `parseOscSequence`
- **Check workspace ID**: Ensure it matches an existing workspace

### Socket Issues

**Problem**: Socket won't connect
- **Check port**: Ensure port 7676 is not in use: `lsof -i :7676`
- **Check firewall**: Ensure port is not blocked
- **Check app**: Ensure app is running and listening

**Problem**: Socket commands not executing
- **Check command format**: Verify JSON is valid
- **Check command name**: Ensure it matches registered commands
- **Check args**: Verify arguments are properly formatted

**Problem**: Socket disconnects frequently
- **Check timeout**: Verify 5-second reconnection timer
- **Check network**: Ensure stable connection
- **Check logs**: Look for error messages

### Workflow Issues

**Problem**: Workflow won't execute
- **Check start node**: Ensure a start node is set
- **Check connections**: Ensure nodes are properly connected
- **Check inputs**: Verify initial input is provided
- **Check node types**: Ensure all node types are implemented

**Problem**: Workflow gets stuck
- **Check loops**: Ensure loops have exit conditions
- **Check iterations**: Verify MAX_ITERATIONS limit (100)
- **Check conditions**: Ensure condition evaluation works

### General Issues

**Problem**: App crashes
- **Check Rust logs**: Look for panics or errors
- **Check Tauri logs**: Review Tauri error messages
- **Check TypeScript**: Ensure no type errors: `npm run build`

**Problem**: Reactivity issues
- **Check signals**: Ensure `createSignal` is used correctly
- **Check stores**: Verify store functions return signals
- **Check event listeners**: Ensure cleanup on component unmount

---

## 📊 Test Checklist

Use this checklist to verify all functionality:

### Workspace Management
- [ ] Sidebar displays workspaces
- [ ] New workspace can be created
- [ ] Git branch detection works
- [ ] Active workspace is highlighted
- [ ] Workspace switching works
- [ ] Sidebar collapse/expand works

### Notification System
- [ ] Notification panel opens/closes
- [ ] Unread badge shows correct count
- [ ] Notifications display all fields
- [ ] Filtering works by level
- [ ] Mark as read works
- [ ] Mark all as read works
- [ ] OSC 99 sequences are parsed
- [ ] Multiple notifications work
- [ ] Timestamps are formatted

### Socket API
- [ ] Socket connects successfully
- [ ] Workspace creation via socket works
- [ ] Active workspace can be set
- [ ] Notifications can be added via socket
- [ ] Multiple commands work
- [ ] Auto-reconnection works
- [ ] Invalid commands are handled

### Workflow Execution
- [ ] Workflows can be created
- [ ] Nodes can be added
- [ ] Connections can be drawn
- [ ] Start node can be set
- [ ] Workflows execute
- [ ] Execution history tracks steps
- [ ] Status updates correctly
- [ ] Conditional logic works
- [ ] Loops execute correctly

---

## 🎓 Advanced Test Scenarios

### Scenario 1: Multi-Workspace Notification Routing
```bash
# Send notifications to different workspaces
printf "\033]99;{\"title\":\"Test 1\",\"body\":\"For workspace-1\",\"workspaceId\":\"workspace-1\"}\007"
printf "\033]99;{\"title\":\"Test 2\",\"body\":\"For workspace-2\",\"workspaceId\":\"workspace-2\"}\007"
```
- Verify notifications route to correct workspaces
- Check if workspace highlighting works

### Scenario 2: High-Frequency Socket Commands
```bash
# Send 100 commands rapidly
for i in {1..100}; do
  echo "{\"command\":\"notification.add\",\"args\":{\"title\":\"Test $i\"}}" | nc localhost 7676
  sleep 0.01
done
```
- Verify app handles high throughput
- Check for memory leaks

### Scenario 3: Invalid OSC Sequences
```bash
# Send malformed OSC sequences
printf "\033]99;{invalid json}\007"
printf "\033]99;\007"
printf "\033]99;"
```
- Verify app doesn't crash
- Check for error handling

---

## 📝 Test Results Log

Record your test results here:

| Test | Status | Notes |
|------|--------|-------|
| Workspace Creation | ☐ Passed ☐ Failed | |
| Git Branch Detection | ☐ Passed ☐ Failed | |
| Active Workspace Highlight | ☐ Passed ☐ Failed | |
| Notification Panel Open | ☐ Passed ☐ Failed | |
| OSC 99 Parsing | ☐ Passed ☐ Failed | |
| Notification Filtering | ☐ Passed ☐ Failed | |
| Mark as Read | ☐ Passed ☐ Failed | |
| Socket Connection | ☐ Passed ☐ Failed | |
| Socket Commands | ☐ Passed ☐ Failed | |
| Auto-Reconnection | ☐ Passed ☐ Failed | |
| Workflow Creation | ☐ Passed ☐ Failed | |
| Workflow Execution | ☐ Passed ☐ Failed | |

---

## 🚀 Next Steps

After testing:
1. **Report issues** via GitHub Issues
2. **Check logs** in terminal for errors
3. **Verify dependencies** are up-to-date
4. **Run full test suite**: `make check`
5. **Test all three features** together for integration

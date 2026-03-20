# Browser Integration Testing Guide

This guide provides comprehensive test flows for the browser integration feature, including both embedded webview and external browser automation via agent-browser.

---

## 🌐 Test Flow 1: Embedded Webview

### Prerequisites
```bash
cd .git/worktrees/browser-integration
make setup  # Install dependencies
make app     # Run Tauri app
```

### Steps

1. **Open BrowserPanel**
   - Locate the BrowserPanel component in the UI
   - Click "Open Browser" button
   - A new webview window should open (1200x800px)

2. **Navigate to URL**
   - In the address bar, enter: `https://example.com`
   - Press Enter or click the refresh button (↻)
   - Browser should navigate to the page

3. **Test Navigation History**
   - Navigate to multiple URLs: `https://example.com`, `https://example.org`, `https://example.net`
   - Click back button (←) - should go to previous URL
   - Click forward button (→) - should go forward in history
   - History should track all visited URLs

4. **Use DevTools Console**
   - Click "Console" tab in DevTools panel
   - In the textarea, enter JavaScript:
     ```javascript
     document.title
     ```
   - Click "Run" button
   - Expected output: `"Example Domain"`
   - Try more queries:
     ```javascript
     document.querySelectorAll('h1')?.[0]?.textContent
     document.querySelectorAll('p').length
     window.location.href
     ```

### What to Verify

- ✅ Webview window creates successfully
- ✅ Navigation works to new URLs
- ✅ Back/forward navigation works correctly
- ✅ History tracks all URLs
- ✅ JavaScript executes in webview context
- ✅ Console output displays correctly formatted JSON
- ✅ Close button (✕) closes the webview window

---

## 🤖 Test Flow 2: External Browser Automation

### Prerequisites
```bash
# Install agent-browser globally
npm install -g agent-browser

# Download Chrome for Testing (first time only)
agent-browser install

cd .git/worktrees/browser-integration
make app
```

### Steps

1. **Open Browser Automation Panel**
   - Locate the BrowserAutomation component in the UI
   - You should see "No active browser session"

2. **Create Browser Session**
   - Enter URL in the input field: `https://example.com`
   - Click "Open" button
   - Wait for page snapshot to load

3. **Inspect Page Snapshot**
   - In "Page Snapshot" panel, you should see an element tree
   - Example elements:
     - `<button>` with attributes and ref (e.g., `@e1`)
     - `<input>` or `<textarea>` with ref (e.g., `@e2`)
     - `<div>` elements with structure
   - Each element shows:
     - Tag name
     - Text content (if any)
     - Role attribute (if any)
     - Ref ID for interaction

4. **Click an Element**
   - Find a `<button>` element with ref `@e1`
   - Click the "Click" button next to it
   - Check "Action History" panel
   - Expected entry: `Click @e1`
   - Page snapshot should refresh to show updated state

5. **Fill an Input Field**
   - Find an `<input>` element with ref `@e2`
   - Click the input field
   - Type: `test value`
   - Press Enter
   - Check "Action History" panel
   - Expected entry: `Fill @e2: "test value"`
   - Snapshot refreshes to show updated input value

6. **Take Screenshot** (if available)
   - Navigate to a different URL
   - Click "Refresh" to update snapshot
   - Verify the snapshot shows the new page

### What to Verify

- ✅ agent-browser spawns Chrome process
- ✅ Page snapshot loads with accessible elements
- ✅ Element refs (`@e1`, `@e2`, etc.) are generated
- ✅ Click actions execute successfully
- ✅ Fill actions populate form fields correctly
- ✅ Action history tracks all interactions chronologically
- ✅ Snapshot updates after each action
- ✅ Errors are handled gracefully (e.g., element not found)

---

## 🔧 Test Flow 3: DevTools JavaScript Execution

### Prerequisites
```bash
cd .git/worktrees/browser-integration
make app

# Ensure you have an active webview window open
```

### Steps

1. **Open Webview with URL**
   - Click "Open Browser" if not already open
   - Navigate to `https://example.com`

2. **Open DevTools Panel**
   - DevTools panel should be visible below the toolbar

3. **Execute Basic Queries**
   - In the console textarea, enter:
     ```javascript
     document.querySelector('h1')?.textContent
     ```
   - Click "Run"
   - Expected output: `"Example Domain"`

4. **Query Multiple Elements**
   ```javascript
   document.querySelectorAll('p').length
   ```
   - Expected output: Number (e.g., `2` or more)

5. **Read Page Properties**
   ```javascript
   window.location.href
   ```
   - Expected output: Current URL

6. **Modify DOM**
   ```javascript
   document.querySelector('h1')?.style.color = 'red'
   ```
   - Expected output: `null` (style set)
   - Visual change: Heading should turn red

7. **Error Handling**
   ```javascript
   document.querySelector('.non-existent')?.textContent
   ```
   - Expected output: `null` or `undefined`
   - Console should not crash

8. **Complex Query**
   ```javascript
   Array.from(document.querySelectorAll('a')).map(a => ({
     href: a.href,
     text: a.textContent
   }))
   ```
   - Expected output: Array of link objects

### What to Verify

- ✅ JavaScript executes in webview context
- ✅ Can query DOM elements by selector
- ✅ Can read element properties and content
- ✅ Can modify DOM elements
- ✅ Can query multiple elements at once
- ✅ Output displays correctly formatted JSON
- ✅ Null/undefined values handled gracefully
- ✅ Complex queries return expected data structures
- ✅ Console errors are displayed when they occur

---

## 🎯 Test Flow 4: Integration Test (WebView + Automation)

### Prerequisites
```bash
cd .git/worktrees/browser-integration
make app

# Have both BrowserPanel and BrowserAutomation components accessible
```

### Steps

1. **Open Embedded Webview**
   - Use BrowserPanel to open `https://example.com`
   - Note the page title: `"Example Domain"`

2. **Open External Browser**
   - Use BrowserAutomation to open same URL
   - Wait for snapshot to load

3. **Compare States**
   - Both should show the same page elements
   - Verify element counts match
   - Check that both can interact with the page

4. **Cross-Communication Test**
   - In embedded webview DevTools, execute:
     ```javascript
     localStorage.setItem('test-key', 'test-value')
     ```
   - In external browser (via agent-browser), execute:
     ```javascript
     localStorage.getItem('test-key')
     ```
   - Note: These are separate browser instances, so values may differ

### What to Verify

- ✅ Both browser types can open the same URL
- ✅ Page snapshots are consistent
- ✅ DevTools works in embedded webview
- ✅ Automation works with external browser
- ✅ Both systems can run independently
- ✅ Browser instances are properly isolated

---

## 🐛 Troubleshooting

### Webview Issues

**Problem**: Webview window doesn't open
- **Check Tauri permissions** in `tauri.conf.json`
- **Verify window creation** in Rust logs
- **Try different URL**: `https://www.google.com`

**Problem**: JavaScript doesn't execute
- **Check DevTools console** for errors
- **Verify webview label** is correct
- **Ensure webview is loaded** before executing scripts

### Agent-Browser Issues

**Problem**: `agent-browser: command not found`
- **Install globally**: `npm install -g agent-browser`
- **Verify installation**: `which agent-browser`
- **Reinstall**: `npm uninstall -g agent-browser && npm install -g agent-browser`

**Problem**: Chrome doesn't download
- **Run**: `agent-browser install`
- **Check network connection**
- **Verify Chrome for Testing URL is accessible

**Problem**: Snapshot returns empty or errors
- **Check page is fully loaded** before snapshot
- **Try a simpler page**: `https://example.com`
- **Verify agent-browser version**: `agent-browser --version`

### General Issues

**Problem**: App crashes when opening browser
- **Check Rust logs**: Look for panics or errors
- **Verify Cargo.toml**: All dependencies are correct
- **Rebuild**: `cd src-tauri && cargo clean && cargo build`

**Problem**: TypeScript errors in frontend
- **Check types**: Ensure `@tauri-apps/api/core` is imported
- **Verify store imports**: Check paths to `browser.ts`
- **Run build**: `npm run build` to see all errors

---

## 📊 Test Checklist

Use this checklist to verify all functionality:

### Embedded Webview
- [ ] Webview window opens
- [ ] Navigation to new URLs works
- [ ] Back/forward buttons work
- [ ] History tracks all URLs
- [ ] JavaScript executes
- [ ] Console output displays correctly
- [ ] Close button works

### External Browser Automation
- [ ] agent-browser spawns Chrome
- [ ] Page snapshot loads
- [ ] Element refs are generated
- [ ] Click actions execute
- [ ] Fill actions work
- [ ] Action history tracks all interactions
- [ ] Snapshot updates after actions
- [ ] Screenshot functionality works

### DevTools
- [ ] Can query single elements
- [ ] Can query multiple elements
- [ ] Can read element properties
- [ ] Can modify DOM
- [ ] Error handling works
- [ ] Output displays correctly

---

## 🎓 Advanced Test Scenarios

### Scenario 1: Multi-Tab Browsing
```bash
# Test with multiple webviews
```
1. Open webview 1 with `https://example.com`
2. Open webview 2 with `https://example.org`
3. Navigate between them
4. Verify histories are independent

### Scenario 2: Complex JavaScript
```javascript
// Test complex DOM manipulation
const form = document.querySelector('form');
const formData = new FormData(form);
Object.fromEntries(formData);
```

### Scenario 3: Error Recovery
```javascript
// Test error handling
try {
  document.querySelector('.invalid').click();
} catch (error) {
  console.error('Expected error:', error.message);
}
```

---

## 📝 Test Results Log

Record your test results here:

| Test | Status | Notes |
|------|--------|-------|
| Webview Opens | ☐ Passed ☐ Failed | |
| Navigation | ☐ Passed ☐ Failed | |
| JS Execution | ☐ Passed ☐ Failed | |
| Agent-Browser Spawns | ☐ Passed ☐ Failed | |
| Page Snapshot | ☐ Passed ☐ Failed | |
| Click Actions | ☐ Passed ☐ Failed | |
| Fill Actions | ☐ Passed ☐ Failed | |
| Action History | ☐ Passed ☐ Failed | |

---

## 🚀 Next Steps

After testing:
1. **Report issues** via GitHub Issues
2. **Check logs** in terminal for errors
3. **Verify dependencies** are up-to-date
4. **Run full test suite**: `make check`

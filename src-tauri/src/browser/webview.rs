use tauri::{WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
async fn browser_create_webview(
    url: String,
    label: String,
    width: u32,
    height: u32,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let webview_label = format!("browser-{}", label);

    let webview = WebviewWindowBuilder::new(&app, &webview_label, WebviewUrl::App("browser.html".into()))
        .title(url.clone())
        .inner_size(width, height)
        .center()
        .build()
        .map_err(|e| e.to_string())?;

    webview.set_url(url).map_err(|e| e.to_string())?;

    Ok(webview_label)
}

#[tauri::command]
async fn browser_navigate(
    webview_label: String,
    url: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let webview = app.get_webview_window(&webview_label)
        .ok_or("Webview not found")?;

    webview.set_url(url).map_err(|e| e.to_string())
}

#[tauri::command]
async fn browser_execute_script(
    webview_label: String,
    script: String,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let webview = app.get_webview_window(&webview_label)
        .ok_or("Webview not found")?;

    webview.eval(script).map_err(|e| e.to_string())
}

#[tauri::command]
async fn browser_close(
    webview_label: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let webview = app.get_webview_window(&webview_label)
        .ok_or("Webview not found")?;

    webview.close().map_err(|e| e.to_string())
}

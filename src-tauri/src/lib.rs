use tauri::Manager;

#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! Welcome to VoidLink.", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Apply native macOS vibrancy at startup.
            // NSVisualEffectState::Active keeps the blur alive even when
            // the window is not focused — avoids the "blur disappears on
            // focus loss" issue that CSS backdrop-filter has in WKWebView.
            #[cfg(target_os = "macos")]
            {
                let window = app.get_webview_window("main").unwrap();
                apply_vibrancy(
                    &window,
                    NSVisualEffectMaterial::HudWindow,
                    Some(NSVisualEffectState::Active),
                    None,
                )
                .expect("apply_vibrancy failed");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn greet_returns_message() {
        assert_eq!(greet("World"), "Hello, World! Welcome to VoidLink.");
    }

    #[test]
    fn greet_empty_name() {
        assert_eq!(greet(""), "Hello, ! Welcome to VoidLink.");
    }
}

use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

/// How often the Rust side nudges the webview. Policy (has 6 hours passed
/// since the last search? is the schedule paused?) lives in TypeScript where
/// it can read settings and be unit-tested; this is just a metronome.
const SCHEDULER_TICK_SECS: u64 = 30 * 60;

// -----------------------------------------------------------------------------
// Secrets
// -----------------------------------------------------------------------------
//
// API keys live in a JSON file under the app's config directory — NOT in
// SQLite (SPEC §4 forbids it) and not in localStorage. This is the Phase 3
// interim before the OS keychain arrives in Phase 4; both commands keep the
// same signature so swapping the backing store will not touch the UI.
// See docs/DECISIONS.md.

fn secrets_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not find the app's settings folder: {e}"))?;
    fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create the app's settings folder: {e}"))?;
    Ok(dir.join("secrets.json"))
}

fn read_secrets(app: &AppHandle) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let path = secrets_path(app)?;
    if !path.exists() {
        return Ok(serde_json::Map::new());
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("could not read keys: {e}"))?;
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(serde_json::Value::Object(map)) => Ok(map),
        // A corrupt file must not brick the app; the user just re-enters keys.
        _ => Ok(serde_json::Map::new()),
    }
}

#[tauri::command]
fn get_secret(app: AppHandle, name: String) -> Result<Option<String>, String> {
    let secrets = read_secrets(&app)?;
    Ok(secrets.get(&name).and_then(|v| v.as_str()).map(String::from))
}

#[tauri::command]
fn set_secret(app: AppHandle, name: String, value: String) -> Result<(), String> {
    let mut secrets = read_secrets(&app)?;
    if value.is_empty() {
        secrets.remove(&name);
    } else {
        secrets.insert(name, serde_json::Value::String(value));
    }
    let path = secrets_path(&app)?;
    fs::write(&path, serde_json::to_string_pretty(&secrets).unwrap_or_default())
        .map_err(|e| format!("could not save the key: {e}"))
}

/// Write a file the user picked in a save dialog. The dialog is the consent
/// step; this command only ever writes bytes handed to it by our own UI and
/// never reads anything back.
#[tauri::command]
fn write_user_file(path: String, contents_base64: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(contents_base64)
        .map_err(|e| format!("could not decode the file data: {e}"))?;
    fs::write(&path, bytes).map_err(|e| format!("could not save the file: {e}"))
}

// -----------------------------------------------------------------------------
// App
// -----------------------------------------------------------------------------

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Must be the first plugin registered (its docs are explicit about this).
    // A second launch focuses the existing window instead of starting over.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        // Migrations are deliberately NOT declared here.
        //
        // The schema lives in src/core/db/migrations.ts so that one definition
        // serves the app, the headless CLI harness, and vitest. Declaring it in
        // Rust instead would fork the schema across two languages and make it
        // invisible to everything except the packaged app.
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_secret,
            set_secret,
            write_user_file
        ])
        .setup(|app| {
            // --- tray -------------------------------------------------------
            let search = MenuItem::with_id(app, "search_now", "Search for jobs now", true, None::<&str>)?;
            let open = MenuItem::with_id(app, "open", "Open Cincinnatus", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&search, &open, &quit])?;

            let mut tray = TrayIconBuilder::with_id("main-tray")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .tooltip("Cincinnatus")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "search_now" => {
                        show_main_window(app);
                        let _ = app.emit("search-now", ());
                    }
                    "open" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            // --- scheduler metronome ---------------------------------------
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(SCHEDULER_TICK_SECS));
                let _ = handle.emit("scheduler-tick", ());
            });

            Ok(())
        })
        // Closing the window hides to the tray; the scheduler keeps running.
        // Quit lives in the tray menu.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

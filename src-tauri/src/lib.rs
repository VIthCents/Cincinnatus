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
// API keys live in the OS keychain — Windows Credential Manager, macOS
// Keychain Services — never in SQLite (SPEC §4 forbids it), never in
// localStorage, and no longer in a plaintext file.
//
// Until Phase 4 they were a plaintext JSON file, which meant a user's Anthropic
// key — a credential with real billing attached — sat readable on disk by any
// process running as them, and got swept into OneDrive and Time Machine
// backups. `migrate_secrets` moves anything left in that file and then
// deletes it.
//
// Not stronghold: that is not an OS keychain at all but an encrypted vault file
// needing a passphrase, which for this audience means either a prompt on every
// launch or storing the passphrase in the keychain anyway. It also trades a
// trivially recoverable secret (revoke and regenerate in 30 seconds) for an
// unrecoverable one (forget the passphrase and the vault is gone). See
// docs/DECISIONS.md.

const KEYCHAIN_SERVICE: &str = "io.github.cincinnatus";

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

fn entry(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, name)
        .map_err(|e| format!("could not reach the key store: {e}"))
}

#[tauri::command]
fn get_secret(app: AppHandle, name: String) -> Result<Option<String>, String> {
    match entry(&name)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => {
            // Falls back to the old file so a user who has not been migrated
            // yet — or whose migration is still pending a retry — keeps working.
            let secrets = read_secrets(&app)?;
            Ok(secrets.get(&name).and_then(|v| v.as_str()).map(String::from))
        }
        Err(e) => Err(format!("could not read the key: {e}")),
    }
}

#[tauri::command]
fn set_secret(name: String, value: String) -> Result<(), String> {
    let entry = entry(&name)?;
    if value.is_empty() {
        return match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("could not remove the key: {e}")),
        };
    }
    entry
        .set_password(&value)
        .map_err(|e| format!("could not save the key: {e}"))
}

/// Move any keys still in the old plaintext file into the keychain, then delete
/// it. Runs once at startup and is safe to interrupt at any point.
///
/// The invariant is that plaintext is never deleted until every key has been
/// read back out of the keychain and byte-compared. A successful write is not
/// evidence the value is retrievable, and a migration that loses someone's key
/// is worse than the plaintext it was fixing. If anything fails to verify,
/// nothing is deleted and the next launch tries again.
fn migrate_secrets(app: &AppHandle) -> Result<(), String> {
    let path = secrets_path(app)?;
    if !path.exists() {
        return Ok(());
    }

    let secrets = read_secrets(app)?;
    for (name, value) in secrets.iter() {
        let Some(text) = value.as_str() else { continue };
        if text.is_empty() {
            continue;
        }
        let entry = entry(name)?;
        entry
            .set_password(text)
            .map_err(|e| format!("could not move a key into the key store: {e}"))?;
        match entry.get_password() {
            Ok(read_back) if read_back == text => {}
            Ok(_) => return Err("a key did not survive the move".into()),
            Err(e) => return Err(format!("could not confirm a key moved: {e}")),
        }
    }

    // Truncate before unlinking: an interruption here leaves an empty file
    // rather than a half-written one holding part of a key.
    fs::write(&path, "{}").map_err(|e| format!("could not clear the old key file: {e}"))?;
    fs::remove_file(&path).map_err(|e| format!("could not remove the old key file: {e}"))
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
            // --- secrets ----------------------------------------------------
            // Move anything left in the old plaintext file into the keychain.
            // A failure here is not fatal: migrate_secrets deletes nothing it
            // could not verify, so the keys are still readable from the file
            // and get_secret still falls back to it. Starting the app is more
            // important than finishing the move, and the next launch retries.
            if let Err(message) = migrate_secrets(app.handle()) {
                eprintln!("could not move saved keys into the key store: {message}");
            }

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

#[cfg(test)]
mod tests {
    use super::KEYCHAIN_SERVICE;

    /// Proves the app can actually store and retrieve a credential in the OS
    /// keychain on this machine. Ignored by default because it touches real
    /// per-user OS state, which a CI runner may not have unlocked:
    ///
    ///     cargo test -- --ignored
    #[test]
    #[ignore]
    fn keychain_round_trip() {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, "test_only_scratch").unwrap();
        entry.set_password("sk-ant-not-a-real-key").unwrap();
        assert_eq!(entry.get_password().unwrap(), "sk-ant-not-a-real-key");
        entry.delete_credential().unwrap();
        assert!(matches!(
            entry.get_password(),
            Err(keyring::Error::NoEntry)
        ));
    }
}

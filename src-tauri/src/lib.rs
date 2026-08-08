#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Migrations are deliberately NOT declared here.
        //
        // The schema lives in src/core/db/migrations.ts so that one definition
        // serves the app, the headless CLI harness, and vitest. Declaring it in
        // Rust instead would fork the schema across two languages and make it
        // invisible to everything except the packaged app.
        .plugin(tauri_plugin_sql::Builder::default().build())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

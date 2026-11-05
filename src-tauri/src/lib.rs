mod error;
mod packs;
mod paths;
mod server;
mod stats;
mod updates;

use serde_json::Value;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::error::AppResult;
use crate::packs::PackStatus;
use crate::updates::{
    ContentUpdateInfo, DesktopInfo, InstallResult, LauncherUpdateInfo,
};

#[tauri::command]
fn get_desktop_info(app: AppHandle) -> AppResult<DesktopInfo> {
    let catalog = packs::read_catalog(&app)?;
    Ok(DesktopInfo {
        launcher_version: catalog.launcher.version,
        app_data: paths::app_data_root(&app)?.display().to_string(),
        platform: std::env::consts::OS.to_string(),
    })
}

#[tauri::command]
fn list_installed_packs(app: AppHandle) -> AppResult<Vec<PackStatus>> {
    packs::list_packs(&app)
}

#[tauri::command]
fn seed_local_packs(app: AppHandle) -> AppResult<Vec<PackStatus>> {
    updates::seed_bundled_packs(&app)
}

#[tauri::command]
fn verify_file_sha256(path: String, expected: String) -> AppResult<()> {
    packs::verify_sha256(std::path::Path::new(&path), &expected)
}

#[tauri::command]
async fn check_launcher_update(app: AppHandle) -> AppResult<LauncherUpdateInfo> {
    updates::check_launcher_update(&app).await
}

#[tauri::command]
async fn check_content_updates(app: AppHandle) -> AppResult<Vec<ContentUpdateInfo>> {
    updates::check_content_updates(&app).await
}

#[tauri::command]
async fn install_content_pack(
    app: AppHandle,
    game_id: String,
    download_url: String,
    expected_sha256: Option<String>,
) -> AppResult<InstallResult> {
    updates::install_content_pack(&app, &game_id, &download_url, expected_sha256).await
}

#[tauri::command]
async fn open_external_url(url: String) -> AppResult<()> {
    tauri_plugin_opener::open_url(url, None::<String>)
        .map_err(|e| error::AppError::msg(format!("open url: {e}")))
}

#[tauri::command]
fn load_player_stats(app: AppHandle, key: String) -> AppResult<Option<Value>> {
    stats::load(&app, &key)
}

#[tauri::command]
fn save_player_stats(app: AppHandle, key: String, stats: Value) -> AppResult<()> {
    stats::save(&app, &key, &stats)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_desktop_info,
            list_installed_packs,
            seed_local_packs,
            verify_file_sha256,
            check_launcher_update,
            check_content_updates,
            install_content_pack,
            open_external_url,
            load_player_stats,
            save_player_stats,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            // Seed app-data from bundled packs so updates have a writable tree.
            let _ = updates::seed_bundled_packs(&handle);

            // `tauri dev` already serves via beforeDevCommand (scripts/serve.mjs on :8787).
            // Release builds need our embedded static server + navigation.
            if cfg!(debug_assertions) {
                return Ok(());
            }

            let roots = server::roots_for(&handle)?;
            let port = server::spawn(roots)?;
            let url = server::local_url(port, "/shell/");

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.navigate(url.parse().map_err(|e| {
                    std::io::Error::new(std::io::ErrorKind::InvalidInput, format!("{e}"))
                })?);
            } else {
                WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse()?))
                    .title("Hortelano's Daily")
                    .inner_size(980.0, 740.0)
                    .build()?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Hortelano's Daily");
}

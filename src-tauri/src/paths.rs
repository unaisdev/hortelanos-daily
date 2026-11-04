use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

pub fn app_data_root(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::msg(format!("app_data_dir: {e}")))?;
    Ok(dir)
}

pub fn games_data_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(app_data_root(app)?.join("games"))
}

pub fn game_data_dir(app: &AppHandle, game_id: &str) -> AppResult<PathBuf> {
    validate_game_id(game_id)?;
    Ok(games_data_dir(app)?.join(game_id))
}

/// Repo / frontend root used while developing (`cargo tauri dev`).
pub fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn looks_like_static_root(dir: &Path) -> bool {
    dir.join("shell").join("index.html").is_file()
}

/// Static files root: in prod, Tauri resource dir; in dev, the git checkout.
///
/// On Windows, `resource_dir()` is the folder that contains the exe, so portable
/// zips must ship `shell/`, `runner/`, … next to the binary (not under `resources/`).
pub fn static_root(app: &AppHandle) -> AppResult<PathBuf> {
    if cfg!(debug_assertions) {
        return Ok(project_root());
    }
    let resource = app
        .path()
        .resource_dir()
        .map_err(|e| AppError::msg(format!("resource_dir: {e}")))?;
    if looks_like_static_root(&resource) {
        return Ok(resource);
    }
    // Fallbacks for mis-packaged portable layouts.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            if looks_like_static_root(exe_dir) {
                return Ok(exe_dir.to_path_buf());
            }
            let nested = exe_dir.join("resources");
            if looks_like_static_root(&nested) {
                return Ok(nested);
            }
        }
    }
    Ok(resource)
}

pub fn catalog_path(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(static_root(app)?.join("catalog").join("catalog.json"))
}

pub fn validate_game_id(game_id: &str) -> AppResult<()> {
    if game_id.is_empty()
        || game_id.len() > 64
        || !game_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::msg("game id inválido"));
    }
    Ok(())
}

pub fn ensure_dir(path: &Path) -> AppResult<()> {
    std::fs::create_dir_all(path)?;
    Ok(())
}

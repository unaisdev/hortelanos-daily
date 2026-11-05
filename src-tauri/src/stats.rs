//! Durable player stats on disk (app_data), independent of WebView localStorage origin.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use tauri::AppHandle;

use crate::error::{AppError, AppResult};
use crate::paths::{self, ensure_dir};

pub fn stats_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(paths::app_data_root(app)?.join("stats"))
}

fn validate_stats_key(key: &str) -> AppResult<()> {
    if key.is_empty() || key.len() > 128 {
        return Err(AppError::msg("stats key inválida"));
    }
    if !key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == ':' || c == '-' || c == '_' || c == '.')
    {
        return Err(AppError::msg("stats key inválida"));
    }
    Ok(())
}

fn filename_for_key(key: &str) -> AppResult<String> {
    validate_stats_key(key)?;
    // `hortelano:dailyred:stats` → `hortelano__dailyred__stats.json`
    Ok(format!("{}.json", key.replace(':', "__")))
}

fn stats_path(app: &AppHandle, key: &str) -> AppResult<PathBuf> {
    Ok(stats_dir(app)?.join(filename_for_key(key)?))
}

pub fn load_from_path(path: &Path) -> AppResult<Option<Value>> {
    if !path.is_file() {
        return Ok(None);
    }
    let text = fs::read_to_string(path)?;
    let value = serde_json::from_str(&text)
        .map_err(|e| AppError::msg(format!("stats corruptas: {e}")))?;
    Ok(Some(value))
}

pub fn save_to_path(path: &Path, stats: &Value) -> AppResult<()> {
    if !stats.is_object() {
        return Err(AppError::msg("stats deben ser un objeto JSON"));
    }
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(stats)
        .map_err(|e| AppError::msg(format!("serializar stats: {e}")))?;
    fs::write(&tmp, text)?;
    // Windows cannot rename over an existing file.
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

pub fn load(app: &AppHandle, key: &str) -> AppResult<Option<Value>> {
    load_from_path(&stats_path(app, key)?)
}

pub fn save(app: &AppHandle, key: &str, stats: &Value) -> AppResult<()> {
    save_to_path(&stats_path(app, key)?, stats)
}

#[cfg(test)]
mod tests {
    use super::{filename_for_key, load_from_path, save_to_path, validate_stats_key};
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_file(name: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("hortelano-stats-{name}-{nanos}.json"))
    }

    #[test]
    fn accepts_manifest_keys() {
        assert!(validate_stats_key("hortelano:dailyred:stats").is_ok());
        assert!(validate_stats_key("hortelano:dailygold:stats").is_ok());
    }

    #[test]
    fn rejects_path_traversal() {
        assert!(validate_stats_key("../etc/passwd").is_err());
        assert!(validate_stats_key("a/b").is_err());
    }

    #[test]
    fn filename_replaces_colons() {
        assert_eq!(
            filename_for_key("hortelano:dailyred:stats").unwrap(),
            "hortelano__dailyred__stats.json"
        );
    }

    #[test]
    fn roundtrip_persists_wins_and_battles() {
        let path = temp_file("roundtrip");
        let stats = json!({
            "wins": 3,
            "losses": 2,
            "winStreak": 1,
            "dayStreak": 4,
            "lastPlayed": "2026-11-05",
            "lastResult": "won",
            "pending": null
        });
        save_to_path(&path, &stats).unwrap();
        let loaded = load_from_path(&path).unwrap().expect("file exists");
        assert_eq!(loaded["wins"], 3);
        assert_eq!(loaded["losses"], 2);
        assert_eq!(loaded["lastPlayed"], "2026-11-05");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn load_missing_file_returns_none() {
        let path = temp_file("missing");
        let _ = std::fs::remove_file(&path);
        assert!(load_from_path(&path).unwrap().is_none());
    }

    #[test]
    fn overwrite_keeps_latest() {
        let path = temp_file("overwrite");
        save_to_path(&path, &json!({ "wins": 1, "losses": 0 })).unwrap();
        save_to_path(&path, &json!({ "wins": 5, "losses": 1 })).unwrap();
        let loaded = load_from_path(&path).unwrap().unwrap();
        assert_eq!(loaded["wins"], 5);
        assert_eq!(loaded["losses"], 1);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rejects_non_object_stats() {
        let path = temp_file("bad");
        let err = save_to_path(&path, &json!([1, 2, 3])).unwrap_err();
        assert!(err.to_string().contains("objeto"));
    }
}

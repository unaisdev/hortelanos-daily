use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::AppHandle;

use crate::error::{AppError, AppResult};
use crate::paths;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogGame {
    pub id: String,
    pub name: String,
    pub boss: Option<String>,
    pub blurb: Option<String>,
    pub content_version: String,
    pub protocol_id: String,
    pub pack_path: String,
    pub content: Option<ContentPointer>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentPointer {
    pub repo: String,
    pub asset: String,
    pub tag_prefix: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub schema_version: Option<u32>,
    pub launcher: LauncherMeta,
    pub games: Vec<CatalogGame>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherMeta {
    pub id: String,
    pub name: String,
    pub version: String,
    pub min_protocol_adapters: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackStatus {
    pub id: String,
    pub name: String,
    pub playable: bool,
    pub reason: String,
    pub content_version: String,
    pub protocol_id: String,
    pub source: String,
    pub pack_dir: String,
    pub recommended_version: String,
    pub content: Option<ContentPointer>,
    pub manifest: Option<Value>,
}

pub fn read_catalog(app: &AppHandle) -> AppResult<Catalog> {
    let path = paths::catalog_path(app)?;
    let raw = fs::read_to_string(&path)
        .map_err(|e| AppError::msg(format!("no se pudo leer {}: {e}", path.display())))?;
    Ok(serde_json::from_str(&raw)?)
}

pub fn resolve_pack_dir(app: &AppHandle, game: &CatalogGame) -> AppResult<(PathBuf, &'static str)> {
    let overlay = paths::game_data_dir(app, &game.id)?;
    if overlay.join("game.manifest.json").is_file() {
        return Ok((overlay, "app-data"));
    }
    let bundled = paths::static_root(app)?.join(&game.pack_path);
    if bundled.join("game.manifest.json").is_file() {
        return Ok((bundled, "bundled"));
    }
    Ok((overlay, "missing"))
}

pub fn inspect_pack(app: &AppHandle, game: &CatalogGame) -> AppResult<PackStatus> {
    let (pack_dir, source) = resolve_pack_dir(app, game)?;
    let manifest_path = pack_dir.join("game.manifest.json");
    if !manifest_path.is_file() {
        return Ok(PackStatus {
            id: game.id.clone(),
            name: game.name.clone(),
            playable: false,
            reason: "sin content pack / manifest".into(),
            content_version: "0.0.0".into(),
            protocol_id: game.protocol_id.clone(),
            source: source.into(),
            pack_dir: pack_dir.display().to_string(),
            recommended_version: game.content_version.clone(),
            content: game.content.clone(),
            manifest: None,
        });
    }

    let manifest: Value = serde_json::from_str(&fs::read_to_string(&manifest_path)?)?;
    let content_version = manifest
        .get("contentVersion")
        .and_then(|v| v.as_str())
        .unwrap_or("0.0.0")
        .to_string();
    let protocol_id = manifest
        .get("protocolId")
        .and_then(|v| v.as_str())
        .unwrap_or(game.protocol_id.as_str())
        .to_string();

    if manifest.get("status").and_then(|v| v.as_str()) == Some("awaiting-content-pack") {
        return Ok(PackStatus {
            id: game.id.clone(),
            name: game.name.clone(),
            playable: false,
            reason: "sin content pack / ROM".into(),
            content_version,
            protocol_id,
            source: source.into(),
            pack_dir: pack_dir.display().to_string(),
            recommended_version: game.content_version.clone(),
            content: game.content.clone(),
            manifest: Some(manifest),
        });
    }

    let rom_rel = manifest
        .pointer("/rom/path")
        .and_then(|v| v.as_str())
        .unwrap_or("rom/dailyred.gba.gz");
    let rom_path = pack_dir.join(rom_rel);
    let playable = rom_path.is_file();
    let reason = if playable {
        String::new()
    } else {
        format!("ROM no encontrada ({rom_rel})")
    };

    Ok(PackStatus {
        id: game.id.clone(),
        name: game.name.clone(),
        playable,
        reason,
        content_version,
        protocol_id,
        source: source.into(),
        pack_dir: pack_dir.display().to_string(),
        recommended_version: game.content_version.clone(),
        content: game.content.clone(),
        manifest: Some(manifest),
    })
}

pub fn list_packs(app: &AppHandle) -> AppResult<Vec<PackStatus>> {
    let catalog = read_catalog(app)?;
    catalog
        .games
        .iter()
        .map(|g| inspect_pack(app, g))
        .collect()
}

pub fn sha256_file(path: &std::path::Path) -> AppResult<String> {
    let data = fs::read(path)?;
    let mut hasher = Sha256::new();
    hasher.update(&data);
    Ok(hex::encode(hasher.finalize()))
}

pub fn verify_sha256(path: &std::path::Path, expected: &str) -> AppResult<()> {
    let actual = sha256_file(path)?;
    let expected = expected.trim().to_lowercase();
    if actual != expected {
        return Err(AppError::msg(format!(
            "SHA-256 mismatch: expected {expected}, got {actual}"
        )));
    }
    Ok(())
}

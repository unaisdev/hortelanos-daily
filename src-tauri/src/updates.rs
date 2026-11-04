use std::fs::{self, File};
use std::io::{copy, Write};
use std::path::Path;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use zip::ZipArchive;

use crate::error::{AppError, AppResult};
use crate::packs::{self, CatalogGame, ContentPointer, PackStatus};
use crate::paths;

const LAUNCHER_REPO: &str = "unaisdev/hortelanos-daily";
const USER_AGENT: &str = "hortelanos-daily/0.2.0";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherUpdateInfo {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub html_url: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentUpdateInfo {
    pub game_id: String,
    pub name: String,
    pub local_version: String,
    pub remote_version: Option<String>,
    pub update_available: bool,
    pub download_url: Option<String>,
    pub asset_name: Option<String>,
    pub sha256: Option<String>,
    pub html_url: Option<String>,
    pub reason: String,
}

#[derive(Debug, Deserialize)]
struct GhRelease {
    tag_name: String,
    html_url: String,
    body: Option<String>,
    assets: Vec<GhAsset>,
}

#[derive(Debug, Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
}

fn client() -> AppResult<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()?)
}

fn strip_tag(tag: &str, prefix: &str) -> String {
    let t = tag.trim().trim_start_matches('v');
    if let Some(rest) = t.strip_prefix(prefix) {
        rest.trim_start_matches('v').to_string()
    } else if let Some(rest) = tag.strip_prefix(prefix) {
        rest.trim_start_matches('v').to_string()
    } else {
        t.to_string()
    }
}

fn is_newer(remote: &str, local: &str) -> AppResult<bool> {
    let remote = semver::Version::parse(remote.trim_start_matches('v'))?;
    let local = semver::Version::parse(local.trim_start_matches('v'))?;
    Ok(remote > local)
}

pub async fn check_launcher_update(app: &AppHandle) -> AppResult<LauncherUpdateInfo> {
    let catalog = packs::read_catalog(app)?;
    let current = catalog.launcher.version.clone();
    let url = format!("https://api.github.com/repos/{LAUNCHER_REPO}/releases/latest");
    let response = client()?.get(&url).send().await?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(LauncherUpdateInfo {
            current_version: current,
            latest_version: None,
            update_available: false,
            html_url: Some(format!("https://github.com/{LAUNCHER_REPO}/releases")),
            notes: Some("Aún no hay releases del launcher.".into()),
        });
    }
    if !response.status().is_success() {
        return Err(AppError::msg(format!(
            "GitHub API launcher: HTTP {}",
            response.status()
        )));
    }
    let release: GhRelease = response.json().await?;
    let latest = strip_tag(&release.tag_name, "");
    let update_available = is_newer(&latest, &current).unwrap_or(false);
    Ok(LauncherUpdateInfo {
        current_version: current,
        latest_version: Some(latest),
        update_available,
        html_url: Some(release.html_url),
        notes: release.body,
    })
}

pub async fn check_content_updates(app: &AppHandle) -> AppResult<Vec<ContentUpdateInfo>> {
    let catalog = packs::read_catalog(app)?;
    let mut out = Vec::new();
    for game in &catalog.games {
        out.push(check_one_content(app, game).await?);
    }
    Ok(out)
}

async fn check_one_content(app: &AppHandle, game: &CatalogGame) -> AppResult<ContentUpdateInfo> {
    let status = packs::inspect_pack(app, game)?;
    let Some(content) = &game.content else {
        return Ok(ContentUpdateInfo {
            game_id: game.id.clone(),
            name: game.name.clone(),
            local_version: status.content_version,
            remote_version: None,
            update_available: false,
            download_url: None,
            asset_name: None,
            sha256: None,
            html_url: None,
            reason: "sin puntero de content en catálogo".into(),
        });
    };

    let tag_prefix = content.tag_prefix.clone().unwrap_or_else(|| "content-v".into());
    let url = format!("https://api.github.com/repos/{}/releases/latest", content.repo);
    let response = client()?.get(&url).send().await?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(ContentUpdateInfo {
            game_id: game.id.clone(),
            name: game.name.clone(),
            local_version: status.content_version,
            remote_version: None,
            update_available: false,
            download_url: None,
            asset_name: Some(content.asset.clone()),
            sha256: None,
            html_url: Some(format!("https://github.com/{}/releases", content.repo)),
            reason: "el repo fuente aún no tiene Releases".into(),
        });
    }
    if !response.status().is_success() {
        return Err(AppError::msg(format!(
            "GitHub API {}: HTTP {}",
            content.repo,
            response.status()
        )));
    }
    let release: GhRelease = response.json().await?;
    let remote_version = strip_tag(&release.tag_name, &tag_prefix);
    let asset = release
        .assets
        .iter()
        .find(|a| a.name == content.asset || a.name.contains(&game.id));
    let sha_asset = release
        .assets
        .iter()
        .find(|a| a.name.contains("SHA256") || a.name.ends_with(".sha256"));

    let mut sha256 = None;
    if let Some(sha_asset) = sha_asset {
        if let Ok(text) = client()?.get(&sha_asset.browser_download_url).send().await {
            if let Ok(body) = text.text().await {
                sha256 = parse_sha_line(&body, &content.asset);
            }
        }
    }

    let update_available = is_newer(&remote_version, &status.content_version).unwrap_or(false)
        || (!status.playable && asset.is_some());

    Ok(ContentUpdateInfo {
        game_id: game.id.clone(),
        name: game.name.clone(),
        local_version: status.content_version,
        remote_version: Some(remote_version),
        update_available,
        download_url: asset.map(|a| a.browser_download_url.clone()),
        asset_name: asset.map(|a| a.name.clone()).or_else(|| Some(content.asset.clone())),
        sha256,
        html_url: Some(release.html_url),
        reason: if asset.is_none() {
            format!("Release sin asset {}", content.asset)
        } else {
            String::new()
        },
    })
}

fn parse_sha_line(body: &str, asset_name: &str) -> Option<String> {
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let name = parts.next().unwrap_or("");
        let name = name.trim_start_matches('*');
        if name.is_empty() || name == asset_name || asset_name.ends_with(name) {
            if hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()) {
                return Some(hash.to_lowercase());
            }
        }
    }
    None
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub game_id: String,
    pub content_version: String,
    pub pack_dir: String,
    pub sha256: String,
}

pub async fn install_content_pack(
    app: &AppHandle,
    game_id: &str,
    download_url: &str,
    expected_sha256: Option<String>,
) -> AppResult<InstallResult> {
    paths::validate_game_id(game_id)?;
    let catalog = packs::read_catalog(app)?;
    let game = catalog
        .games
        .iter()
        .find(|g| g.id == game_id)
        .ok_or_else(|| AppError::msg(format!("juego desconocido: {game_id}")))?
        .clone();

    let tmp_root = paths::app_data_root(app)?.join("tmp");
    paths::ensure_dir(&tmp_root)?;
    let zip_path = tmp_root.join(format!("{game_id}-download.zip"));
    download_file(download_url, &zip_path).await?;

    let sha = packs::sha256_file(&zip_path)?;
    if let Some(expected) = expected_sha256.as_deref() {
        if !expected.is_empty() {
            packs::verify_sha256(&zip_path, expected)?;
        }
    }

    let dest = paths::game_data_dir(app, game_id)?;
    let staging = paths::app_data_root(app)?.join(format!("games/.staging-{game_id}"));
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    paths::ensure_dir(&staging)?;
    extract_zip(&zip_path, &staging)?;

    if !staging.join("game.manifest.json").is_file() {
        let _ = fs::remove_dir_all(&staging);
        let _ = fs::remove_file(&zip_path);
        return Err(AppError::msg(
            "el zip no contiene game.manifest.json en la raíz del pack",
        ));
    }

    if dest.exists() {
        fs::remove_dir_all(&dest)?;
    }
    fs::rename(&staging, &dest)?;
    let _ = fs::remove_file(&zip_path);

    let status = packs::inspect_pack(app, &game)?;
    Ok(InstallResult {
        game_id: game_id.to_string(),
        content_version: status.content_version,
        pack_dir: status.pack_dir,
        sha256: sha,
    })
}

async fn download_file(url: &str, dest: &Path) -> AppResult<()> {
    let response = client()?.get(url).send().await?;
    if !response.status().is_success() {
        return Err(AppError::msg(format!(
            "descarga fallida HTTP {} desde {url}",
            response.status()
        )));
    }
    let mut stream = response.bytes_stream();
    let mut file = File::create(dest)?;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        file.write_all(&chunk)?;
    }
    file.flush()?;
    Ok(())
}

fn extract_zip(zip_path: &Path, dest: &Path) -> AppResult<()> {
    let file = File::open(zip_path)?;
    let mut archive = ZipArchive::new(file)?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let name = entry
            .enclosed_name()
            .ok_or_else(|| AppError::msg("entrada zip insegura"))?
            .to_path_buf();
        let out_path = dest.join(&name);
        if entry.is_dir() {
            paths::ensure_dir(&out_path)?;
        } else {
            if let Some(parent) = out_path.parent() {
                paths::ensure_dir(parent)?;
            }
            let mut outfile = File::create(&out_path)?;
            copy(&mut entry, &mut outfile)?;
        }
    }
    Ok(())
}

pub fn seed_bundled_packs(app: &AppHandle) -> AppResult<Vec<PackStatus>> {
    let catalog = packs::read_catalog(app)?;
    for game in &catalog.games {
        let dest = paths::game_data_dir(app, &game.id)?;
        if dest.join("game.manifest.json").is_file() {
            continue;
        }
        let bundled = paths::static_root(app)?.join(&game.pack_path);
        if bundled.join("game.manifest.json").is_file() {
            copy_dir_recursive(&bundled, &dest)?;
        }
    }
    packs::list_packs(app)
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> AppResult<()> {
    paths::ensure_dir(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let target = dest.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else if ty.is_file() {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

#[allow(dead_code)]
pub fn content_pointer(game: &CatalogGame) -> Option<&ContentPointer> {
    game.content.as_ref()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopInfo {
    pub launcher_version: String,
    pub app_data: String,
    pub platform: String,
}

use std::fs::{self, File};
use std::io::{copy, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use zip::ZipArchive;

use crate::error::{AppError, AppResult};
use crate::packs::{self, CatalogGame, ContentPointer, PackStatus};
use crate::paths;

const LAUNCHER_REPO: &str = "unaisdev/hortelanos-daily";
const USER_AGENT: &str = "hortelanos-daily/1.1.1";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherUpdateInfo {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub html_url: Option<String>,
    pub notes: Option<String>,
    /// ISO-8601 publication date of the release (GitHub `published_at`).
    pub published_at: Option<String>,
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
    pub notes: Option<String>,
    pub published_at: Option<String>,
    pub reason: String,
}

#[derive(Debug, Deserialize)]
struct GhRelease {
    tag_name: String,
    html_url: String,
    body: Option<String>,
    published_at: Option<String>,
    assets: Vec<GhAsset>,
}

#[derive(Debug, Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
}

pub(crate) fn client() -> AppResult<reqwest::Client> {
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

pub(crate) fn is_newer(remote: &str, local: &str) -> AppResult<bool> {
    let remote = semver::Version::parse(remote.trim_start_matches('v'))?;
    let local = semver::Version::parse(local.trim_start_matches('v'))?;
    Ok(remote > local)
}

pub async fn check_launcher_update(app: &AppHandle) -> AppResult<LauncherUpdateInfo> {
    let current = app.package_info().version.to_string();
    let url = format!("https://api.github.com/repos/{LAUNCHER_REPO}/releases/latest");
    let response = client()?.get(&url).send().await?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(LauncherUpdateInfo {
            current_version: current,
            latest_version: None,
            update_available: false,
            html_url: Some(format!("https://github.com/{LAUNCHER_REPO}/releases")),
            notes: Some("Aún no hay releases del launcher.".into()),
            published_at: None,
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
        published_at: release.published_at,
    })
}

const PROGRESS_EVENT: &str = "launcher-update-progress";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProgress {
    /// "downloading" while bytes arrive, "installing" right before the app restarts.
    phase: &'static str,
    version: String,
    downloaded: u64,
    total: Option<u64>,
}

/// Reports launcher-update progress to the UI (event `launcher-update-progress`).
/// Throttled: one event per 1% when the size is known, per 128 KiB otherwise.
pub(crate) struct ProgressReporter {
    app: AppHandle,
    version: String,
    downloaded: u64,
    total: Option<u64>,
    last_step: Option<u64>,
}

impl ProgressReporter {
    pub(crate) fn new(app: &AppHandle, version: &str) -> Self {
        Self {
            app: app.clone(),
            version: version.to_string(),
            downloaded: 0,
            total: None,
            last_step: None,
        }
    }

    fn emit(&self, phase: &'static str) {
        let _ = self.app.emit(
            PROGRESS_EVENT,
            UpdateProgress {
                phase,
                version: self.version.clone(),
                downloaded: self.downloaded,
                total: self.total,
            },
        );
    }

    /// `len` new bytes arrived; `total` is the full size when the server says it.
    pub(crate) fn chunk(&mut self, len: u64, total: Option<u64>) {
        self.downloaded += len;
        if total.is_some() {
            self.total = total;
        }
        let step = match self.total {
            Some(t) if t > 0 => self.downloaded * 100 / t,
            _ => self.downloaded / (128 * 1024),
        };
        if self.last_step != Some(step) {
            self.last_step = Some(step);
            self.emit("downloading");
        }
    }

    /// The download is done; the app is about to install and restart. Gives the UI a moment
    /// to paint it, because on Windows the process exits as soon as the installer starts.
    pub(crate) async fn installing(&mut self) {
        if let Some(t) = self.total {
            self.downloaded = t;
        }
        self.emit("installing");
        tokio::time::sleep(std::time::Duration::from_millis(700)).await;
    }
}

const PENDING_UPDATE_FILE: &str = "pending-update.json";
/// A marker older than this is stale (the player probably never reopened the app).
const PENDING_UPDATE_MAX_AGE_SECS: u64 = 24 * 60 * 60;

/// Written right before the installer starts. The installer runs after the launcher has
/// exited, so a failure there can't be shown at that moment: the next start reads this.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct PendingUpdate {
    from: String,
    to: String,
    at: u64,
}

/// An installer run that did not end up replacing the launcher.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateFailure {
    pub from: String,
    pub to: String,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn pending_update_path(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(paths::app_data_root(app)?.join(PENDING_UPDATE_FILE))
}

/// Best effort: a missing marker only means a failed install goes unreported.
fn mark_update_started(app: &AppHandle, from: &str, to: &str) {
    let write = || -> AppResult<()> {
        let path = pending_update_path(app)?;
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let marker = PendingUpdate { from: from.into(), to: to.into(), at: now_secs() };
        fs::write(path, serde_json::to_vec(&marker)?)?;
        Ok(())
    };
    let _ = write();
}

fn clear_update_marker(app: &AppHandle) {
    if let Ok(path) = pending_update_path(app) {
        let _ = fs::remove_file(path);
    }
}

/// Did the update recorded in `pending` fail? Unparseable versions never count as a failure.
fn judge_pending(pending: &PendingUpdate, current: &str, now: u64) -> Option<UpdateFailure> {
    let current = semver::Version::parse(current.trim_start_matches('v')).ok()?;
    let target = semver::Version::parse(pending.to.trim_start_matches('v')).ok()?;
    if current >= target {
        return None; // it worked (or we are already past it)
    }
    if now.saturating_sub(pending.at) > PENDING_UPDATE_MAX_AGE_SECS {
        return None;
    }
    Some(UpdateFailure { from: pending.from.clone(), to: pending.to.clone() })
}

/// Reads and removes the marker. `Some` when the last launcher update did not complete.
pub fn take_update_failure(app: &AppHandle) -> AppResult<Option<UpdateFailure>> {
    let path = pending_update_path(app)?;
    let Ok(raw) = fs::read(&path) else { return Ok(None) };
    let _ = fs::remove_file(&path);
    let Ok(pending) = serde_json::from_slice::<PendingUpdate>(&raw) else { return Ok(None) };
    Ok(judge_pending(&pending, &app.package_info().version.to_string(), now_secs()))
}

/// In-place launcher update via tauri-plugin-updater (signed with our own key;
/// no OS certificate needed). Returns None if already up to date.
/// On success the app restarts and this call never returns.
pub async fn install_launcher_update(app: &AppHandle) -> AppResult<Option<String>> {
    use tauri_plugin_updater::UpdaterExt;
    // Unzipped portable folder: the installer-based plugin can't update it.
    if crate::portable::is_portable() {
        return crate::portable::install_update(app).await;
    }
    let updater = app
        .updater()
        .map_err(|e| AppError::msg(format!("updater: {e}")))?;
    let Some(update) = updater
        .check()
        .await
        .map_err(|e| AppError::msg(format!("updater check: {e}")))?
    else {
        return Ok(None);
    };
    let version = update.version.clone();
    let mut progress = ProgressReporter::new(app, &version);
    progress.chunk(0, None);
    let bytes = update
        .download(|chunk, total| progress.chunk(chunk as u64, total), || {})
        .await
        .map_err(|e| AppError::msg(format!("updater download {version}: {e}")))?;
    progress.installing().await;
    // Windows: starts the installer (passive: it shows its own progress window) and exits the
    // process here, so `install` never returns. macOS/Linux: swaps the app in place and
    // returns, then we restart.
    let current = app.package_info().version.to_string();
    mark_update_started(app, &current, &version);
    if let Err(e) = update.install(bytes) {
        // The installer could not even start: we are still alive, so report it right now.
        clear_update_marker(app);
        return Err(AppError::msg(format!("updater install {version}: {e}")));
    }
    app.restart()
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
            notes: None,
            published_at: None,
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
            notes: None,
            published_at: None,
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
        notes: release.body,
        published_at: release.published_at,
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
    packs::write_pack_origin(&dest, "github")?;
    let _ = fs::remove_file(&zip_path);

    let status = packs::inspect_pack(app, &game)?;
    Ok(InstallResult {
        game_id: game_id.to_string(),
        content_version: status.content_version,
        pack_dir: status.pack_dir,
        sha256: sha,
    })
}

pub(crate) async fn download_file(url: &str, dest: &Path) -> AppResult<()> {
    download_file_with_progress(url, dest, |_, _| {}).await
}

/// Like `download_file`, calling `on_chunk(bytes_in_chunk, total_size)` as data arrives.
pub(crate) async fn download_file_with_progress(
    url: &str,
    dest: &Path,
    mut on_chunk: impl FnMut(u64, Option<u64>),
) -> AppResult<()> {
    let response = client()?.get(url).send().await?;
    if !response.status().is_success() {
        return Err(AppError::msg(format!(
            "descarga fallida HTTP {} desde {url}",
            response.status()
        )));
    }
    let total = response.content_length();
    let mut stream = response.bytes_stream();
    let mut file = File::create(dest)?;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        file.write_all(&chunk)?;
        on_chunk(chunk.len() as u64, total);
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
            packs::write_pack_origin(&dest, "bundled")?;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn pending(from: &str, to: &str, at: u64) -> PendingUpdate {
        PendingUpdate { from: from.into(), to: to.into(), at }
    }

    #[test]
    fn update_that_took_effect_is_not_a_failure() {
        let p = pending("2.5.1", "2.5.2", 1000);
        assert_eq!(judge_pending(&p, "2.5.2", 1100), None);
        assert_eq!(judge_pending(&p, "v2.6.0", 1100), None, "already past the target");
    }

    #[test]
    fn installer_that_left_the_old_version_is_reported() {
        let p = pending("2.5.1", "2.5.2", 1000);
        assert_eq!(
            judge_pending(&p, "2.5.1", 1100),
            Some(UpdateFailure { from: "2.5.1".into(), to: "2.5.2".into() })
        );
    }

    #[test]
    fn stale_or_garbled_markers_never_nag() {
        let old = pending("2.5.1", "2.5.2", 1000);
        assert_eq!(judge_pending(&old, "2.5.1", 1000 + PENDING_UPDATE_MAX_AGE_SECS + 1), None);
        assert_eq!(judge_pending(&pending("2.5.1", "garbage", 1000), "2.5.1", 1100), None);
        assert_eq!(judge_pending(&pending("2.5.1", "2.5.2", 1000), "garbage", 1100), None);
    }

    #[test]
    fn marker_roundtrips_through_json() {
        let p = pending("2.5.1", "2.5.2", 42);
        let back: PendingUpdate = serde_json::from_slice(&serde_json::to_vec(&p).unwrap()).unwrap();
        assert_eq!(back, p);
    }
}

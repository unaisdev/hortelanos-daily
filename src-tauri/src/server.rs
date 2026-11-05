use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::thread;

use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

use crate::error::{AppError, AppResult};
use crate::paths;

#[derive(Clone)]
pub struct StaticRoots {
    pub bundled: PathBuf,
    pub games_overlay: PathBuf,
}

/// Stable loopback port so WebView `localStorage` (wins / battles / streaks)
/// keeps the same origin across launcher restarts. A random port (`:0`) would
/// reset stats every session because origin includes the port.
pub const PREFERRED_PORT: u16 = 18787;

pub fn spawn(roots: StaticRoots) -> AppResult<u16> {
    let server = bind_loopback()?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or_else(|| AppError::msg("no se pudo leer el puerto HTTP local"))?;

    let roots = Arc::new(roots);
    thread::spawn(move || {
        for request in server.incoming_requests() {
            let roots = Arc::clone(&roots);
            // Handle each request on its own thread so parallel module/ROM
            // fetches from the WebView are not serialized behind large assets.
            thread::spawn(move || {
                let _ = handle(request, &roots);
            });
        }
    });

    Ok(port)
}

fn bind_loopback() -> AppResult<Server> {
    let preferred = format!("127.0.0.1:{PREFERRED_PORT}");
    match Server::http(&preferred) {
        Ok(server) => Ok(server),
        Err(preferred_err) => {
            // Another Hortelano instance (or leftover bind) owns the port.
            // Do not fall back to a random port — that would orphan localStorage.
            Err(AppError::msg(format!(
                "no se pudo enlazar {preferred} ({preferred_err}). \
                 Cierra otra instancia de Hortelano's Daily e inténtalo de nuevo."
            )))
        }
    }
}

fn handle(request: Request, roots: &StaticRoots) -> AppResult<()> {
    if request.method() != &Method::Get && request.method() != &Method::Head {
        let response = Response::from_string("Method Not Allowed").with_status_code(StatusCode(405));
        let _ = request.respond(response);
        return Ok(());
    }

    let url = request.url().split('?').next().unwrap_or("/");
    let rel = percent_decode(url.trim_start_matches('/'));
    let file = resolve_file(roots, &rel);

    match file {
        Some(path) => {
            let mime = mime_for_path(&path);
            if request.method() == &Method::Head {
                let len = fs::metadata(&path)?.len();
                let mut response = Response::empty(StatusCode(200));
                add_common_headers(&mut response, &mime);
                if let Ok(header) = Header::from_bytes("Content-Length", len.to_string()) {
                    response.add_header(header);
                }
                let _ = request.respond(response);
            } else {
                let data = fs::read(&path)?;
                let mut response = Response::from_data(data);
                add_common_headers(&mut response, &mime);
                let _ = request.respond(response);
            }
        }
        None => {
            let hint = if rel.is_empty() || rel == "shell" || rel.starts_with("shell/") {
                "Not found — missing shell/ next to the app (portable zip incomplete?)."
            } else {
                "Not found"
            };
            let response = Response::from_string(hint).with_status_code(StatusCode(404));
            let _ = request.respond(response);
        }
    }
    Ok(())
}

fn mime_for_path(path: &Path) -> String {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8".into(),
        "js" | "mjs" => "text/javascript; charset=utf-8".into(),
        "css" => "text/css; charset=utf-8".into(),
        "json" => "application/json; charset=utf-8".into(),
        "wasm" => "application/wasm".into(),
        "png" => "image/png".into(),
        "jpg" | "jpeg" => "image/jpeg".into(),
        "gif" => "image/gif".into(),
        "svg" => "image/svg+xml".into(),
        "woff2" => "font/woff2".into(),
        "webm" => "video/webm".into(),
        "mp4" => "video/mp4".into(),
        "gz" => "application/gzip".into(),
        "gba" => "application/octet-stream".into(),
        "txt" | "md" => "text/plain; charset=utf-8".into(),
        _ => mime_guess::from_path(path)
            .first_or_octet_stream()
            .essence_str()
            .to_string(),
    }
}

fn add_common_headers<R: std::io::Read>(response: &mut Response<R>, mime: &str) {
    if let Ok(header) = Header::from_bytes("Content-Type", mime) {
        response.add_header(header);
    }
    if let Ok(header) = Header::from_bytes("Cache-Control", "no-cache") {
        response.add_header(header);
    }
    if let Ok(header) = Header::from_bytes("Access-Control-Allow-Origin", "*") {
        response.add_header(header);
    }
    // Help WKWebView treat module scripts / wasm consistently.
    if let Ok(header) = Header::from_bytes("Cross-Origin-Resource-Policy", "cross-origin") {
        response.add_header(header);
    }
}

fn resolve_file(roots: &StaticRoots, rel: &str) -> Option<PathBuf> {
    let clean = normalize_rel(rel)?;
    if clean.is_empty() || clean == Path::new(".") {
        return first_existing(&[
            roots.bundled.join("shell").join("index.html"),
            roots.bundled.join("index.html"),
        ]);
    }

    // Prefer app-data overlay for games/<id>/…
    if let Ok(stripped) = clean.strip_prefix("games") {
        let overlay = roots.games_overlay.join(stripped);
        if overlay.is_file() {
            return Some(overlay);
        }
        if overlay.is_dir() {
            let index = overlay.join("index.html");
            if index.is_file() {
                return Some(index);
            }
        }
    }

    let bundled = roots.bundled.join(&clean);
    if bundled.is_file() {
        return Some(bundled);
    }
    if bundled.is_dir() {
        let index = bundled.join("index.html");
        if index.is_file() {
            return Some(index);
        }
    }
    None
}

fn first_existing(paths: &[PathBuf]) -> Option<PathBuf> {
    paths.iter().find(|p| p.is_file()).cloned()
}

fn normalize_rel(rel: &str) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for component in Path::new(rel).components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    Some(out)
}

fn percent_decode(input: &str) -> String {
    // Path decoding only: keep literal '+' (protocol files use names like
    // dailyred-conf-v2+status-v1.js). Treating '+' as space is for query forms.
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (from_hex(bytes[i + 1]), from_hex(bytes[i + 2])) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn from_hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

pub fn roots_for(app: &tauri::AppHandle) -> AppResult<StaticRoots> {
    let bundled = paths::static_root(app)?;
    let games_overlay = paths::games_data_dir(app)?;
    paths::ensure_dir(&games_overlay)?;
    Ok(StaticRoots {
        bundled,
        games_overlay,
    })
}

pub fn local_url(port: u16, path: &str) -> String {
    let path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    format!("http://127.0.0.1:{port}{path}")
}

#[cfg(test)]
mod tests {
    use super::{bind_loopback, percent_decode, PREFERRED_PORT};

    #[test]
    fn keeps_plus_in_protocol_filenames() {
        assert_eq!(
            percent_decode("runner/protocols/dailyred-conf-v2+status-v1.js"),
            "runner/protocols/dailyred-conf-v2+status-v1.js"
        );
    }

    #[test]
    fn decodes_percent_sequences() {
        assert_eq!(percent_decode("shell/assets/logo%20hortelano.png"), "shell/assets/logo hortelano.png");
    }

    #[test]
    fn preferred_port_is_stable_not_ephemeral() {
        assert_ne!(PREFERRED_PORT, 0);
        assert_eq!(PREFERRED_PORT, 18787);
    }

    #[test]
    fn bind_loopback_uses_preferred_port() {
        let server = match bind_loopback() {
            Ok(s) => s,
            Err(err) => {
                // Another process may own the port on this machine; skip rather than flake.
                eprintln!("skip bind_loopback_uses_preferred_port: {err}");
                return;
            }
        };
        let port = server.server_addr().to_ip().map(|a| a.port()).unwrap();
        assert_eq!(port, PREFERRED_PORT);
        drop(server);
    }
}

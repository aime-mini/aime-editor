//! Web pages shown as pages: the View side of an .html file.
//!
//! A page is more than its own text - it pulls in the stylesheets, scripts and
//! pictures beside it by relative address - so it is served rather than poured
//! into an iframe. Served through a URI scheme of the app's own, not a loopback
//! port: nothing else on the machine can reach it, and nothing has to listen.
//!
//! Every preview is fenced into one folder, the workspace it was opened from.
//! The address names that folder by a random token, never by its path, and a
//! request that climbs out of it (`../`, a link elsewhere) is refused - a page
//! from a cloned repository can read the repository it came with, and nothing
//! else on the disk.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use percent_encoding::percent_decode_str;
use ring::rand::{SecureRandom, SystemRandom};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime, State, UriSchemeContext, UriSchemeResponder};

/// The scheme pages are served under. On Windows the webview spells it
/// `http://aime-page.localhost/`, elsewhere `aime-page://localhost/`.
pub const SCHEME: &str = "aime-page";

/// Bytes of randomness in a folder's token.
const TOKEN_BYTES: usize = 16;

/// The folders previews may read, by the token their addresses carry.
#[derive(Default)]
pub struct PagePreviews {
    roots: Mutex<HashMap<String, PathBuf>>,
}

impl PagePreviews {
    fn roots(&self) -> std::sync::MutexGuard<'_, HashMap<String, PathBuf>> {
        self.roots.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The token for `root`, made the first time the folder is asked for.
    fn token_for(&self, root: PathBuf) -> Result<String, String> {
        let mut roots = self.roots();
        if let Some((token, _)) = roots.iter().find(|(_, known)| **known == root) {
            return Ok(token.clone());
        }
        let token = random_token()?;
        roots.insert(token.clone(), root);
        Ok(token)
    }

    fn root_of(&self, token: &str) -> Option<PathBuf> {
        self.roots().get(token).cloned()
    }
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; TOKEN_BYTES];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| "the system gave no randomness for a preview address".to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Opens `root` to previews and answers the token their addresses start with.
#[tauri::command]
pub fn page_preview_root(state: State<'_, PagePreviews>, root: String) -> Result<String, String> {
    let canonical =
        dunce::canonicalize(&root).map_err(|e| format!("could not open {root} for a preview: {e}"))?;
    state.token_for(canonical)
}

/// Answers one request for a previewed page or anything it pulls in. Read off
/// the webview's thread: a page with a few hundred assets must not stall it.
pub fn serve<R: Runtime>(
    context: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app: AppHandle<R> = context.app_handle().clone();
    let path = request.uri().path().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let previews = app.state::<PagePreviews>();
        responder.respond(answer(&previews, &path));
    });
}

fn answer(previews: &PagePreviews, request_path: &str) -> Response<Vec<u8>> {
    match resolve(previews, request_path) {
        Ok(file) => match std::fs::read(&file) {
            Ok(bytes) => respond(StatusCode::OK, mime_of(&file), bytes),
            Err(error) => not_found(&error.to_string()),
        },
        Err(Refusal::Unknown) => not_found("no such file in the previewed folder"),
        Err(Refusal::OutsideRoot) => respond(
            StatusCode::FORBIDDEN,
            "text/plain; charset=utf-8",
            b"outside the previewed folder".to_vec(),
        ),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Refusal {
    Unknown,
    OutsideRoot,
}

/// The file `/<token>/<path in the folder>` names, provided it is inside it.
fn resolve(previews: &PagePreviews, request_path: &str) -> Result<PathBuf, Refusal> {
    let decoded = percent_decode_str(request_path)
        .decode_utf8()
        .map_err(|_| Refusal::Unknown)?;
    let (token, inside) = decoded
        .trim_start_matches('/')
        .split_once('/')
        .ok_or(Refusal::Unknown)?;
    let root = previews.root_of(token).ok_or(Refusal::Unknown)?;
    let file = dunce::canonicalize(root.join(inside)).map_err(|_| Refusal::Unknown)?;
    // Canonical on both sides, so neither `..` nor a link can step out.
    if !file.starts_with(&root) {
        return Err(Refusal::OutsideRoot);
    }
    if file.is_dir() {
        let index = file.join("index.html");
        return if index.is_file() {
            Ok(index)
        } else {
            Err(Refusal::Unknown)
        };
    }
    Ok(file)
}

fn not_found(reason: &str) -> Response<Vec<u8>> {
    respond(
        StatusCode::NOT_FOUND,
        "text/plain; charset=utf-8",
        reason.as_bytes().to_vec(),
    )
}

fn respond(status: StatusCode, mime: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        // A page is previewed to see the edit just saved, never a copy of the last one.
        .header(header::CACHE_CONTROL, "no-store")
        // The preview frame is sandboxed into an origin of its own, and a module
        // script or a `fetch` of the page's own data is a cross-origin request.
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// The content type a browser needs to use a file for what it is - a script
/// served as plain text does not run, and a stylesheet does not apply.
fn mime_of(file: &Path) -> &'static str {
    let extension = file
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match extension.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json",
        "txt" | "md" => "text/plain; charset=utf-8",
        "xml" => "application/xml",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A folder with a page, its stylesheet in a subfolder, and a secret beside
    /// the folder - the file a page must never reach.
    fn site(name: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("aime-page-{name}"));
        let root = base.join("site");
        std::fs::create_dir_all(root.join("css")).expect("site folder");
        std::fs::write(root.join("index.html"), "<link href=\"css/app.css\">").expect("page");
        std::fs::write(root.join("css").join("app.css"), "body{}").expect("stylesheet");
        std::fs::write(base.join("secret.txt"), "key").expect("secret");
        (dunce::canonicalize(&root).expect("canonical root"), base)
    }

    #[test]
    fn a_page_reaches_the_files_beside_it_by_relative_address() {
        let (root, base) = site("relative");
        let previews = PagePreviews::default();
        let token = previews.token_for(root.clone()).expect("token");

        let file = resolve(&previews, &format!("/{token}/css/app.css")).expect("the stylesheet");
        assert_eq!(file, root.join("css").join("app.css"));
        assert_eq!(mime_of(&file), "text/css; charset=utf-8");
        let folder = resolve(&previews, &format!("/{token}/")).expect("the folder's index");
        assert_eq!(folder, root.join("index.html"));
        std::fs::remove_dir_all(base).ok();
    }

    #[test]
    fn nothing_outside_the_previewed_folder_is_served() {
        let (root, base) = site("fence");
        let previews = PagePreviews::default();
        let token = previews.token_for(root).expect("token");

        for climb in ["../secret.txt", "%2E%2E/secret.txt", "css/../../secret.txt"] {
            assert_eq!(
                resolve(&previews, &format!("/{token}/{climb}")),
                Err(Refusal::OutsideRoot),
                "{climb} stepped out of the folder"
            );
        }
        assert_eq!(
            resolve(&previews, "/not-a-token/index.html"),
            Err(Refusal::Unknown),
            "a folder nobody opened is not served"
        );
        std::fs::remove_dir_all(base).ok();
    }

    #[test]
    fn the_same_folder_keeps_one_token() {
        let (root, base) = site("token");
        let previews = PagePreviews::default();
        let first = previews.token_for(root.clone()).expect("token");
        assert_eq!(previews.token_for(root).expect("token"), first);
        assert_eq!(first.len(), TOKEN_BYTES * 2);
        std::fs::remove_dir_all(base).ok();
    }
}

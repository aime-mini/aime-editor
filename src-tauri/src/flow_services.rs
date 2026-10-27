//! What a flow reaches outside the repository with: HTTP calls, mail, the
//! secrets both need, OAuth for the services that insist on it, and the trust
//! record of a flow that arrived through git.
//!
//! Secrets live in the operating system's store through the `keyring` crate
//! (Windows Credential Manager, macOS Keychain, Linux Secret Service) under
//! one service name; a flow file only ever names them, `{{secret.NAME}}`, and
//! only this module substitutes them - the frontend never sees a value, and
//! an error that would echo one has it masked. A Linux machine without a
//! Secret Service is told so in the error, with nothing written to a file.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// The service every Aime secret is filed under in the OS store.
const SERVICE: &str = "aime-flows";
/// Secrets have no listing in most stores, so their names are kept here.
const NAMES_FILE: &str = "flow-secrets.json";
const TRUST_FILE: &str = "flow-trust.json";
const HTTP_TIMEOUT: Duration = Duration::from_secs(60);
/// The most a step's value may be - an HTTP body, a command's output. Every
/// value is written into the run's journal and handed whole to the steps
/// after it, so a step that meets more fails rather than pass on a value cut
/// short; a whole file belongs on disk, read by a Files step.
pub(crate) const VALUE_LIMIT: usize = 2 * 1024 * 1024;
const SECRET_OPEN: &str = "{{secret.";

// ---- secrets --------------------------------------------------------------------

/// Stores a secret under `name`; the value never comes back through the frontend.
#[tauri::command]
pub fn secret_set(app: AppHandle, name: String, value: String) -> Result<(), String> {
    check_name(&name)?;
    entry(&name)?
        .set_password(&value)
        .map_err(|e| store_error(&e.to_string()))?;
    let mut names = known_names(&app)?;
    if !names.contains(&name) {
        names.push(name);
        names.sort();
        write_names(&app, &names)?;
    }
    Ok(())
}

#[tauri::command]
pub fn secret_delete(app: AppHandle, name: String) -> Result<(), String> {
    check_name(&name)?;
    match entry(&name)?.delete_credential() {
        Ok(()) => {}
        Err(keyring::Error::NoEntry) => {}
        Err(e) => return Err(store_error(&e.to_string())),
    }
    let names: Vec<String> = known_names(&app)?.into_iter().filter(|n| n != &name).collect();
    write_names(&app, &names)
}

/// The names of the secrets on this machine - never the values.
#[tauri::command]
pub fn secret_names(app: AppHandle) -> Result<Vec<String>, String> {
    known_names(&app)
}

fn entry(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, name).map_err(|e| store_error(&e.to_string()))
}

fn check_name(name: &str) -> Result<(), String> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.');
    ok.then_some(())
        .ok_or_else(|| format!("'{name}' is not a secret name: letters, digits, _ - . only"))
}

/// The store's own words, with the one case a person can act on said plainly.
fn store_error(text: &str) -> String {
    if cfg!(target_os = "linux")
        && (text.contains("Secret Service") || text.contains("dbus") || text.contains("D-Bus"))
    {
        return format!(
            "no Secret Service on this machine ({text}). Install one for your desktop (gnome-keyring or KWallet, `secret-service` on Arch) and sign in to it; Aime keeps no secret in a plain file."
        );
    }
    format!("the OS secret store answered: {text}")
}

fn names_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(NAMES_FILE))
}

fn known_names(app: &AppHandle) -> Result<Vec<String>, String> {
    match fs::read(names_file(app)?) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(err) => Err(err.to_string()),
    }
}

fn write_names(app: &AppHandle, names: &[String]) -> Result<(), String> {
    let file = names_file(app)?;
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(file, serde_json::to_vec_pretty(names).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// `{{secret.NAME}}` in `text`, each replaced by its value; the values are
/// returned too so an error can be masked afterwards.
fn fill_secrets(text: &str) -> Result<(String, Vec<String>), String> {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    let mut values = Vec::new();
    while let Some(start) = rest.find(SECRET_OPEN) {
        out.push_str(&rest[..start]);
        let after = &rest[start + SECRET_OPEN.len()..];
        let Some(end) = after.find("}}") else {
            return Err("a {{secret.…}} is not closed".into());
        };
        let name = after[..end].trim();
        check_name(name)?;
        let value = entry(name)?.get_password().map_err(|e| match e {
            keyring::Error::NoEntry => {
                format!("no secret named '{name}' on this machine - add it under Flows → Connections")
            }
            other => store_error(&other.to_string()),
        })?;
        out.push_str(&value);
        values.push(value);
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    Ok((out, values))
}

fn masked(text: &str, values: &[String]) -> String {
    values
        .iter()
        .filter(|v| !v.is_empty())
        .fold(text.to_string(), |acc, v| acc.replace(v.as_str(), "•••"))
}

// ---- http -------------------------------------------------------------------------

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    pub body: Option<String>,
    /// "json" reads the body as JSON (text when it is not); "text" keeps it as is.
    #[serde(default = "default_parse")]
    pub parse: String,
    pub timeout_ms: Option<u64>,
}

fn default_parse() -> String {
    "json".into()
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: Value,
}

/// One HTTP call with the secrets filled in here and nowhere else.
#[tauri::command]
pub async fn flow_http(request: HttpRequest) -> Result<HttpResponse, String> {
    let (url, mut values) = fill_secrets(&request.url)?;
    let mut headers = BTreeMap::new();
    for (name, value) in &request.headers {
        let (filled, used) = fill_secrets(value)?;
        values.extend(used);
        headers.insert(name.clone(), filled);
    }
    let body = match &request.body {
        Some(text) => {
            let (filled, used) = fill_secrets(text)?;
            values.extend(used);
            Some(filled)
        }
        None => None,
    };
    let method = reqwest::Method::from_bytes(request.method.to_uppercase().as_bytes())
        .map_err(|_| format!("'{}' is not an HTTP method", request.method))?;
    let client = crate::trackers::http::client().map_err(|e| e.to_string())?;
    let mut call = client
        .request(method, &url)
        .timeout(request.timeout_ms.map_or(HTTP_TIMEOUT, Duration::from_millis));
    for (name, value) in &headers {
        call = call.header(name, value);
    }
    if let Some(body) = body {
        call = call.body(body);
    }
    let response = call
        .send()
        .await
        .map_err(|e| masked(&format!("{url}: {e}"), &values))?;
    let status = response.status().as_u16();
    let response_headers = response
        .headers()
        .iter()
        .map(|(name, value)| (name.to_string(), value.to_str().unwrap_or("").to_string()))
        .collect();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| masked(&e.to_string(), &values))?;
    if bytes.len() > VALUE_LIMIT {
        let size = bytes.len() as f64 / BYTES_PER_MB;
        return Err(masked(
            &format!("{url} answered with {size:.1} MB, {}", too_big()),
            &values,
        ));
    }
    let text = String::from_utf8_lossy(&bytes).to_string();
    let body = if request.parse == "json" {
        serde_json::from_str(&text).unwrap_or(Value::String(text))
    } else {
        Value::String(text)
    };
    Ok(HttpResponse {
        status,
        headers: response_headers,
        body,
    })
}

const BYTES_PER_MB: f64 = 1024.0 * 1024.0;

/// The end of the error for a value past `VALUE_LIMIT`: how much it may be, and what to do instead.
pub(crate) fn too_big() -> String {
    format!(
        "more than a step's value may hold ({:.0} MB) - write it to a file and read that with a Files step",
        VALUE_LIMIT as f64 / BYTES_PER_MB
    )
}

// ---- mail ---------------------------------------------------------------------------

/// A mail connection, kept whole as one secret named `mail.<name>`.
#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MailAccount {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub from: String,
    /// STARTTLS on the given port (587), else implicit TLS (465).
    #[serde(default = "default_starttls")]
    pub starttls: bool,
}

fn default_starttls() -> bool {
    true
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MailRequest {
    pub connection: String,
    pub to: Vec<String>,
    pub subject: String,
    pub body: String,
    /// Shows what would be sent, and sends nothing.
    #[serde(default)]
    pub preview: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MailOutcome {
    pub sent: bool,
    pub from: String,
    pub to: Vec<String>,
    pub subject: String,
}

/// Stores a mail account; the whole of it is the secret.
#[tauri::command]
pub fn mail_account_set(app: AppHandle, name: String, account: MailAccount) -> Result<(), String> {
    let json = serde_json::to_string(&account).map_err(|e| e.to_string())?;
    secret_set(app, format!("mail.{name}"), json)
}

/// Sends one plain-text mail over SMTP, or shows it when previewing.
#[tauri::command]
pub async fn flow_mail(request: MailRequest) -> Result<MailOutcome, String> {
    let account: MailAccount = {
        let json = entry(&format!("mail.{}", request.connection))?
            .get_password()
            .map_err(|e| match e {
                keyring::Error::NoEntry => format!(
                    "no mail connection named '{}' - add it under Flows → Connections",
                    request.connection
                ),
                other => store_error(&other.to_string()),
            })?;
        serde_json::from_str(&json).map_err(|e| format!("the mail connection is not readable: {e}"))?
    };
    let outcome = MailOutcome {
        sent: !request.preview,
        from: account.from.clone(),
        to: request.to.clone(),
        subject: request.subject.clone(),
    };
    if request.preview {
        return Ok(outcome);
    }
    let message = build_message(&account, &request)?;
    let transport = build_transport(&account)?;
    crate::background::off_main_thread(move || {
        use lettre::Transport;
        transport.send(&message).map(|_| ()).map_err(|e| e.to_string())
    })
    .await?
    .map_err(|e| {
        masked(
            &format!("could not send the mail: {e}"),
            std::slice::from_ref(&account.password),
        )
    })?;
    Ok(outcome)
}

fn build_message(account: &MailAccount, request: &MailRequest) -> Result<lettre::Message, String> {
    let mut builder = lettre::Message::builder()
        .from(
            account
                .from
                .parse()
                .map_err(|e| format!("the from address is not an address: {e}"))?,
        )
        .subject(&request.subject);
    for to in &request.to {
        builder = builder.to(to.parse().map_err(|e| format!("'{to}' is not an address: {e}"))?);
    }
    builder
        .header(lettre::message::header::ContentType::TEXT_PLAIN)
        .body(request.body.clone())
        .map_err(|e| format!("could not build the mail: {e}"))
}

fn build_transport(account: &MailAccount) -> Result<lettre::SmtpTransport, String> {
    use lettre::transport::smtp::authentication::Credentials;
    let builder = if account.starttls {
        lettre::SmtpTransport::starttls_relay(&account.host)
    } else {
        lettre::SmtpTransport::relay(&account.host)
    }
    .map_err(|e| format!("the mail server could not be reached: {e}"))?;
    Ok(builder
        .port(account.port)
        .credentials(Credentials::new(account.user.clone(), account.password.clone()))
        .timeout(Some(Duration::from_secs(30)))
        .build())
}

// ---- oauth ----------------------------------------------------------------------------

/// An OAuth 2 client the person made themselves (Aime ships none).
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OauthClient {
    pub auth_url: String,
    pub token_url: String,
    pub client_id: String,
    /// Some providers demand one even for PKCE; empty means none.
    #[serde(default)]
    pub client_secret: String,
    pub scopes: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct OauthTokens {
    access_token: String,
    refresh_token: Option<String>,
    /// Unix seconds; 0 when the server did not say.
    expires_at: u64,
}

/// Signs in to `name`'s service in the system browser and stores the tokens.
/// PKCE with a loopback redirect on 127.0.0.1, which every provider that
/// allows public clients accepts, on all three platforms.
#[tauri::command]
pub async fn oauth_sign_in(app: AppHandle, name: String, client: OauthClient) -> Result<(), String> {
    check_name(&name)?;
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("could not open a loopback port: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}/callback");
    let verifier = random_token(64);
    let challenge = base64_url(&sha256(verifier.as_bytes()));
    let state = random_token(24);
    let auth_url = format!(
        "{}{}response_type=code&client_id={}&redirect_uri={}&scope={}&state={}&code_challenge={}&code_challenge_method=S256&access_type=offline&prompt=consent",
        client.auth_url,
        if client.auth_url.contains('?') { "&" } else { "?" },
        encode(&client.client_id),
        encode(&redirect),
        encode(&client.scopes.join(" ")),
        state,
        challenge
    );
    tauri_plugin_opener::open_url(&auth_url, None::<&str>)
        .map_err(|e| format!("could not open the browser: {e}"))?;

    let expected_state = state.clone();
    let code =
        crate::background::off_main_thread(move || wait_for_code(&listener, &expected_state)).await??;
    let mut form = vec![
        ("grant_type", "authorization_code".to_string()),
        ("code", code),
        ("redirect_uri", redirect),
        ("client_id", client.client_id.clone()),
        ("code_verifier", verifier),
    ];
    if !client.client_secret.is_empty() {
        form.push(("client_secret", client.client_secret.clone()));
    }
    let tokens = exchange(&client.token_url, &form).await?;
    store_oauth(&app, &name, &client, &tokens)
}

/// A bearer token for `name`, refreshed first when it has expired.
#[tauri::command]
pub async fn oauth_token(app: AppHandle, name: String) -> Result<String, String> {
    check_name(&name)?;
    let (client, tokens) = load_oauth(&name)?;
    let now = now_secs();
    if tokens.expires_at == 0 || tokens.expires_at > now + 60 {
        return Ok(tokens.access_token);
    }
    let Some(refresh) = tokens.refresh_token.clone() else {
        return Err(format!(
            "the sign-in for '{name}' has expired and the service gave no refresh token; sign in again"
        ));
    };
    let mut form = vec![
        ("grant_type", "refresh_token".to_string()),
        ("refresh_token", refresh.clone()),
        ("client_id", client.client_id.clone()),
    ];
    if !client.client_secret.is_empty() {
        form.push(("client_secret", client.client_secret.clone()));
    }
    let mut fresh = exchange(&client.token_url, &form).await?;
    if fresh.refresh_token.is_none() {
        fresh.refresh_token = Some(refresh);
    }
    store_oauth(&app, &name, &client, &fresh)?;
    Ok(fresh.access_token)
}

fn wait_for_code(listener: &TcpListener, expected_state: &str) -> Result<String, String> {
    listener.set_nonblocking(false).map_err(|e| e.to_string())?;
    // Five minutes to finish in the browser; a listener that waits forever is a port held forever.
    let deadline = std::time::Instant::now() + Duration::from_secs(300);
    loop {
        if std::time::Instant::now() > deadline {
            return Err("no sign-in came back within five minutes".into());
        }
        let (mut stream, _) = listener.accept().map_err(|e| e.to_string())?;
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut buf = [0u8; 4096];
        let n = stream.read(&mut buf).unwrap_or(0);
        let request = String::from_utf8_lossy(&buf[..n]);
        let Some(line) = request.lines().next() else {
            continue;
        };
        let Some(path) = line.split_whitespace().nth(1) else {
            continue;
        };
        if !path.starts_with("/callback") {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
            continue;
        }
        let query: BTreeMap<String, String> = path
            .split_once('?')
            .map(|(_, q)| q)
            .unwrap_or("")
            .split('&')
            .filter_map(|pair| pair.split_once('='))
            .map(|(k, v)| (k.to_string(), decode(v)))
            .collect();
        let page = |title: &str| {
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n<!doctype html><html><body style=\"font-family:system-ui;padding:40px\"><h2>{title}</h2><p>You can close this tab and go back to Aime.</p></body></html>"
            )
        };
        if query.get("state").map(String::as_str) != Some(expected_state) {
            let _ = stream.write_all(page("That sign-in was not the one Aime asked for.").as_bytes());
            continue;
        }
        if let Some(error) = query.get("error") {
            let _ = stream.write_all(page("Sign-in refused.").as_bytes());
            return Err(format!(
                "the service refused: {error} {}",
                query.get("error_description").cloned().unwrap_or_default()
            ));
        }
        if let Some(code) = query.get("code") {
            let _ = stream.write_all(page("Signed in.").as_bytes());
            return Ok(code.clone());
        }
    }
}

async fn exchange(token_url: &str, form: &[(&str, String)]) -> Result<OauthTokens, String> {
    let client = crate::trackers::http::client().map_err(|e| e.to_string())?;
    // Encoded here: this reqwest is built without its form feature.
    let body = form
        .iter()
        .map(|(key, value)| format!("{}={}", encode(key), encode(value)))
        .collect::<Vec<_>>()
        .join("&");
    let response = client
        .post(token_url)
        .header("Accept", "application/json")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("the token request failed: {e}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    let json: Value = serde_json::from_str(&text)
        .map_err(|_| format!("the token endpoint answered {status} with no JSON"))?;
    if !status.is_success() {
        return Err(format!(
            "the token endpoint answered {status}: {}",
            json.get("error_description")
                .or(json.get("error"))
                .and_then(Value::as_str)
                .unwrap_or("no reason given")
        ));
    }
    let access = json
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or("the token answer holds no access_token")?;
    let expires_in = json.get("expires_in").and_then(Value::as_u64);
    Ok(OauthTokens {
        access_token: access.to_string(),
        refresh_token: json
            .get("refresh_token")
            .and_then(Value::as_str)
            .map(str::to_string),
        expires_at: expires_in.map_or(0, |seconds| now_secs() + seconds),
    })
}

fn store_oauth(
    app: &AppHandle,
    name: &str,
    client: &OauthClient,
    tokens: &OauthTokens,
) -> Result<(), String> {
    let record = serde_json::json!({ "client": client, "tokens": tokens });
    secret_set(app.clone(), format!("oauth.{name}"), record.to_string())?;
    // The access token under the plain name, which is what {{secret.NAME}} reads.
    entry(name)?
        .set_password(&tokens.access_token)
        .map_err(|e| store_error(&e.to_string()))
}

fn load_oauth(name: &str) -> Result<(OauthClient, OauthTokens), String> {
    let json = entry(&format!("oauth.{name}"))?
        .get_password()
        .map_err(|e| match e {
            keyring::Error::NoEntry => {
                format!("'{name}' is not signed in; sign in under Flows → Connections")
            }
            other => store_error(&other.to_string()),
        })?;
    let record: Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let client = serde_json::from_value(record.get("client").cloned().unwrap_or(Value::Null))
        .map_err(|e| e.to_string())?;
    let tokens = serde_json::from_value(record.get("tokens").cloned().unwrap_or(Value::Null))
        .map_err(|e| e.to_string())?;
    Ok((client, tokens))
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn random_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    for chunk in buf.chunks_mut(8) {
        let n = fastrand_u64();
        for (i, b) in chunk.iter_mut().enumerate() {
            *b = (n >> (i * 8)) as u8;
        }
    }
    base64_url(&buf)
}

/// Randomness from the OS through the time-seeded hasher: good enough for a
/// PKCE verifier, which only has to be unguessable for the minutes it lives.
fn fastrand_u64() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    );
    hasher.finish()
}

fn base64_url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[(n >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[n as usize & 63] as char);
        }
    }
    out
}

fn sha256(data: &[u8]) -> [u8; 32] {
    use ring::digest;
    let digest = digest::digest(&digest::SHA256, data);
    let mut out = [0u8; 32];
    out.copy_from_slice(digest.as_ref());
    out
}

fn encode(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                if let Ok(v) = u8::from_str_radix(&text[i + 1..i + 3], 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
                out.push(b'%');
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

// ---- trust ------------------------------------------------------------------------------

/// Which content of which flow this machine has agreed to run.
#[derive(Serialize, Deserialize, Default, Debug)]
struct TrustRecords {
    /// `<workspace key>:<slug>` → hash of the flow's content when trusted.
    flows: BTreeMap<String, String>,
}

fn trust_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(TRUST_FILE))
}

fn read_trust(app: &AppHandle) -> Result<TrustRecords, String> {
    match fs::read(trust_file(app)?) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(TrustRecords::default()),
        Err(err) => Err(err.to_string()),
    }
}

fn trust_key(root: &str, slug: &str) -> String {
    format!("{}:{slug}", crate::session::store_key(root))
}

/// Whether this content of the flow was trusted here (written here, or agreed to on a first run).
#[tauri::command]
pub fn flow_trusted(app: AppHandle, root: String, slug: String, hash: String) -> Result<bool, String> {
    Ok(read_trust(&app)?.flows.get(&trust_key(&root, &slug)) == Some(&hash))
}

/// Records that this content may run here.
#[tauri::command]
pub fn flow_trust(app: AppHandle, root: String, slug: String, hash: String) -> Result<(), String> {
    let mut records = read_trust(&app)?;
    records.flows.insert(trust_key(&root, &slug), hash);
    let file = trust_file(&app)?;
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(
        file,
        serde_json::to_vec_pretty(&records).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

/// The single-instance arguments of a second `aime` launch, as the frontend hears them.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    pub cwd: String,
    pub flow: String,
    pub text: String,
    pub files: Vec<String>,
}

/// `aime run <flow> [--input <text>] [--file <path>]...`, from a second launch
/// in `cwd` - None for any other command line (a folder, nothing).
pub fn run_request(args: &[String], cwd: &Path) -> Option<RunRequest> {
    let mut words = args.iter().skip(1);
    if words.next().map(String::as_str) != Some("run") {
        return None;
    }
    let flow = words.next()?.clone();
    let mut text = String::new();
    let mut files = Vec::new();
    while let Some(word) = words.next() {
        match word.as_str() {
            "--input" | "-i" => text = words.next().cloned().unwrap_or_default(),
            "--file" | "-f" => {
                if let Some(file) = words.next() {
                    let path = PathBuf::from(file);
                    files.push(
                        if path.is_absolute() { path } else { cwd.join(path) }
                            .to_string_lossy()
                            .to_string(),
                    );
                }
            }
            other => {
                if !text.is_empty() {
                    text.push(' ');
                }
                text.push_str(other);
            }
        }
    }
    Some(RunRequest {
        cwd: cwd.to_string_lossy().to_string(),
        flow,
        text,
        files,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_names_are_checked_before_they_reach_the_store() {
        assert!(check_name("github_token").is_ok());
        assert!(check_name("mail.work").is_ok());
        assert!(check_name("").is_err());
        assert!(check_name("has space").is_err());
        assert!(check_name("../etc").is_err());
    }

    #[test]
    fn masking_hides_every_value_used() {
        let text = "Bearer abc123 failed at https://x/?key=abc123 and s3cret";
        assert_eq!(
            masked(text, &["abc123".into(), "s3cret".into()]),
            "Bearer ••• failed at https://x/?key=••• and •••"
        );
    }

    #[test]
    fn pkce_pieces_have_the_shapes_the_rfc_asks_for() {
        let verifier = random_token(64);
        assert!(
            verifier.len() >= 43 && verifier.len() <= 128,
            "{}",
            verifier.len()
        );
        assert!(verifier
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        // A known SHA-256: of "hello", base64url without padding.
        assert_eq!(
            base64_url(&sha256(b"hello")),
            "LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ"
        );
        assert_eq!(encode("a b&c/d"), "a%20b%26c%2Fd");
        assert_eq!(decode("a%20b%26c%2Fd+e"), "a b&c/d e");
    }

    #[test]
    fn a_second_launch_asking_for_a_run_is_read_and_a_folder_is_not() {
        let cwd = Path::new("/work/shop");
        let request = run_request(
            &[
                "aime".into(),
                "run".into(),
                "release-notes".into(),
                "--input".into(),
                "from v1.2".into(),
                "--file".into(),
                "notes.md".into(),
            ],
            cwd,
        )
        .expect("a run request");
        assert_eq!(request.flow, "release-notes");
        assert_eq!(request.text, "from v1.2");
        assert_eq!(request.files.len(), 1);
        assert!(request.files[0].ends_with("notes.md"));
        assert!(run_request(&["aime".into(), "/work/shop".into()], cwd).is_none());
        assert!(run_request(&["aime".into()], cwd).is_none());
    }
}

//! The one HTTP client every work tracker talks through.
//!
//! Shared rather than per connector, because its two settings are decisions that
//! belong to all of them: a pooled client (a TLS handshake costs more than the
//! request that follows it) and **no redirect following**. A tracker that wants
//! a credential answers a bad one with a redirect to its sign-in page - Azure
//! DevOps measurably does, with a `302` - and a client that follows it parses a
//! login page and reports a JSON error for what is simply an expired token.

use reqwest::Client;
use std::sync::OnceLock;
use std::time::Duration;

use super::connector::TrackerError;

/// Long enough for a slow corporate link, short enough that a hung proxy does
/// not leave the panel spinning until the user gives up on it.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

pub fn client() -> Result<&'static Client, TrackerError> {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    install_crypto_provider();
    let built = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .user_agent(concat!("Aime/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| TrackerError::Network(format!("Could not start the HTTP client: {e}")))?;
    Ok(CLIENT.get_or_init(|| built))
}

/// rustls is built here without a bundled crypto provider, so that its `ring`
/// build is shared with the updater plugin instead of a second one being
/// compiled (see Cargo.toml). Whoever gets here first installs it; the updater
/// does exactly the same when it runs, and either order is fine.
///
/// This runs before the client is built, and that order is load-bearing:
/// measured, `ClientBuilder::build` **panics** without a provider rather than
/// returning an error, so there would be nothing to map into a failure. The
/// guard against it is a test that talks real TLS
/// (`a_real_https_handshake_reaches_azure_devops`).
fn install_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        // Fails only if another thread won the race, which is the same outcome.
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

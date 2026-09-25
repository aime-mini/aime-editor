//! Whether something is listening at an address.

use std::net::SocketAddr;
use std::time::Duration;
use tokio::net::{lookup_host, TcpStream};
use tokio::task::JoinSet;

/// How long one knock waits before calling the address closed.
const KNOCK_TIMEOUT: Duration = Duration::from_secs(2);

/// Whether a connection to `host:port` is accepted right now.
///
/// This is how a Task Run tells that a service its test suites need has come
/// up. A TCP connect rather than an HTTP request: a database has no HTTP to
/// speak, and a dev server that accepts the connection before it can answer is
/// up as far as the suite is concerned - its own client waits for the answer.
///
/// Every address the name resolves to is knocked on at once. A Node server may
/// listen on `::1` alone or on `127.0.0.1` alone, and `localhost` resolves to
/// both; tried in turn, a refused `::1` costs about two seconds on Windows
/// (measured: the test below failed on exactly that) before `127.0.0.1` is
/// even asked.
#[tauri::command]
pub async fn net_reachable(host: String, port: u16) -> bool {
    let Ok(addresses) = lookup_host((host.as_str(), port)).await else {
        return false;
    };
    let mut knocks: JoinSet<bool> = addresses.map(knock).fold(JoinSet::new(), |mut set, future| {
        set.spawn(future);
        set
    });
    while let Some(answered) = knocks.join_next().await {
        if matches!(answered, Ok(true)) {
            return true;
        }
    }
    false
}

async fn knock(address: SocketAddr) -> bool {
    matches!(
        tokio::time::timeout(KNOCK_TIMEOUT, TcpStream::connect(address)).await,
        Ok(Ok(_))
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn a_port_something_listens_on_answers_and_a_closed_one_does_not() {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("a free port on loopback");
        let port = listener.local_addr().expect("the port it bound").port();

        assert!(net_reachable("127.0.0.1".into(), port).await);
        assert!(net_reachable("localhost".into(), port).await);

        drop(listener);
        assert!(!net_reachable("127.0.0.1".into(), port).await);
    }

    #[tokio::test]
    async fn a_name_that_resolves_to_nothing_is_not_reachable() {
        assert!(!net_reachable("no-such-host.invalid".into(), 80).await);
    }
}

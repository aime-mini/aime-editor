//! A stand-in work tracker, speaking real HTTP on a real socket.
//!
//! Shared by every connector's tests, because it is as close to a service as a
//! test can get without an account: the connector's own client sends the real
//! requests, so URL building, the auth header, the content types and the status
//! handling are all exercised, and what the service *received* can be asserted
//! against - which is where the interesting bugs are (a query filtered by the
//! wrong states, an update sent under the wrong content type).
//!
//! What each service actually answers stays in that service's own tests: only
//! the socket is shared.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

/// One request the stand-in received.
#[derive(Clone)]
pub struct Seen {
    pub method: String,
    pub target: String,
    pub authorization: String,
    pub content_type: String,
    pub body: String,
}

pub struct FakeService {
    /// `http://127.0.0.1:<port>` - what a connection's server setting points at.
    pub base: String,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl FakeService {
    /// Starts answering on a free port. The accept loop lives for the rest of the
    /// test process, which is why every answer has to close its connection.
    pub fn start(answer: impl Fn(&Seen) -> String + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind a port");
        let base = format!("http://{}", listener.local_addr().expect("the port just bound"));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let recorder = Arc::clone(&seen);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let request = read_request(&mut stream);
                let response = answer(&request);
                recorder
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .push(request);
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        Self { base, seen }
    }

    pub fn requests(&self) -> Vec<Seen> {
        self.seen
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// The first request whose URL contains this fragment.
    pub fn request_for(&self, fragment: &str) -> Seen {
        self.requests()
            .into_iter()
            .find(|seen| seen.target.contains(fragment))
            .unwrap_or_else(|| panic!("no request was made to '{fragment}'"))
    }
}

fn read_request(stream: &mut TcpStream) -> Seen {
    let mut reader = BufReader::new(stream);
    let mut start_line = String::new();
    let _ = reader.read_line(&mut start_line);
    let mut parts = start_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let target = parts.next().unwrap_or_default().to_string();

    let mut headers: Vec<(String, String)> = Vec::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" || line == "\n" {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_lowercase(), value.trim().to_string()));
        }
    }
    let header = |wanted: &str| {
        headers
            .iter()
            .find(|(name, _)| name == wanted)
            .map_or(String::new(), |(_, value)| value.clone())
    };
    let length: usize = header("content-length").parse().unwrap_or(0);
    let mut body = vec![0_u8; length];
    if length > 0 {
        let _ = reader.read_exact(&mut body);
    }
    Seen {
        method,
        target,
        authorization: header("authorization"),
        content_type: header("content-type"),
        body: String::from_utf8_lossy(&body).to_string(),
    }
}

/// A 200 carrying JSON, which is what these services answer with when they work.
pub fn json_response(body: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

/// A failure the way a service sends one: a status, a content type, a body.
pub fn response(status: &str, content_type: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\
         Connection: close\r\n\r\n{body}",
        body.len()
    )
}

//! The `Content-Length` envelope shared by LSP and DAP. Both protocols carry
//! JSON over the same framing, so it is written and tested once here rather
//! than twice next to each client.

use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

/// Wraps a JSON message in the `Content-Length` envelope. The length counts
/// bytes, not characters — a UTF-8 identifier would otherwise truncate the
/// message.
pub fn frame(message: &str) -> String {
    format!("Content-Length: {}\r\n\r\n{message}", message.len())
}

/// Reads the byte count out of a header line, ignoring headers we don't use.
/// Header names are case-insensitive per both specifications.
pub fn content_length(header: &str) -> Option<usize> {
    let (name, value) = header.split_once(':')?;
    if !name.trim().eq_ignore_ascii_case("Content-Length") {
        return None;
    }
    value.trim().parse().ok()
}

/// Reads one framed message; `None` once the other end closes the stream.
pub async fn read_message<R>(reader: &mut BufReader<R>) -> std::io::Result<Option<String>>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut length = None;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).await? == 0 {
            return Ok(None); // EOF
        }
        if header.trim().is_empty() {
            break; // blank line ends the header block
        }
        length = content_length(&header).or(length);
    }
    let Some(length) = length else {
        // A header block without a length is unusable; skipping it keeps the
        // stream alive instead of desynchronizing it forever.
        return Ok(Some(String::new()));
    };
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).await?;
    Ok(Some(String::from_utf8_lossy(&body).to_string()))
}

#[cfg(test)]
mod tests {
    use super::{content_length, frame, read_message};
    use tokio::io::BufReader;

    #[test]
    fn framing_counts_bytes_not_characters() {
        let message = r#"{"id":1,"method":"tên"}"#;
        let framed = frame(message);
        assert!(framed.starts_with(&format!("Content-Length: {}\r\n\r\n", message.len())));
        assert!(framed.ends_with(message));
        assert!(
            message.len() > message.chars().count(),
            "the fixture is multibyte"
        );
    }

    #[test]
    fn the_header_name_is_case_insensitive() {
        assert_eq!(content_length("Content-Length: 42"), Some(42));
        assert_eq!(content_length("content-length:42\r\n"), Some(42));
        assert_eq!(content_length("CONTENT-LENGTH: 7"), Some(7));
    }

    #[test]
    fn other_headers_and_junk_carry_no_length() {
        assert_eq!(content_length("Content-Type: application/vscode-jsonrpc"), None);
        assert_eq!(content_length("Content-Length: not-a-number"), None);
        assert_eq!(content_length("no colon here"), None);
    }

    #[tokio::test]
    async fn back_to_back_messages_are_read_one_at_a_time() {
        let first = r#"{"seq":1,"type":"request","command":"initialize"}"#;
        let second = r#"{"seq":2,"type":"event","event":"stopped"}"#;
        let stream = format!("{}{}", frame(first), frame(second));
        let mut reader = BufReader::new(stream.as_bytes());

        assert_eq!(
            read_message(&mut reader).await.expect("first"),
            Some(first.into())
        );
        assert_eq!(
            read_message(&mut reader).await.expect("second"),
            Some(second.into())
        );
        assert_eq!(read_message(&mut reader).await.expect("eof"), None);
    }

    #[tokio::test]
    async fn an_extra_header_before_the_length_does_not_shift_the_body() {
        let message = r#"{"seq":1}"#;
        let stream = format!(
            "Content-Type: application/vscode-jsonrpc\r\nContent-Length: {}\r\n\r\n{message}",
            message.len()
        );
        let mut reader = BufReader::new(stream.as_bytes());
        assert_eq!(
            read_message(&mut reader).await.expect("read"),
            Some(message.into())
        );
    }
}

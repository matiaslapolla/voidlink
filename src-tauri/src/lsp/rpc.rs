use std::io::BufRead;

/// Encode a JSON-RPC message with Content-Length header.
pub fn encode_message(value: &serde_json::Value) -> Vec<u8> {
    let body = serde_json::to_string(value).expect("failed to serialize JSON-RPC message");
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    let mut out = Vec::with_capacity(header.len() + body.len());
    out.extend_from_slice(header.as_bytes());
    out.extend_from_slice(body.as_bytes());
    out
}

/// Decode a single JSON-RPC message from a buffered reader.
/// Returns None on EOF or malformed framing.
pub fn decode_message(reader: &mut impl BufRead) -> Option<serde_json::Value> {
    let mut content_length: Option<usize> = None;

    // Read headers until blank line
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => return None, // EOF
            Err(_) => return None,
            Ok(_) => {}
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }

        if let Some(value) = trimmed.strip_prefix("Content-Length: ") {
            content_length = value.parse::<usize>().ok();
        }
        // Ignore other headers (e.g. Content-Type)
    }

    let length = content_length?;
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).ok()?;

    serde_json::from_slice(&body).ok()
}

/// Build a JSON-RPC request payload.
pub fn build_request(id: u64, method: &str, params: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    })
}

/// Build a JSON-RPC notification payload (no id).
pub fn build_notification(method: &str, params: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
    })
}

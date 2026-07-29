//! LSP base-protocol framing.
//!
//! A language server speaks JSON-RPC over its stdio, wrapped in the same header
//! block HTTP uses: `Content-Length: <bytes>\r\n\r\n<payload>`. Two things about
//! that make it worth its own module with its own tests.
//!
//! First, the length is in **bytes**, not characters, and the payload is UTF-8.
//! A decoder that counts `chars` works perfectly until a server sends a hover
//! containing an em dash, and then desynchronises the stream permanently —
//! every subsequent message is parsed from the wrong offset. There is no
//! recovery from that short of restarting the server.
//!
//! Second, a pipe read returns whatever bytes happen to be available. A single
//! `read` can deliver half a header, three whole messages, or one message split
//! across four reads. So the decoder is a state machine fed arbitrary chunks,
//! not a `read_line`-shaped parser — `FrameDecoder::push` takes bytes and
//! `next_message` yields whole messages until it runs out.
//!
//! Everything here is pure and synchronous. The process, the threads and the
//! Tauri events live in `mod.rs`; this file has no idea a child process exists.

use std::fmt;

/// Header block terminator. Servers are required to use CRLF; a lone LF is a
/// bug we deliberately do not accommodate, because accepting it would mean
/// scanning for two different terminators and picking the earlier one, which
/// turns a payload containing `\n\n` into a framing error.
const HEADER_END: &[u8] = b"\r\n\r\n";

/// Cap on the header block. A server writing an unterminated header would
/// otherwise make the decoder buffer forever; 8 KiB is far past any real header
/// block (which is one or two short lines).
const MAX_HEADER_BYTES: usize = 8 * 1024;

/// Cap on a single message body. rust-analyzer's largest messages are the
/// initialize response and big completion lists, comfortably under a megabyte;
/// 64 MiB rejects a corrupt length without ever rejecting a real message.
const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FramingError {
    /// The header block ended without a `Content-Length`.
    MissingContentLength,
    /// `Content-Length` was present but not a plausible byte count.
    BadContentLength(String),
    /// A header line had no `:`.
    MalformedHeader(String),
    /// Header block or body exceeded its cap.
    TooLarge(usize),
    /// The body was not valid UTF-8. Fatal for the stream — the bytes were
    /// consumed and there is no way to resynchronise.
    NotUtf8,
}

impl fmt::Display for FramingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingContentLength => write!(f, "LSP header block had no Content-Length"),
            Self::BadContentLength(v) => write!(f, "unparsable Content-Length: {v:?}"),
            Self::MalformedHeader(l) => write!(f, "malformed LSP header line: {l:?}"),
            Self::TooLarge(n) => write!(f, "LSP frame too large: {n} bytes"),
            Self::NotUtf8 => write!(f, "LSP message body was not valid UTF-8"),
        }
    }
}

impl std::error::Error for FramingError {}

/// Wrap a JSON-RPC payload in the base protocol's header block.
///
/// `Content-Type` is deliberately omitted: it is optional in the specification,
/// defaults to exactly what we send, and every server in the wild ignores it.
pub fn encode(payload: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 32);
    out.extend_from_slice(format!("Content-Length: {}\r\n\r\n", payload.len()).as_bytes());
    out.extend_from_slice(payload.as_bytes());
    out
}

/// The `Content-Length` from a header block, in bytes.
///
/// Header names are matched case-insensitively — the specification capitalises
/// them, but nothing enforces it and at least one server in the wild lowercases.
pub fn parse_content_length(headers: &str) -> Result<usize, FramingError> {
    let mut found: Option<usize> = None;
    for line in headers.split("\r\n") {
        if line.is_empty() {
            continue;
        }
        let Some((name, value)) = line.split_once(':') else {
            return Err(FramingError::MalformedHeader(line.to_string()));
        };
        if !name.trim().eq_ignore_ascii_case("content-length") {
            continue;
        }
        let value = value.trim();
        let n: usize = value
            .parse()
            .map_err(|_| FramingError::BadContentLength(value.to_string()))?;
        if n > MAX_BODY_BYTES {
            return Err(FramingError::TooLarge(n));
        }
        found = Some(n);
    }
    found.ok_or(FramingError::MissingContentLength)
}

/// Incremental decoder for a stream of framed messages.
///
/// Feed it whatever bytes a read produced, then drain `next_message` until it
/// returns `None`. Holding the partial remainder across calls is the entire
/// point — see the module comment.
#[derive(Debug, Default)]
pub struct FrameDecoder {
    buf: Vec<u8>,
    /// Body length, once the header block for the message in progress has been
    /// consumed. `None` while still looking for the header terminator.
    expected: Option<usize>,
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    /// The next complete message, if the buffer holds one.
    ///
    /// `Ok(None)` means "need more bytes" and is the normal answer between
    /// reads. An `Err` is fatal for the stream: the offsets are no longer
    /// trustworthy, and the caller's only correct response is to stop reading
    /// and let the session die.
    pub fn next_message(&mut self) -> Result<Option<String>, FramingError> {
        if self.expected.is_none() {
            let Some(at) = find(&self.buf, HEADER_END) else {
                if self.buf.len() > MAX_HEADER_BYTES {
                    return Err(FramingError::TooLarge(self.buf.len()));
                }
                return Ok(None);
            };
            if at > MAX_HEADER_BYTES {
                return Err(FramingError::TooLarge(at));
            }
            // Header names and values are ASCII; a non-UTF-8 header block is a
            // malformed stream, reported as such rather than silently lossy.
            let headers = std::str::from_utf8(&self.buf[..at]).map_err(|_| FramingError::NotUtf8)?;
            let len = parse_content_length(headers)?;
            self.buf.drain(..at + HEADER_END.len());
            self.expected = Some(len);
        }

        let len = self.expected.expect("set immediately above");
        if self.buf.len() < len {
            return Ok(None);
        }
        // Drain by byte count. The whole reason this module exists.
        let body: Vec<u8> = self.buf.drain(..len).collect();
        self.expected = None;
        String::from_utf8(body)
            .map(Some)
            .map_err(|_| FramingError::NotUtf8)
    }

    /// Bytes held back waiting for more input. The reader thread reports this
    /// when a server exits: a non-zero count means it died mid-message, which
    /// distinguishes "crashed while answering" from "shut down cleanly" in the
    /// output log.
    pub fn pending(&self) -> usize {
        self.buf.len()
    }
}

/// First index of `needle` in `haystack`. Small enough not to justify a
/// dependency; the header terminator is four bytes and the buffer is short.
fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_all(chunks: &[&[u8]]) -> Vec<String> {
        let mut d = FrameDecoder::new();
        let mut out = Vec::new();
        for chunk in chunks {
            d.push(chunk);
            while let Some(m) = d.next_message().expect("framing") {
                out.push(m);
            }
        }
        out
    }

    #[test]
    fn encodes_a_header_block_and_body() {
        let bytes = encode(r#"{"id":1}"#);
        assert_eq!(bytes, b"Content-Length: 8\r\n\r\n{\"id\":1}".to_vec());
    }

    #[test]
    fn encode_then_decode_round_trips() {
        let payload = r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#;
        assert_eq!(decode_all(&[&encode(payload)]), vec![payload.to_string()]);
    }

    #[test]
    fn content_length_counts_bytes_not_characters() {
        // Four characters, seven bytes: an em dash is three bytes in UTF-8.
        let payload = "\"a—b\"";
        let bytes = encode(payload);
        let header = String::from_utf8(bytes[..20].to_vec()).unwrap();
        assert!(header.starts_with("Content-Length: 7\r\n"), "{header:?}");
        assert_eq!(decode_all(&[&bytes]), vec![payload.to_string()]);
    }

    #[test]
    fn reassembles_a_message_split_byte_by_byte() {
        let payload = r#"{"method":"textDocument/didOpen"}"#;
        let bytes = encode(payload);
        let chunks: Vec<&[u8]> = bytes.chunks(1).collect();
        assert_eq!(decode_all(&chunks), vec![payload.to_string()]);
    }

    #[test]
    fn reassembles_a_split_inside_the_header_terminator() {
        // The nastiest split: half of "\r\n\r\n" in one read, half in the next.
        let bytes = encode(r#"{"a":1}"#);
        let at = find(&bytes, HEADER_END).unwrap() + 2;
        assert_eq!(
            decode_all(&[&bytes[..at], &bytes[at..]]),
            vec![r#"{"a":1}"#.to_string()]
        );
    }

    #[test]
    fn yields_several_messages_from_one_chunk() {
        let mut bytes = encode(r#"{"a":1}"#);
        bytes.extend(encode(r#"{"b":2}"#));
        bytes.extend(encode(r#"{"c":3}"#));
        assert_eq!(
            decode_all(&[&bytes]),
            vec![
                r#"{"a":1}"#.to_string(),
                r#"{"b":2}"#.to_string(),
                r#"{"c":3}"#.to_string()
            ]
        );
    }

    #[test]
    fn holds_a_trailing_partial_message_without_yielding_it() {
        let mut d = FrameDecoder::new();
        let mut bytes = encode(r#"{"a":1}"#);
        bytes.extend(encode(r#"{"bbbbbb":2}"#));
        // Everything but the last three bytes of the second body.
        d.push(&bytes[..bytes.len() - 3]);
        assert_eq!(d.next_message().unwrap().as_deref(), Some(r#"{"a":1}"#));
        assert_eq!(d.next_message().unwrap(), None);
        assert!(d.pending() > 0);
        d.push(&bytes[bytes.len() - 3..]);
        assert_eq!(d.next_message().unwrap().as_deref(), Some(r#"{"bbbbbb":2}"#));
    }

    #[test]
    fn accepts_an_extra_content_type_header() {
        let payload = r#"{"a":1}"#;
        let mut bytes =
            b"Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: 7\r\n\r\n"
                .to_vec();
        bytes.extend_from_slice(payload.as_bytes());
        assert_eq!(decode_all(&[&bytes]), vec![payload.to_string()]);
    }

    #[test]
    fn matches_the_header_name_case_insensitively() {
        assert_eq!(parse_content_length("content-length: 12").unwrap(), 12);
        assert_eq!(parse_content_length("CONTENT-LENGTH:  12 ").unwrap(), 12);
    }

    #[test]
    fn rejects_a_header_block_without_a_length() {
        assert_eq!(
            parse_content_length("Content-Type: application/json"),
            Err(FramingError::MissingContentLength)
        );
    }

    #[test]
    fn rejects_an_unparsable_length() {
        assert!(matches!(
            parse_content_length("Content-Length: twelve"),
            Err(FramingError::BadContentLength(_))
        ));
    }

    #[test]
    fn rejects_a_malformed_header_line() {
        assert!(matches!(
            parse_content_length("Content-Length 12"),
            Err(FramingError::MalformedHeader(_))
        ));
    }

    #[test]
    fn rejects_an_absurd_length_rather_than_buffering_forever() {
        assert!(matches!(
            parse_content_length("Content-Length: 999999999999"),
            Err(FramingError::TooLarge(_))
        ));
    }

    #[test]
    fn rejects_an_unterminated_header_block() {
        let mut d = FrameDecoder::new();
        d.push(&vec![b'x'; MAX_HEADER_BYTES + 1]);
        assert!(matches!(d.next_message(), Err(FramingError::TooLarge(_))));
    }

    #[test]
    fn a_zero_length_body_is_a_valid_empty_message() {
        assert_eq!(decode_all(&[b"Content-Length: 0\r\n\r\n"]), vec!["".to_string()]);
    }

    #[test]
    fn rejects_a_non_utf8_body() {
        let mut bytes = b"Content-Length: 2\r\n\r\n".to_vec();
        bytes.extend_from_slice(&[0xff, 0xfe]);
        let mut d = FrameDecoder::new();
        d.push(&bytes);
        assert_eq!(d.next_message(), Err(FramingError::NotUtf8));
    }
}

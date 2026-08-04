/// Both sides of a binary file, as bytes the UI can actually render.
///
/// A diff of an image is not a diff of its lines, so nothing here goes through
/// the hunk machinery: the frontend needs the *old* bytes and the *new* bytes
/// and will lay them out itself. Neither is reachable any other way — the old
/// side lives in the object database under an oid that only `FileDiff` knows,
/// and the working file cannot be read by `fs_read_file`, which returns a
/// `String` and would either mangle or reject a PNG.
///
/// Base64 rather than `Vec<u8>`: Tauri serialises a byte vector as a JSON
/// array of numbers, which is roughly six bytes of wire per byte of image. A
/// 2 MB screenshot would become a 12 MB message parsed into a 2-million-element
/// JS array on the UI thread, once per render.
use serde::Serialize;

use super::repo::open_repo;

/// The ceiling on either side. Well past any screenshot or icon a repository
/// holds, and small enough that a mistakenly-committed video is refused rather
/// than base64-encoded into the webview.
const MAX_BYTES: usize = 8 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryBlob {
    /// Standard base64, no line breaks — ready to concatenate into a
    /// `data:` URL.
    pub base64: String,
    /// Decoded length. The UI shows it next to the image, and it is the one
    /// number that says something about a binary file without decoding it.
    pub byte_len: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinarySides {
    /// `None` for an added or untracked file: there is no old side, which the
    /// UI must say rather than render as an empty image.
    pub old: Option<BinaryBlob>,
    /// `None` for a deleted file.
    pub new: Option<BinaryBlob>,
    /// A side existed but was over `MAX_BYTES`. Carried so the UI can say "too
    /// large" instead of "deleted", which is what a bare `None` would look
    /// like.
    pub oversize: bool,
}

/// Read the two sides of a binary path.
///
/// `old_blob_oid` comes straight off the `FileDiff` the user is looking at, so
/// this reads the same content the diff was computed against rather than
/// re-resolving a ref that may have moved.
///
/// `from_workdir` picks where the new side comes from: the working file for an
/// unstaged diff, the index entry for a staged one. Getting it wrong would
/// show the user a picture of a version they are not looking at.
pub(crate) fn git_binary_sides_impl(
    repo_path: String,
    path: String,
    old_blob_oid: Option<String>,
    from_workdir: bool,
) -> Result<BinarySides, String> {
    let repo = open_repo(&repo_path)?;
    let mut oversize = false;

    let old = match old_blob_oid.as_deref() {
        Some(oid) => {
            let oid = git2::Oid::from_str(oid).map_err(|e| e.message().to_string())?;
            match repo.find_blob(oid) {
                Ok(blob) => take(blob.content(), &mut oversize),
                // A missing object is not an error to surface: it means the
                // diff is older than a gc, and "no old side" is a renderable
                // answer where a red banner is not.
                Err(_) => None,
            }
        }
        None => None,
    };

    let new = if from_workdir {
        let workdir = repo
            .workdir()
            .ok_or_else(|| "bare repository has no working tree".to_string())?;
        let full = workdir.join(&path);
        match std::fs::read(&full) {
            Ok(bytes) => take(&bytes, &mut oversize),
            Err(_) => None,
        }
    } else {
        let entry = repo
            .index()
            .ok()
            .and_then(|idx| idx.get_path(std::path::Path::new(&path), 0));
        match entry.and_then(|e| repo.find_blob(e.id).ok()) {
            Some(blob) => take(blob.content(), &mut oversize),
            None => None,
        }
    };

    Ok(BinarySides { old, new, oversize })
}

fn take(bytes: &[u8], oversize: &mut bool) -> Option<BinaryBlob> {
    if bytes.len() > MAX_BYTES {
        *oversize = true;
        return None;
    }
    Some(BinaryBlob {
        base64: encode_base64(bytes),
        byte_len: bytes.len(),
    })
}

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding.
///
/// Hand-rolled rather than pulling a crate in for forty lines: this is the
/// only place in the app that needs it, and the encoding has not changed since
/// 1987.
fn encode_base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 4648's own vectors, which is the point of using them: every padding
    /// case appears, and a hand-rolled encoder gets the padding wrong before it
    /// gets anything else wrong.
    #[test]
    fn encodes_the_rfc_vectors_including_every_padding_case() {
        assert_eq!(encode_base64(b""), "");
        assert_eq!(encode_base64(b"f"), "Zg==");
        assert_eq!(encode_base64(b"fo"), "Zm8=");
        assert_eq!(encode_base64(b"foo"), "Zm9v");
        assert_eq!(encode_base64(b"foob"), "Zm9vYg==");
        assert_eq!(encode_base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(encode_base64(b"foobar"), "Zm9vYmFy");
    }

    /// The high bytes are where a sign-extension mistake hides, and every byte
    /// of a PNG past its magic is a high byte.
    #[test]
    fn encodes_bytes_above_127() {
        assert_eq!(encode_base64(&[0xFF, 0xFE, 0xFD]), "//79");
        // A real PNG signature, since that is the first thing the UI sniffs.
        assert_eq!(
            encode_base64(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
            "iVBORw0KGgo="
        );
    }

    #[test]
    fn refuses_a_side_that_is_too_large_without_calling_it_missing() {
        let mut oversize = false;
        let huge = vec![0u8; MAX_BYTES + 1];
        assert!(take(&huge, &mut oversize).is_none());
        assert!(oversize, "the UI cannot tell 'too large' from 'deleted' without this");

        let mut ok = false;
        assert!(take(b"small", &mut ok).is_some());
        assert!(!ok);
    }
}

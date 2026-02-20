const ALPHABET: &[u8; 62] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ENCODED_LENGTH: usize = 22;

// Resource ID prefixes
pub const SANDBOX_PREFIX: &str = "sb_";
pub const EXEC_PREFIX: &str = "ex_";
pub const SESSION_PREFIX: &str = "sess_";
pub const ARTIFACT_PREFIX: &str = "art_";
pub const IMAGE_PREFIX: &str = "img_";
pub const PROFILE_PREFIX: &str = "prof_";
pub const NODE_PREFIX: &str = "node_";
pub const PROJECT_PREFIX: &str = "proj_";

/// Generate a UUIDv7 as raw 16 bytes.
pub fn generate_uuidv7() -> [u8; 16] {
    *uuid::Uuid::now_v7().as_bytes()
}

/// Encode 16 bytes as a fixed-length 22-character base62 string.
pub fn base62_encode(bytes: &[u8; 16]) -> String {
    let mut num = u128::from_be_bytes(*bytes);
    let mut chars = [b'0'; ENCODED_LENGTH];

    for i in (0..ENCODED_LENGTH).rev() {
        chars[i] = ALPHABET[(num % 62) as usize];
        num /= 62;
    }

    String::from_utf8(chars.to_vec()).unwrap()
}

/// Decode a 22-character base62 string back to 16 bytes.
pub fn base62_decode(s: &str) -> Result<[u8; 16], String> {
    if s.len() != ENCODED_LENGTH {
        return Err(format!(
            "Expected {} characters, got {}",
            ENCODED_LENGTH,
            s.len()
        ));
    }

    let mut num: u128 = 0;
    for c in s.bytes() {
        let idx = match c {
            b'0'..=b'9' => c - b'0',
            b'A'..=b'Z' => c - b'A' + 10,
            b'a'..=b'z' => c - b'a' + 36,
            _ => return Err(format!("Invalid base62 character: {}", c as char)),
        };
        num = num * 62 + idx as u128;
    }

    Ok(num.to_be_bytes())
}

/// Generate a prefixed ID: `{prefix}{base62(uuidv7)}`
pub fn generate_id(prefix: &str) -> String {
    bytes_to_id(prefix, &generate_uuidv7())
}

/// Parse a prefixed ID back to its prefix and raw bytes.
pub fn parse_id(id: &str) -> Result<(String, [u8; 16]), String> {
    let idx = id.rfind('_').ok_or("Invalid ID format: missing prefix separator")?;
    let prefix = &id[..=idx];
    let encoded = &id[idx + 1..];
    let bytes = base62_decode(encoded)?;
    Ok((prefix.to_string(), bytes))
}

/// Strip prefix and decode to raw 16 bytes (for DB storage).
pub fn id_to_bytes(id: &str) -> Result<[u8; 16], String> {
    parse_id(id).map(|(_, bytes)| bytes)
}

/// Encode raw bytes to a prefixed ID.
pub fn bytes_to_id(prefix: &str, bytes: &[u8; 16]) -> String {
    format!("{}{}", prefix, base62_encode(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn uuidv7_is_16_bytes() {
        let bytes = generate_uuidv7();
        assert_eq!(bytes.len(), 16);
    }

    #[test]
    fn uuidv7_version_is_7() {
        let bytes = generate_uuidv7();
        assert_eq!((bytes[6] >> 4) & 0x0f, 7);
    }

    #[test]
    fn uuidv7_variant_is_rfc4122() {
        let bytes = generate_uuidv7();
        assert_eq!((bytes[8] >> 6) & 0x03, 2);
    }

    #[test]
    fn base62_round_trip() {
        let original = generate_uuidv7();
        let encoded = base62_encode(&original);
        let decoded = base62_decode(&encoded).unwrap();
        assert_eq!(original, decoded);
    }

    #[test]
    fn base62_encoded_length_is_22() {
        let encoded = base62_encode(&generate_uuidv7());
        assert_eq!(encoded.len(), 22);
    }

    #[test]
    fn base62_round_trip_zeros() {
        let zeros = [0u8; 16];
        let encoded = base62_encode(&zeros);
        let decoded = base62_decode(&encoded).unwrap();
        assert_eq!(zeros, decoded);
    }

    #[test]
    fn base62_round_trip_max() {
        let maxes = [0xffu8; 16];
        let encoded = base62_encode(&maxes);
        let decoded = base62_decode(&encoded).unwrap();
        assert_eq!(maxes, decoded);
    }

    #[test]
    fn ids_are_sortable() {
        let a = generate_id("sb_");
        thread::sleep(Duration::from_millis(2));
        let b = generate_id("sb_");
        assert!(a < b, "Expected {} < {}", a, b);
    }

    #[test]
    fn parse_id_works_for_all_prefixes() {
        let prefixes = [
            SANDBOX_PREFIX,
            EXEC_PREFIX,
            SESSION_PREFIX,
            ARTIFACT_PREFIX,
            IMAGE_PREFIX,
            PROFILE_PREFIX,
            NODE_PREFIX,
            PROJECT_PREFIX,
        ];

        for prefix in prefixes {
            let id = generate_id(prefix);
            let (parsed_prefix, bytes) = parse_id(&id).unwrap();
            assert_eq!(parsed_prefix, prefix);
            assert_eq!(bytes.len(), 16);
        }
    }

    #[test]
    fn id_to_bytes_round_trip() {
        let id = generate_id("art_");
        let bytes = id_to_bytes(&id).unwrap();
        let reconstructed = bytes_to_id("art_", &bytes);
        assert_eq!(id, reconstructed);
    }
}

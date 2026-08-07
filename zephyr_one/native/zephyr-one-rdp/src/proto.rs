//! Length-prefixed binary framing between the Node bridge and this helper.
//!
//! Every frame is `u32 LE length` followed by `length` bytes whose first byte is
//! the message type. Binary rather than JSON because the hot path is raw RGBA
//! pixels: base64/JSON would add ~33% and a full-frame copy per update.
//!
//! Pure Rust with no FFI, so the whole codec is unit-testable without FreeRDP.

use std::io::{self, Read, Write};

/* ── host → helper ─────────────────────────────────────────────────────────
 * The config arrives as a message rather than argv or an env var: argv is world
 * readable through `ps` on Linux and macOS, and this payload carries the RDP
 * password. */
pub const MSG_CONFIG: u8 = 0x00;
pub const MSG_MOUSE: u8 = 0x01;
pub const MSG_MOUSE_EX: u8 = 0x02;
pub const MSG_SCANCODE: u8 = 0x03;
pub const MSG_UNICODE: u8 = 0x04;
pub const MSG_SYNC: u8 = 0x05;
pub const MSG_RESIZE: u8 = 0x06;
pub const MSG_CLIPBOARD: u8 = 0x07;
pub const MSG_FULL_FRAME: u8 = 0x08;
pub const MSG_STOP: u8 = 0x09;

/* ── helper → host ───────────────────────────────────────────────────────── */
pub const MSG_FRAME: u8 = 0x81;
pub const MSG_EVENT: u8 = 0x82;

/// Hard cap on an inbound frame.
///
/// Without it, a corrupted or hostile length prefix would make the helper
/// allocate up to 4 GiB before failing. The largest legitimate inbound message
/// is a clipboard payload, so 16 MiB is generous while staying bounded.
pub const MAX_INBOUND_FRAME: usize = 16 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum Inbound {
    Config(Vec<u8>),
    Mouse { flags: u16, x: u16, y: u16 },
    MouseEx { flags: u16, x: u16, y: u16 },
    Scancode { flags: u16, code: u16 },
    Unicode { flags: u16, code: u16 },
    Sync { toggles: u32 },
    Resize { width: u32, height: u32 },
    Clipboard(String),
    FullFrame,
    Stop,
}

#[derive(Debug)]
pub enum DecodeError {
    /// Body was shorter than the message type requires. Reported rather than
    /// tolerated: a short body means the stream is desynchronised, and guessing
    /// would turn one bad frame into permanent corruption.
    Truncated { kind: u8, need: usize, got: usize },
    UnknownKind(u8),
    /// Clipboard payload was not valid UTF-8.
    BadUtf8,
    Empty,
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DecodeError::Truncated { kind, need, got } => {
                write!(f, "message 0x{kind:02x} needs {need} bytes, got {got}")
            }
            DecodeError::UnknownKind(kind) => write!(f, "unknown message type 0x{kind:02x}"),
            DecodeError::BadUtf8 => write!(f, "clipboard payload is not valid UTF-8"),
            DecodeError::Empty => write!(f, "empty frame"),
        }
    }
}

fn u16_at(body: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([body[offset], body[offset + 1]])
}

fn u32_at(body: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        body[offset],
        body[offset + 1],
        body[offset + 2],
        body[offset + 3],
    ])
}

/// Decode one frame body (type byte included).
pub fn decode(body: &[u8]) -> Result<Inbound, DecodeError> {
    let kind = *body.first().ok_or(DecodeError::Empty)?;
    let payload = &body[1..];

    let need = |n: usize| -> Result<(), DecodeError> {
        if payload.len() < n {
            Err(DecodeError::Truncated {
                kind,
                need: n,
                got: payload.len(),
            })
        } else {
            Ok(())
        }
    };

    match kind {
        MSG_CONFIG => Ok(Inbound::Config(payload.to_vec())),
        MSG_MOUSE | MSG_MOUSE_EX => {
            need(6)?;
            let (flags, x, y) = (u16_at(payload, 0), u16_at(payload, 2), u16_at(payload, 4));
            Ok(if kind == MSG_MOUSE {
                Inbound::Mouse { flags, x, y }
            } else {
                Inbound::MouseEx { flags, x, y }
            })
        }
        MSG_SCANCODE | MSG_UNICODE => {
            need(4)?;
            let (flags, code) = (u16_at(payload, 0), u16_at(payload, 2));
            Ok(if kind == MSG_SCANCODE {
                Inbound::Scancode { flags, code }
            } else {
                Inbound::Unicode { flags, code }
            })
        }
        MSG_SYNC => {
            need(4)?;
            Ok(Inbound::Sync {
                toggles: u32_at(payload, 0),
            })
        }
        MSG_RESIZE => {
            need(8)?;
            Ok(Inbound::Resize {
                width: u32_at(payload, 0),
                height: u32_at(payload, 4),
            })
        }
        MSG_CLIPBOARD => match std::str::from_utf8(payload) {
            Ok(text) => Ok(Inbound::Clipboard(text.to_string())),
            Err(_) => Err(DecodeError::BadUtf8),
        },
        MSG_FULL_FRAME => Ok(Inbound::FullFrame),
        MSG_STOP => Ok(Inbound::Stop),
        other => Err(DecodeError::UnknownKind(other)),
    }
}

/// Read one length-prefixed frame. `Ok(None)` means clean EOF.
pub fn read_frame<R: Read>(reader: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut len_buf = [0u8; 4];
    match reader.read_exact(&mut len_buf) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let len = u32::from_le_bytes(len_buf) as usize;
    if len == 0 {
        return Ok(Some(Vec::new()));
    }
    if len > MAX_INBOUND_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("inbound frame of {len} bytes exceeds the {MAX_INBOUND_FRAME} cap"),
        ));
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;
    Ok(Some(body))
}

/// Serialise a damage rect + RGBA pixels into one frame.
pub fn encode_frame(x: u16, y: u16, w: u16, h: u16, pixels: &[u8]) -> Vec<u8> {
    let body_len = 1 + 8 + pixels.len();
    let mut out = Vec::with_capacity(4 + body_len);
    out.extend_from_slice(&(body_len as u32).to_le_bytes());
    out.push(MSG_FRAME);
    out.extend_from_slice(&x.to_le_bytes());
    out.extend_from_slice(&y.to_le_bytes());
    out.extend_from_slice(&w.to_le_bytes());
    out.extend_from_slice(&h.to_le_bytes());
    out.extend_from_slice(pixels);
    out
}

/// Serialise a JSON event into one frame.
pub fn encode_event(json: &str) -> Vec<u8> {
    let bytes = json.as_bytes();
    let body_len = 1 + bytes.len();
    let mut out = Vec::with_capacity(4 + body_len);
    out.extend_from_slice(&(body_len as u32).to_le_bytes());
    out.push(MSG_EVENT);
    out.extend_from_slice(bytes);
    out
}

/// Write a pre-encoded frame, flushing so the peer sees it without waiting for
/// a buffer to fill.
pub fn write_all<W: Write>(writer: &mut W, frame: &[u8]) -> io::Result<()> {
    writer.write_all(frame)?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mouse_round_trips() {
        let mut body = vec![MSG_MOUSE];
        body.extend_from_slice(&0x8000u16.to_le_bytes());
        body.extend_from_slice(&1234u16.to_le_bytes());
        body.extend_from_slice(&567u16.to_le_bytes());
        assert_eq!(
            decode(&body).unwrap(),
            Inbound::Mouse {
                flags: 0x8000,
                x: 1234,
                y: 567
            }
        );
    }

    #[test]
    fn mouse_and_mouse_ex_are_distinct() {
        // Extended mouse events carry the X1/X2 buttons. Collapsing them into
        // the same variant would silently send back/forward as left-click.
        let mk = |kind: u8| {
            let mut body = vec![kind];
            body.extend_from_slice(&1u16.to_le_bytes());
            body.extend_from_slice(&2u16.to_le_bytes());
            body.extend_from_slice(&3u16.to_le_bytes());
            decode(&body).unwrap()
        };
        assert!(matches!(mk(MSG_MOUSE), Inbound::Mouse { .. }));
        assert!(matches!(mk(MSG_MOUSE_EX), Inbound::MouseEx { .. }));
        assert_ne!(mk(MSG_MOUSE), mk(MSG_MOUSE_EX));
    }

    #[test]
    fn scancode_and_unicode_are_distinct() {
        let mk = |kind: u8| {
            let mut body = vec![kind];
            body.extend_from_slice(&0x4000u16.to_le_bytes());
            body.extend_from_slice(&0x1Cu16.to_le_bytes());
            decode(&body).unwrap()
        };
        assert!(matches!(mk(MSG_SCANCODE), Inbound::Scancode { .. }));
        assert!(matches!(mk(MSG_UNICODE), Inbound::Unicode { .. }));
    }

    #[test]
    fn resize_reads_two_u32s() {
        let mut body = vec![MSG_RESIZE];
        body.extend_from_slice(&2560u32.to_le_bytes());
        body.extend_from_slice(&1440u32.to_le_bytes());
        assert_eq!(
            decode(&body).unwrap(),
            Inbound::Resize {
                width: 2560,
                height: 1440
            }
        );
    }

    #[test]
    fn clipboard_carries_utf8_including_cjk_and_emoji() {
        let text = "文件夹映射 📁";
        let mut body = vec![MSG_CLIPBOARD];
        body.extend_from_slice(text.as_bytes());
        assert_eq!(decode(&body).unwrap(), Inbound::Clipboard(text.to_string()));
    }

    #[test]
    fn invalid_utf8_clipboard_is_rejected_not_replaced() {
        // Lossy conversion would hand the remote session mojibake and look like
        // a clipboard bug rather than a protocol error.
        let body = vec![MSG_CLIPBOARD, 0xFF, 0xFE];
        assert!(matches!(decode(&body), Err(DecodeError::BadUtf8)));
    }

    #[test]
    fn truncated_bodies_are_errors_not_partial_reads() {
        let short_mouse = vec![MSG_MOUSE, 0x00, 0x80, 0x01];
        match decode(&short_mouse) {
            Err(DecodeError::Truncated { kind, need, got }) => {
                assert_eq!(kind, MSG_MOUSE);
                assert_eq!(need, 6);
                assert_eq!(got, 3);
            }
            other => panic!("expected Truncated, got {other:?}"),
        }
        assert!(matches!(
            decode(&[MSG_SYNC, 0x01]),
            Err(DecodeError::Truncated { .. })
        ));
        assert!(matches!(
            decode(&[MSG_RESIZE, 0, 0, 0, 0]),
            Err(DecodeError::Truncated { .. })
        ));
    }

    #[test]
    fn empty_and_unknown_frames_are_rejected() {
        assert!(matches!(decode(&[]), Err(DecodeError::Empty)));
        assert!(matches!(decode(&[0x7F]), Err(DecodeError::UnknownKind(0x7F))));
    }

    #[test]
    fn payloadless_messages_need_no_body() {
        assert_eq!(decode(&[MSG_FULL_FRAME]).unwrap(), Inbound::FullFrame);
        assert_eq!(decode(&[MSG_STOP]).unwrap(), Inbound::Stop);
    }

    #[test]
    fn read_frame_handles_stream_boundaries() {
        // Two frames back to back in one buffer: proves the reader consumes
        // exactly one frame and leaves the next intact.
        let mut stream = Vec::new();
        stream.extend_from_slice(&encode_event("{\"a\":1}"));
        stream.extend_from_slice(&encode_frame(1, 2, 3, 4, &[9u8; 48]));
        let mut cursor = std::io::Cursor::new(stream);

        let first = read_frame(&mut cursor).unwrap().unwrap();
        assert_eq!(first[0], MSG_EVENT);
        assert_eq!(&first[1..], b"{\"a\":1}");

        let second = read_frame(&mut cursor).unwrap().unwrap();
        assert_eq!(second[0], MSG_FRAME);
        assert_eq!(second.len(), 1 + 8 + 48);

        assert!(read_frame(&mut cursor).unwrap().is_none(), "clean EOF");
    }

    #[test]
    fn read_frame_rejects_an_oversized_length_prefix() {
        // A hostile prefix must not become a multi-gigabyte allocation.
        let mut stream = Vec::new();
        stream.extend_from_slice(&(u32::MAX).to_le_bytes());
        let mut cursor = std::io::Cursor::new(stream);
        let error = read_frame(&mut cursor).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn read_frame_reports_eof_mid_body_as_error() {
        // Distinguishing "clean EOF between frames" from "died mid-frame"
        // matters: the first is a normal shutdown, the second is data loss.
        let mut stream = Vec::new();
        stream.extend_from_slice(&16u32.to_le_bytes());
        stream.extend_from_slice(&[1, 2, 3]);
        let mut cursor = std::io::Cursor::new(stream);
        let error = read_frame(&mut cursor).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
    }

    #[test]
    fn encode_frame_layout_is_exact() {
        let pixels = [1u8, 2, 3, 4, 5, 6, 7, 8];
        let frame = encode_frame(0x0102, 0x0304, 0x0001, 0x0002, &pixels);
        assert_eq!(&frame[0..4], &(9u32 + 8).to_le_bytes());
        assert_eq!(frame[4], MSG_FRAME);
        assert_eq!(&frame[5..7], &0x0102u16.to_le_bytes());
        assert_eq!(&frame[7..9], &0x0304u16.to_le_bytes());
        assert_eq!(&frame[9..11], &1u16.to_le_bytes());
        assert_eq!(&frame[11..13], &2u16.to_le_bytes());
        assert_eq!(&frame[13..], &pixels);
    }

    #[test]
    fn config_body_is_passed_through_verbatim() {
        // The config is JSON handled by main; proto must not interpret it.
        let json = br#"{"host":"a"}"#;
        let mut body = vec![MSG_CONFIG];
        body.extend_from_slice(json);
        assert_eq!(decode(&body).unwrap(), Inbound::Config(json.to_vec()));
    }
}

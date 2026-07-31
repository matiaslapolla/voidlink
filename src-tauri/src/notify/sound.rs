//! The sound library: semantic cues, packs, and one audio device.
//!
//! ## Why Rust and not Web Audio
//!
//! A webview-hosted sound picks an arbitrary window as the speaker and stops
//! making sense the moment that window closes — the editor window playing the
//! chime for a turn that finished in the workbench, and then silence after the
//! user closes the editor. Same argument as the journal and the notifier: three
//! windows, one process, and the thing that is genuinely singular belongs in the
//! singular place.
//!
//! ## Cues, not filenames
//!
//! `play(pack, Cue::TurnFinished, volume)`. A call site that names a `.wav` is a
//! call site with an opinion about the theme, and the first time somebody wants
//! a different pack they have to go and find all of them. A pack is a map from
//! cue to bundled asset; there is a default and a silent one today, and the
//! shape is what makes a third cheap.
//!
//! ## What is deliberately *not* here
//!
//! **A cue for anything that also shows a banner.** The platform plays a banner's
//! sound itself, and that path respects macOS Focus modes and Do Not Disturb for
//! free. Playing ours on top would double the sound and ignore both. So `rodio`
//! is only ever reached for the banner-less levels — the chime while you are
//! looking at the app, the terminal bell, the failure buzz that accompanies a
//! mark rather than a banner. `notify::dispatch` enforces that, and this module
//! is only the mechanism.
//!
//! Do Not Disturb is therefore honoured on the banner path and *not* on this
//! one, which is a real gap: there is no cross-platform way to read the OS focus
//! state from Rust without another dependency per platform. Recorded rather than
//! papered over, and it is the strongest argument for routing anything
//! user-visible through the notification channel wherever possible. Quiet hours
//! in `Config` are the in-app substitute.

use std::io::Cursor;
use std::sync::OnceLock;

/// The pack shipped in `resources/sounds/default`.
pub const DEFAULT_PACK: &str = "default";
/// A pack with no entries. Not a directory of silent files — see the note in
/// `resources/sounds/LICENSE.md` for why an empty map is the better shape.
pub const SILENT_PACK: &str = "silent";

/// Every sound this app can make, named by what happened rather than by what it
/// sounds like.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cue {
    TurnFinished,
    TurnFailed,
    /// The generic "look at me": a terminal bell, an OSC 9, a trigger firing.
    Attention,
    Conflict,
    RunAdopted,
}

impl Cue {
    /// The asset's filename. Only reached when decoding fails, which is the one
    /// moment the operator needs to know *which* file is bad rather than which
    /// cue was wanted.
    pub fn file(self) -> &'static str {
        match self {
            Cue::TurnFinished => "turn-finished.wav",
            Cue::TurnFailed => "turn-failed.wav",
            Cue::Attention => "attention.wav",
            Cue::Conflict => "conflict.wav",
            Cue::RunAdopted => "run-adopted.wav",
        }
    }

    /// The bytes, compiled in.
    ///
    /// Embedded rather than read from the resource directory at runtime, for
    /// two reasons: a cue that fails to load is silent in a way nobody notices
    /// until the one time it mattered, and resolving a resource path costs an
    /// `AppHandle` that would then have to be threaded through every caller of
    /// a function whose whole job is to be callable from anywhere. Five files,
    /// ~320 KB total, once.
    fn bytes(self) -> &'static [u8] {
        match self {
            Cue::TurnFinished => include_bytes!("../../resources/sounds/default/turn-finished.wav"),
            Cue::TurnFailed => include_bytes!("../../resources/sounds/default/turn-failed.wav"),
            Cue::Attention => include_bytes!("../../resources/sounds/default/attention.wav"),
            Cue::Conflict => include_bytes!("../../resources/sounds/default/conflict.wav"),
            Cue::RunAdopted => include_bytes!("../../resources/sounds/default/run-adopted.wav"),
        }
    }
}

/// Does this pack have anything to say for this cue?
///
/// Pure, so the pack rules are testable without an audio device — which matters
/// because "the silent pack was not silent" is exactly the kind of regression
/// that ships.
pub fn resolve(pack: &str, cue: Cue) -> Option<&'static [u8]> {
    match pack {
        SILENT_PACK => None,
        // An unknown pack name falls back to the default rather than to
        // silence. A typo in a settings file should not quietly disable a
        // feature; it should behave normally and be discoverable.
        _ => Some(cue.bytes()),
    }
}

/// The audio device, opened once and kept.
///
/// `OnceLock` rather than opening per cue: on macOS, opening an output stream
/// costs tens of milliseconds and briefly takes the audio focus, which is
/// audible as a gap in whatever else is playing. A user who gets four cues in a
/// minute would hear their music stutter four times.
///
/// `None` when there is no device — a headless CI machine, or a session with no
/// audio server. That is not an error worth surfacing: the banner and the in-app
/// mark are still doing their jobs.
static STREAM: OnceLock<Option<rodio::MixerDeviceSink>> = OnceLock::new();

fn stream() -> Option<&'static rodio::MixerDeviceSink> {
    STREAM
        .get_or_init(|| match rodio::DeviceSinkBuilder::open_default_sink() {
            Ok(mut s) => {
                // The handle is a process-lifetime static, so it is only ever
                // dropped at exit — where rodio's default "the sink was
                // dropped" log line is noise about a shutdown nobody can act
                // on.
                s.log_on_drop(false);
                Some(s)
            }
            Err(e) => {
                log::info!("no audio output device; sound cues are disabled ({e})");
                None
            }
        })
        .as_ref()
}

/// Play one cue. Never blocks, never fails loudly.
///
/// A sound that could return an error would put a `?` at every call site of a
/// function whose failure mode is "the user did not hear a chime". Same contract
/// as `journal::record`, for the same reason.
pub fn play(pack: &str, cue: Cue, volume: f32) {
    let volume = volume.clamp(0.0, 1.0);
    if volume <= 0.0 {
        return;
    }
    let Some(bytes) = resolve(pack, cue) else {
        return;
    };
    let Some(stream) = stream() else {
        return;
    };

    let player = rodio::Player::connect_new(stream.mixer());
    match rodio::Decoder::new(Cursor::new(bytes)) {
        Ok(source) => {
            player.set_volume(volume);
            player.append(source);
            // Detached: the cue outlives this call by design, and a cue that
            // held the caller for half a second would stall the journal's
            // append path.
            player.detach();
        }
        Err(e) => log::warn!("could not decode {} for the {cue:?} cue: {e}", cue.file()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [Cue; 5] = [
        Cue::TurnFinished,
        Cue::TurnFailed,
        Cue::Attention,
        Cue::Conflict,
        Cue::RunAdopted,
    ];

    /// The bundled pack has to answer for every cue. A cue added without an
    /// asset would be silent, and silence is indistinguishable from "the
    /// feature is off" — this is the test that makes adding a cue fail loudly.
    #[test]
    fn the_default_pack_covers_every_cue() {
        for cue in ALL {
            assert!(resolve(DEFAULT_PACK, cue).is_some(), "{cue:?} has no asset");
            assert!(!cue.bytes().is_empty(), "{cue:?} is empty");
        }
    }

    #[test]
    fn the_silent_pack_is_silent_for_every_cue() {
        for cue in ALL {
            assert!(resolve(SILENT_PACK, cue).is_none(), "{cue:?} was not silent");
        }
    }

    /// A typo in a settings file should not quietly disable a feature.
    #[test]
    fn an_unknown_pack_falls_back_rather_than_going_silent() {
        assert!(resolve("does-not-exist", Cue::Attention).is_some());
    }

    #[test]
    fn every_asset_is_a_riff_wave() {
        for cue in ALL {
            let b = cue.bytes();
            assert_eq!(&b[0..4], b"RIFF", "{cue:?} is not RIFF");
            assert_eq!(&b[8..12], b"WAVE", "{cue:?} is not WAVE");
        }
    }

    /// Distinct cues have to be distinguishable; two names pointing at one file
    /// is a copy-paste error that no other test would catch.
    #[test]
    fn no_two_cues_share_an_asset() {
        for (i, a) in ALL.iter().enumerate() {
            for b in &ALL[i + 1..] {
                assert_ne!(a.file(), b.file(), "{a:?} and {b:?} share a file");
                assert_ne!(a.bytes(), b.bytes(), "{a:?} and {b:?} share bytes");
            }
        }
    }

    /// Zero volume must not reach the device at all, so muting is free rather
    /// than "playing silently".
    #[test]
    fn zero_volume_plays_nothing() {
        play(DEFAULT_PACK, Cue::Attention, 0.0);
    }
}

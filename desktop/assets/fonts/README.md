# Font assets

The egui desktop expects Geist Sans and Geist Mono here. These files are
gitignored because they ship under the SIL Open Font License and we want the
license bundle to live next to them rather than in a patch diff.

Drop in:

- `Geist-Regular.ttf`
- `Geist-Medium.ttf`
- `GeistMono-Regular.ttf`
- `LICENSE.txt` (the OFL text from the upstream font distribution)

Download from <https://vercel.com/font> or the Geist GitHub release. The
loader at `desktop/src/fonts.rs` reads from this directory at startup and
falls back to the egui default if any file is missing.

When the assets are in place, the bundling step should copy this directory
next to the built binary (`desktop/assets/fonts/` → `<bindir>/assets/fonts/`).

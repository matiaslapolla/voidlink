.PHONY: help dev frontend bundle bundle-deb bundle-macos bundle-macos-dmg bundle-macos-universal check lint build version

help:
	@echo ""
	@echo "  VoidLink dev commands"
	@echo ""
	@echo "  make dev                     Run Tauri desktop app"
	@echo "  make frontend                Run Vite dev server (browser-only)"
	@echo "  make bundle                  Build release bundle (AppImage, deb, rpm)"
	@echo "  make bundle-deb              Build .deb only"
	@echo "  make bundle-macos            Build macOS .app + .dmg for current arch"
	@echo "  make bundle-macos-dmg        Build macOS .dmg only (current arch)"
	@echo "  make bundle-macos-universal  Build macOS universal (arm64 + x86_64)"
	@echo "  make lint                    Lint frontend"
	@echo "  make build                   Type-check + build frontend"
	@echo "  make check                   Run lint + build + cargo check"
	@echo "  make version V=x.y.z         Bump version across frontend + tauri"
	@echo ""

dev:
	WEBKIT_DISABLE_DMABUF_RENDERER=1 cargo tauri dev

frontend:
	cd frontend && npm run dev

bundle:
	WEBKIT_DISABLE_DMABUF_RENDERER=1 NO_STRIP=true cargo tauri build

bundle-deb:
	WEBKIT_DISABLE_DMABUF_RENDERER=1 cargo tauri build --bundles deb

bundle-macos:
	@if [ "$$(uname)" != "Darwin" ]; then echo "bundle-macos must run on macOS"; exit 1; fi
	cargo tauri build --bundles app,dmg

bundle-macos-dmg:
	@if [ "$$(uname)" != "Darwin" ]; then echo "bundle-macos-dmg must run on macOS"; exit 1; fi
	cargo tauri build --bundles dmg

bundle-macos-universal:
	@if [ "$$(uname)" != "Darwin" ]; then echo "bundle-macos-universal must run on macOS"; exit 1; fi
	rustup target add aarch64-apple-darwin x86_64-apple-darwin
	cargo tauri build --target universal-apple-darwin --bundles app,dmg

lint:
	cd frontend && npm run lint

build:
	cd frontend && npm run build

check: lint build
	cd src-tauri && cargo check && cargo test
	@echo ""
	@echo "  All checks passed."
	@echo ""

version:
ifndef V
	$(error Usage: make version V=x.y.z)
endif
	@echo "Bumping version to $(V)..."
	cd frontend && npm version $(V) --no-git-tag-version
	sed -i 's/"version": "[^"]*"/"version": "$(V)"/' src-tauri/tauri.conf.json
	@echo "Version bumped to $(V) in frontend and tauri."

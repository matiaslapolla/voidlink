.DEFAULT_GOAL := help
.PHONY: help dev frontend lint build test check bundle version

# Wayland/WebKitGTK workaround. No-op on macOS.
LINUX_ENV := WEBKIT_DISABLE_DMABUF_RENDERER=1

help: ## Show available commands
	@echo ""
	@echo "  VoidLink dev commands"
	@echo ""
	@awk 'BEGIN{FS=":.*## "} /^[a-z][a-z-]*:.*## /{printf "  make %-9s %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@echo ""

dev: ## Run the Tauri desktop app
	$(LINUX_ENV) cargo tauri dev

frontend: ## Run the Vite dev server only (browser, no native shell)
	cd frontend && npm run dev

lint: ## Lint the frontend
	cd frontend && npm run lint

build: ## Type-check and build the frontend
	cd frontend && npm run build

test: ## Run frontend (vitest) and Rust tests
	cd frontend && npm test
	cd src-tauri && cargo test

check: lint build test ## Everything CI runs: lint, build, tests, cargo check
	cd src-tauri && cargo check
	@echo ""
	@echo "  All checks passed."
	@echo ""

bundle: ## Build a release bundle (B=deb|dmg|app,dmg, TARGET=universal-apple-darwin)
	$(LINUX_ENV) NO_STRIP=true cargo tauri build $(if $(B),--bundles $(B)) $(if $(TARGET),--target $(TARGET))

version: ## Bump version across frontend, tauri.conf.json, Cargo.toml (V=x.y.z)
ifndef V
	$(error Usage: make version V=x.y.z)
endif
	cd frontend && npm version $(V) --no-git-tag-version
	perl -pi -e 's/"version": "[^"]*"/"version": "$(V)"/' src-tauri/tauri.conf.json
	perl -pi -e 's/^version = "[^"]*"/version = "$(V)"/' src-tauri/Cargo.toml
	@echo "Version bumped to $(V)."

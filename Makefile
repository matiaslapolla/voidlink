.PHONY: help \
        docker-up docker-down docker-logs docker-rebuild \
        backend frontend app bundle \
        dev check test-frontend test-backend test-tauri \
        version

# ── Default ──────────────────────────────────────────────────────────────────
help:
	@echo ""
	@echo "  VoidLink dev commands"
	@echo ""
	@echo "  make docker-up       Start Postgres + backend (detached)"
	@echo "  make docker-down     Stop all containers"
	@echo "  make docker-logs     Tail container logs"
	@echo "  make docker-rebuild  Rebuild backend image and restart"
	@echo ""
	@echo "  make backend         Run FastAPI locally (uv, hot-reload)"
	@echo "  make frontend        Run Vite dev server"
	@echo "  make app             Run Tauri desktop app (cargo tauri dev)"
	@echo ""
	@echo "  make dev             docker-up + Tauri (full stack)"
	@echo "  make bundle          Build release bundle (AppImage, deb)"
	@echo ""

# ── Docker ───────────────────────────────────────────────────────────────────
docker-up:
	docker compose up -d

docker-down:
	docker compose down

docker-logs:
	docker compose logs -f

docker-rebuild:
	docker compose up -d --build backend

# ── Individual services ───────────────────────────────────────────────────────
backend:
	cd backend && uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

frontend:
	cd frontend && npm run dev

app:
	WEBKIT_DISABLE_DMABUF_RENDERER=1 cargo tauri dev

# ── Full-stack shortcut ───────────────────────────────────────────────────────
dev: docker-up
	WEBKIT_DISABLE_DMABUF_RENDERER=1 cargo tauri dev

# ── Release bundle ────────────────────────────────────────────────────────
# Builds deb + rpm + AppImage.
# NO_STRIP=true prevents linuxdeploy's bundled strip from choking on
# newer ELF sections (.relr.dyn) on Arch/CachyOS. Our Rust binary is
# already stripped via [profile.release] strip = true.
bundle:
	WEBKIT_DISABLE_DMABUF_RENDERER=1 NO_STRIP=true cargo tauri build

bundle-deb:
	WEBKIT_DISABLE_DMABUF_RENDERER=1 cargo tauri build --bundles deb

# ── Testing ──────────────────────────────────────────────────────────────────
test-frontend:
	cd frontend && npm run lint && npm run build && npm test

test-backend:
	cd backend && uv run pytest tests/ -v

test-tauri:
	cd src-tauri && cargo check && cargo test

check: test-frontend test-backend test-tauri
	@echo ""
	@echo "  All checks passed."
	@echo ""

# ── Versioning ───────────────────────────────────────────────────────────────
# Usage: make version V=1.0.0
version:
ifndef V
	$(error Usage: make version V=x.y.z)
endif
	@echo "Bumping version to $(V)..."
	cd frontend && npm version $(V) --no-git-tag-version
	sed -i '' 's/"version": "[^"]*"/"version": "$(V)"/' src-tauri/tauri.conf.json
	sed -i '' 's/^version = "[^"]*"/version = "$(V)"/' backend/pyproject.toml
	@echo "Version bumped to $(V) in frontend, backend, and tauri."

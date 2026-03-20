.PHONY: help \
         docker-up docker-down docker-logs docker-rebuild \
         backend frontend app \
         dev check test-frontend test-backend test-tauri \
         setup install \
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
	cargo tauri dev

# ── Full-stack shortcut ───────────────────────────────────────────────────────
dev: docker-up
	cargo tauri dev

# ── Testing ──────────────────────────────────────────────────────────────────
test-frontend:
	cd frontend && npm run lint && npm run build && npm test

test-backend:
	cd backend && uv run pytest tests/ -v

test-tauri:
	cd src-tauri && cargo check && cargo test

check: test-frontend test-backend test-tauri
	@echo ""
	@echo " All checks passed."
	@echo ""

# ── Setup / Install ───────────────────────────────────────────────────────────
setup:
	@echo "📦 Installing frontend dependencies..."
	cd frontend && npm install
	@echo "🐍 Installing backend dependencies..."
	cd backend && uv sync
	@echo "🦀 Installing Tauri CLI (if not already installed)..."
	cargo install tauri-cli --quiet
	@echo ""
	@echo "✅ Setup complete!"
	@echo ""
	@echo "To start development:"
	@echo "  make dev                    (Start Postgres + Tauri desktop app)"
	@echo "  make backend                (Run backend only)"
	@echo "  make frontend               (Run frontend only)"
	@echo ""

install: setup

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

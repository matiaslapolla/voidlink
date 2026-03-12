# VoidLink — Commit, Deployment & Launch Protocol

## 1. Branch Strategy

```
main            ← always deployable, protected
feat/<name>     ← feature branches (e.g., feat/query-wrapper)
fix/<name>      ← bug fixes
chore/<name>    ← tooling, deps, docs
release/vX.Y.Z  ← release prep branches
```

### Rules
- **Never push directly to `main`** — always use PRs.
- PRs require CI to pass before merge.
- Squash merge for features; regular merge for releases.
- Delete branches after merge.

---

## 2. Commit Convention

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

### Types
| Type       | When                                      |
|------------|-------------------------------------------|
| `feat`     | New feature                               |
| `fix`      | Bug fix                                   |
| `docs`     | Documentation only                        |
| `style`    | Formatting, no logic change               |
| `refactor` | Code change that neither fixes nor adds   |
| `test`     | Adding or fixing tests                    |
| `chore`    | Build, CI, deps, tooling                  |
| `perf`     | Performance improvement                   |

### Scopes
`frontend`, `backend`, `tauri`, `docker`, `ci`, `docs`

### Examples
```
feat(frontend): add slash command menu to editor
fix(backend): handle empty content in page create
chore(ci): add Tauri release build workflow
test(backend): add pages CRUD endpoint tests
```

---

## 3. Pre-Commit Checklist

Before every commit:

```bash
# Frontend
cd frontend && npm run lint && npm run build && npm test

# Backend
cd backend && uv run pytest tests/ -v

# Rust
cd src-tauri && cargo check && cargo test
```

Or use the Makefile shortcut:
```bash
make check
```

---

## 4. CI Pipeline

CI runs automatically on push/PR to `main` (`.github/workflows/ci.yml`):

| Job        | What it does                                          |
|------------|-------------------------------------------------------|
| `frontend` | npm ci → lint → build → test                         |
| `backend`  | uv sync → pytest                                     |
| `tauri`    | Build frontend → cargo test → cargo check (macOS+Linux) |

### Release Pipeline (`.github/workflows/release.yml`)

Triggered on version tags (`v*`):

1. Build Tauri desktop app for macOS and Linux
2. Create GitHub Release with binaries attached
3. Build and push backend Docker image to GHCR

---

## 5. Versioning

Semantic Versioning: `MAJOR.MINOR.PATCH`

- **MAJOR**: Breaking changes to API or data format
- **MINOR**: New features, backward compatible
- **PATCH**: Bug fixes

Version is tracked in:
- `src-tauri/tauri.conf.json` → `version`
- `frontend/package.json` → `version`
- `backend/pyproject.toml` → `version`

---

## 6. Release Process

```bash
# 1. Create release branch
git checkout -b release/vX.Y.Z

# 2. Bump versions in all three packages
make version V=X.Y.Z

# 3. Commit version bump
git add -A && git commit -m "chore: bump version to vX.Y.Z"

# 4. Push and create PR to main
git push -u origin release/vX.Y.Z
gh pr create --title "Release vX.Y.Z" --body "Version bump and release prep"

# 5. After PR merges, tag and push
git checkout main && git pull
git tag vX.Y.Z
git push origin vX.Y.Z
# → Triggers release workflow → builds + GitHub Release
```

---

## 7. Deployment

### Local Development
```bash
make dev          # Docker (Postgres+backend) + Tauri desktop app
```

### Self-Hosted (Docker)
```bash
cp .env.example .env
# Edit .env with your DATABASE_URL, CORS_ORIGINS
docker compose up -d
```

### Desktop Distribution
- macOS: `.dmg` from GitHub Releases
- Linux: `.AppImage` / `.deb` from GitHub Releases
- Built by CI on each version tag

---

## 8. Launch Checklist (v1.0)

### Pre-Launch
- [ ] All Phase 1-3 tasks complete
- [ ] E2e tests passing (Playwright)
- [ ] Performance benchmarks documented (startup < 3s, idle RAM < 150MB)
- [ ] README updated with screenshots and GIFs
- [ ] Self-host guide tested on fresh macOS and Ubuntu
- [ ] `.env.example` covers all env vars
- [ ] LICENSE and CONTRIBUTING.md present
- [ ] Security: no secrets in repo, parameterized SQL, CORS locked down

### Launch Day
- [ ] Tag `v1.0.0` → triggers release build
- [ ] Verify GitHub Release has macOS + Linux binaries
- [ ] Verify Docker image published to GHCR
- [ ] Post to Hacker News / Reddit / Twitter
- [ ] Monitor GitHub Issues for first-day bugs

### Post-Launch
- [ ] Set up GitHub Discussions for community
- [ ] Create issue templates (bug report, feature request)
- [ ] Plan v1.1 roadmap (collab, LLM integration)

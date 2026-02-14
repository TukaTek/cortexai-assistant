# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Railway deployment wrapper for **OpenClaw** (an AI agent platform). It packages OpenClaw with a browser-based setup wizard, eliminating the need for users to run terminal commands. The wrapper manages the OpenClaw gateway lifecycle, provides authentication, state persistence via Railway volumes, and backup/restore functionality.

## Architecture

### High-Level Structure

The wrapper acts as a reverse proxy and lifecycle manager:

1. **Wrapper Server** ([src/server.js](src/server.js)) - Express server that:
   - Listens on port 8080 (configurable via `PORT` or `OPENCLAW_PUBLIC_PORT`)
   - Manages the OpenClaw gateway as a child process (internal port 18789)
   - Serves the setup wizard at `/setup` (password-protected)
   - Proxies all other traffic to the gateway (including WebSocket upgrades)
   - Handles backup export/import and config editing

2. **Setup Wizard** ([src/setup-app.js](src/setup-app.js)) - Browser UI that:
   - Runs `openclaw onboard --non-interactive` with user-provided credentials
   - Configures chat channels (Telegram, Discord, Slack)
   - Provides debug console for running safe OpenClaw commands
   - Offers raw config editor with automatic backups

3. **Docker Build** ([Dockerfile](Dockerfile)) - Multi-stage build that:
   - Builds OpenClaw from source (using pnpm and Bun)
   - Installs wrapper dependencies
   - Creates an `openclaw` executable wrapper script
   - Final image runs the wrapper server (not the gateway directly)

### State Management

- **State Directory**: `/data/.openclaw` (configurable via `OPENCLAW_STATE_DIR`)
  - Contains `openclaw.json` (main config)
  - Gateway token persisted in `gateway.token` if not provided via env
  - Automatic `.bak-*` timestamped backups when config is edited

- **Workspace Directory**: `/data/workspace` (configurable via `OPENCLAW_WORKSPACE_DIR`)
  - OpenClaw's working directory for agent sessions

- **Persistence**: Directories must be mounted to a Railway volume to survive redeploys

### Gateway Lifecycle

The wrapper manages the gateway process lifecycle:

- **Start**: Spawned via `openclaw gateway run` with internal bind (loopback only)
- **Health Check**: Polls gateway endpoints (`/openclaw`, `/clawdbot`, `/`) until responsive
- **Restart**: Terminates existing process, waits 750ms, then restarts
- **Proxy**: All non-`/setup` traffic is proxied to `http://127.0.0.1:18789`

### Environment Variables

Primary variables (OPENCLAW prefix):
- `OPENCLAW_PUBLIC_PORT` - Wrapper listen port (default: 8080)
- `OPENCLAW_STATE_DIR` - State directory path (default: `~/.openclaw`)
- `OPENCLAW_WORKSPACE_DIR` - Workspace path (default: `<state_dir>/workspace`)
- `OPENCLAW_GATEWAY_TOKEN` - Gateway auth token (auto-generated if not set)
- `SETUP_PASSWORD` - Required password for `/setup` access

**Backward Compatibility**: The wrapper shims deprecated `CLAWDBOT_*` environment variables with one-time console warnings. `MOLTBOT_*` variables are not shimmed (never used in production).

## Common Development Commands

### Local Development
```bash
# Run wrapper server (requires openclaw CLI in PATH or OPENCLAW_ENTRY set)
npm run dev          # or npm start

# Check syntax
npm run lint

# Basic sanity test (checks openclaw --version)
npm run smoke
```

### Docker Testing

Build and run locally:
```bash
docker build -t openclaw-railway-template .

docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e SETUP_PASSWORD=test \
  -e OPENCLAW_STATE_DIR=/data/.openclaw \
  -e OPENCLAW_WORKSPACE_DIR=/data/workspace \
  -v $(pwd)/.tmpdata:/data \
  openclaw-railway-template

# Open http://localhost:8080/setup (password: test)
```

### CI/CD

GitHub Actions workflow ([.github/workflows/docker-build.yml](.github/workflows/docker-build.yml)):
- Runs on PR and main branch pushes
- Validates Docker build (no push, build-only)
- Uses GitHub Actions cache for layers

## Key Implementation Details

### Setup Flow

1. User visits `/setup` and authenticates with `SETUP_PASSWORD` (HTTP Basic Auth)
2. Wizard fetches available auth providers from hardcoded `authGroups` array in [src/server.js](src/server.js) (lines 395-441)
3. User selects provider, enters credentials, optionally adds chat channels
4. Wrapper runs `openclaw onboard --non-interactive` with generated flags (see `buildOnboardArgs` function)
5. On success, wrapper writes additional config via `openclaw config set` commands
6. Gateway is started automatically and proxied

### Config Editing

The `/setup` page includes an advanced config editor that:
- Loads raw config file via `/setup/api/config/raw` (GET)
- Saves edited config via `/setup/api/config/raw` (POST)
- Creates timestamped `.bak-*` backup before overwriting
- Automatically restarts gateway after save

### Backup/Restore

- **Export**: GET `/setup/export` creates a `.tar.gz` of state + workspace directories
  - Paths are relative to `/data` for easy restoration
  - Uses `tar` package with portable, gzip compression
- **Import**: POST `/setup/import` extracts uploaded `.tar.gz` into `/data`
  - Safety checks: only allows extraction under `/data`, filters unsafe tar paths
  - Stops gateway before extraction, restarts after

### Debug Console

The `/setup` page includes a debug console with allowlisted commands:
- Wrapper lifecycle: `gateway.restart`, `gateway.stop`, `gateway.start`
- OpenClaw CLI: `openclaw status`, `openclaw health`, `openclaw doctor`, `openclaw logs --tail N`, `openclaw config get <path>`, `openclaw --version`
- Executed via `runCmd` helper (not shell, direct spawn for safety)
- Output is redacted via `redactSecrets` function (basic regex for API keys, tokens)

## Important Notes for Development

### When Modifying Environment Variables
- Always add new variables to both README deployment instructions and the shim logic if backward compatibility is needed
- Document whether a variable is required or optional in comments

### When Updating OpenClaw Version
- The Dockerfile uses `OPENCLAW_GIT_REF` build arg (default: `main`)
- To pin a specific version, change the default or pass `--build-arg OPENCLAW_GIT_REF=v1.2.3`
- The build patches `extensions/*/package.json` to relax version constraints (see Dockerfile lines 29-33)

### When Adding Auth Providers
- Update the `authGroups` array in [src/server.js](src/server.js) (lines 395-441)
- Add corresponding flag mapping in `buildOnboardArgs` function (lines 494-505)
- Keep in sync with OpenClaw's own auth choices (currently hardcoded, could parse CLI help in future)

### When Adding Chat Channels
- Channel setup happens in `/setup/api/run` endpoint after successful onboarding
- Check if the channel is supported via `channels add --help` output before attempting config
- Write config directly via `openclaw config set --json` (more reliable than `channels add`)

### Railway Deployment
- Requires a Volume mounted at `/data`
- Requires `SETUP_PASSWORD` environment variable (service will warn if missing)
- Recommended: Set `OPENCLAW_GATEWAY_TOKEN` to a generated secret in Railway template
- Custom domains: Service listens on port 8080 (not 443)
- Health check endpoint: `/setup/healthz` (configured in [railway.toml](railway.toml))

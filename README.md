# The Council

Starship Agent Mission Control is a monorepo for orchestrating and visualizing autonomous AI agent missions inside a cinematic bridge UI.

## Workspace Layout

- `apps/web`: Next.js cockpit UI with a persistent 3D bridge shell.
- `packages/contracts`: shared TypeScript contracts and JSON schema exports.
- `services/runtime`: FastAPI orchestration runtime, persistence layer, tools, and telemetry.

## Local Development

1. Install Node dependencies with `npm install`.
2. Create a Python virtual environment at `.venv` and install the runtime package with `pip install -e services/runtime[dev]`.
3. Install the Playwright browser runtime with `.venv/bin/python -m playwright install chromium`.
4. Run `npm run dev` to start both the web app and the runtime.
5. Run `npx playwright install chromium` once if you want the Node-based E2E suite.
6. Run `npm run test:e2e` to exercise the captain login and mission-control flow in a real browser.

The default operator account is `captain` / `bridge123`.

## Cockpit UX

- Command Deck is mission-first: create/select a mission workspace, edit its defaults, launch mission runs, and watch run telemetry from the same station.
- Engineering is mission-scoped: import global template agents into the selected mission as editable copies, or forge mission-local agents from scratch.
- Tactical edits the selected mission workflow, not the global template library. The node/edge editor and raw JSON stay synchronized against the same mission workflow definition.
- Crew and Archive default to the selected mission’s active or latest run.
- Engineering has a desktop-only draggable divider between the Agent Registry and Agent Forge.
- Command Deck has a desktop-only draggable divider between mission launch controls and live telemetry.
- Both resizers persist width locally per browser session, support keyboard nudging, and reset on double-click.
- Command Deck telemetry payloads wrap in place so long JSON stays inside the panel instead of widening the page.
- If a local Next.js build hits a stale-cache `/_document` failure, clear `apps/web/.next` and rebuild.

## Runtime Notes

- Missions are editable workspaces. Runs are child execution records with their own workflow snapshot, mission-agent snapshot, telemetry stream, replay, artifacts, and memory.
- Mission workflow nodes bind to mission-local agent ids. Importing a global agent template into a mission always creates an isolated mission-local copy.
- Only one active run is allowed per mission in v1. Structural mission edits are blocked unless there is no active run or the active run is paused.
- When a paused run is edited structurally, the runtime updates both the paused run snapshot and the mission workspace default so future runs inherit the same changes.
- Startup schema patching is dialect-aware for both SQLite and PostgreSQL-backed deployments.
- Telemetry uses local websocket fanout by default and upgrades to Redis pub/sub automatically when `REDIS_URL` is reachable.
- Artifact storage writes to the local filesystem by default and uploads to an S3-compatible object store when `OBJECT_STORE_*` settings are provided.
- The provided Docker Compose stack enables Redis telemetry and MinIO-backed artifact storage out of the box.

## Docker

Run `docker compose up --build` to start the cockpit, runtime, Postgres with pgvector, Redis, and MinIO.

## Blue/Green Deploy

- Production deploy assets live under `deploy/`.
- The entrypoint is `deploy/scripts/bluegreen.sh`.
- The production stack uses `deploy/docker-compose.bluegreen.yml` with one shared proxy and shared data services plus `web-blue` / `web-green` and `runtime-blue` / `runtime-green`.
- The proxy flips traffic by regenerating an Nginx upstream file and reloading in place after the target color passes health checks and a proxied smoke check.
- If smoke checks fail after cutover, the script automatically restores the previous color when one exists.

Typical commands:

- `deploy/scripts/bluegreen.sh deploy`
- `deploy/scripts/bluegreen.sh status`
- `deploy/scripts/bluegreen.sh smoke`
- `deploy/scripts/bluegreen.sh rollback`

Deployment configuration can be provided through `deploy/.env.bluegreen` using the keys shown in `deploy/.env.bluegreen.example`.

Useful deploy env vars:

- `KEEP_OLD_STACK=1` keeps the previous color running after a successful cutover.
- `SMOKE_TIMEOUT=90` controls how long the script waits for proxied smoke checks.
- `PROXY_SCHEME=https` is useful when the proxy is fronted by TLS and `PUBLIC_BASE_URL` points at the public hostname.

## CI

- `npm run test:build` builds the shared contracts and cockpit.
- `npm run test:runtime` runs the FastAPI runtime test suite.
- `npm run test:e2e` runs the Playwright browser flow.
- `npm run test:ci` runs the same sequence used by GitHub Actions.

## Revision Workflow

- Review the changed code before closing a revision.
- Update [MEMORY.md](./MEMORY.md) and any affected documentation in the same change.
- Update existing tests and add new coverage for changed behavior.
- Run `npm run test:ci` and fix failures before commit.
- Commit, push, and redeploy with `deploy/scripts/bluegreen.sh deploy`.

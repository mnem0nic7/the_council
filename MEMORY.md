# Project Memory

## Operating Workflow

- After each product revision, review the changed code before closing the loop.
- Update `MEMORY.md` and any impacted documentation in the same revision.
- Refresh existing tests and add new coverage when behavior changes.
- Run `npm run test:ci` before commit; fix failures before shipping.
- After verification, commit, push, and redeploy with `deploy/scripts/bluegreen.sh deploy`.

## Current Product Notes

- Missions are editable workspaces with child runs. A mission owns mission-local agents and a mission-scoped workflow, while each run snapshots both for stable replay.
- Global agents and workflows are template assets only. Importing an agent into a mission creates an isolated mission-local copy.
- Only one active run is allowed per mission in v1. Structural mission edits are blocked unless there is no active run or the active run is paused.
- Engineering uses a desktop-only resizable split between the mission crew/template library and the mission agent forge. Width is persisted in browser `localStorage`.
- Command Deck uses a desktop-only resizable split between mission workspace controls and live telemetry. Width is persisted in browser `localStorage`.
- Tactical now edits the selected mission workflow through both structured node/edge controls and synchronized raw JSON.
- Command Deck telemetry payloads wrap inside their panel instead of forcing horizontal page overflow.
- Runtime startup migrations need to stay dialect-aware; PostgreSQL rejects SQLite-style `DATETIME` column additions.
- If a local Next.js build fails with a spurious `/_document` error after heavy local churn, clearing `apps/web/.next` and rebuilding restores a clean build state.

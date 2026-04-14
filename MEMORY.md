# Project Memory

## Operating Workflow

- After each product revision, review the changed code before closing the loop.
- Update `MEMORY.md` and any impacted documentation in the same revision.
- Refresh existing tests and add new coverage when behavior changes.
- Run `npm run test:ci` before commit; fix failures before shipping.
- After verification, commit, push, and redeploy with `deploy/scripts/bluegreen.sh deploy`.

## Current Product Notes

- The Engineering station uses a desktop-only resizable split between Agent Registry and Agent Forge. Width is persisted in browser `localStorage`.
- The Command Deck uses a desktop-only resizable split between mission launch controls and live telemetry. Width is persisted in browser `localStorage`.
- Command Deck telemetry payloads wrap inside their panel instead of forcing horizontal page overflow.
- If a local Next.js build fails with a spurious `/_document` error after heavy local churn, clearing `apps/web/.next` and rebuilding restores a clean build state.

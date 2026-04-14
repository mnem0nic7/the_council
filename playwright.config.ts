import { defineConfig, devices } from "@playwright/test";

const runtimePort = 8000;
const webPort = 3000;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure"
  },
  webServer: [
    {
      command:
        "rm -rf data/e2e.db data/e2e-artifacts data/e2e-workspaces && ../../.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000",
      cwd: "services/runtime",
      url: `http://127.0.0.1:${runtimePort}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120000,
      env: {
        ...process.env,
        DATABASE_URL: "sqlite:///./data/e2e.db",
        ARTIFACT_ROOT: "./data/e2e-artifacts",
        WORKSPACE_ROOT: "./data/e2e-workspaces",
        JWT_SECRET: "e2e-test-secret-with-sufficient-length-for-sha256",
        COUNCIL_OPERATOR_USERNAME: "captain",
        COUNCIL_OPERATOR_PASSWORD: "bridge123",
        WEB_ORIGIN: `http://127.0.0.1:${webPort}`
      }
    },
    {
      command: "npm run dev --workspace @the-council/web -- --hostname 127.0.0.1 --port 3000",
      cwd: ".",
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120000,
      env: {
        ...process.env,
        NEXT_PUBLIC_RUNTIME_URL: `http://127.0.0.1:${runtimePort}/api/v1`,
        NEXT_PUBLIC_WS_URL: `ws://127.0.0.1:${runtimePort}/ws`
      }
    }
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});

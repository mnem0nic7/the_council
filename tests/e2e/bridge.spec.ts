import { expect, test } from "@playwright/test";

test("captain can launch a mission and inspect replay data from the cockpit", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Bridge Authorization" })).toBeVisible();
  await page.getByTestId("login-submit").click();

  await expect(page.getByRole("heading", { name: "Bridge Online" })).toBeVisible();
  await expect(page.getByText("Operator captain")).toBeVisible();

  await page.getByLabel("Mission Prompt").fill("Run a systems check and archive the resulting brief.");
  await page.getByLabel("Route Signal").fill("analysis");
  await page.getByTestId("launch-mission").click();

  await expect(page.getByText(/Mission completed/i)).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("telemetry-mission.completed")).toBeVisible();

  await page.getByTestId("station-tactical").click();
  await expect(page.getByTestId("workflow-json-editor")).toContainText("\"bridge-assessment\"");
  await expect(page.getByText("Workflow topology")).toBeVisible();

  await page.getByTestId("station-archive").click();
  await expect(page.getByText("Mission replay, artifacts, and memory")).toBeVisible();
  await expect(page.getByTestId("replay-event-mission.completed")).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("artifact-agent-output").first()).toBeVisible();
  await expect(page.getByText("Long-Term Memory")).toBeVisible();
});

test("captain can forge a new agent from engineering and see it in the crew manifest", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Bridge Authorization" })).toBeVisible();
  await page.getByTestId("login-submit").click();

  await expect(page.getByRole("heading", { name: "Bridge Online" })).toBeVisible();
  await page.getByTestId("station-engineering").click();

  await expect(page.getByTestId("agent-editor")).toBeVisible();
  await page.getByTestId("agent-new").click();

  await page.getByTestId("agent-id").fill("science-officer");
  await page.getByTestId("agent-name").fill("Science Officer");
  await page.getByTestId("agent-role").fill("research-analyst");
  await page.getByTestId("agent-system-prompt").fill(
    "Investigate carefully, validate claims, and report crisp findings."
  );
  await page.getByTestId("agent-tool-web").click();
  await page.getByTestId("agent-tool-api").click();
  await page.getByTestId("agent-save").click();

  await expect(page.getByTestId("agent-card-science-officer")).toBeVisible();
  await expect(page.getByText("5 agents registered")).toBeVisible();

  await page.getByTestId("station-crew").click();
  await expect(page.getByText("Science Officer")).toBeVisible();
  await expect(page.getByText("research-analyst")).toBeVisible();
});

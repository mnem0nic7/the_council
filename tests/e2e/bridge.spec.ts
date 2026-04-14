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


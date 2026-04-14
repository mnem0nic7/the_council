import { expect, test, type Locator, type Page } from "@playwright/test";

async function loginAsCaptain(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Bridge Authorization" })).toBeVisible();
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: "Bridge Online" })).toBeVisible();
  await expect(page.getByText("Operator captain")).toBeVisible();
}

async function measureWidth(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error("Expected locator to have a visible bounding box");
  }
  return box.width;
}

test("captain can resize the command deck and inspect replay data from the cockpit", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1024 });
  await loginAsCaptain(page);

  const launchPanel = page.getByTestId("command-launch-panel");
  const telemetryPanel = page.getByTestId("command-telemetry-panel");
  const resizer = page.getByTestId("command-resizer");

  await expect(resizer).toBeVisible();

  const initialLaunchWidth = await measureWidth(launchPanel);
  const initialTelemetryWidth = await measureWidth(telemetryPanel);
  const resizerBox = await resizer.boundingBox();
  if (!resizerBox) {
    throw new Error("Expected command resizer to have a bounding box");
  }

  const handleX = resizerBox.x + resizerBox.width / 2;
  const handleY = resizerBox.y + resizerBox.height / 2;

  await page.mouse.move(handleX, handleY);
  await page.mouse.down();
  await page.mouse.move(handleX + 220, handleY, { steps: 16 });
  await page.mouse.up();

  await expect.poll(() => measureWidth(launchPanel)).toBeGreaterThan(initialLaunchWidth + 45);
  await expect.poll(() => measureWidth(telemetryPanel)).toBeLessThan(initialTelemetryWidth - 45);

  const widenedLaunchWidth = await measureWidth(launchPanel);

  await page.reload();
  await loginAsCaptain(page);

  await expect(resizer).toBeVisible();
  await expect.poll(() => measureWidth(launchPanel)).toBeGreaterThan(initialLaunchWidth + 45);
  const persistedLaunchWidth = await measureWidth(launchPanel);
  expect(Math.abs(persistedLaunchWidth - widenedLaunchWidth)).toBeLessThan(24);

  await resizer.dblclick();
  await expect.poll(async () => Math.abs((await measureWidth(launchPanel)) - initialLaunchWidth)).toBeLessThan(36);

  await page.getByLabel("Mission Prompt").fill("Run a systems check and archive the resulting brief.");
  await page.getByLabel("Route Signal").fill("analysis");
  await page.getByTestId("launch-mission").click();

  await expect(page.getByText(/Mission completed/i)).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("telemetry-mission.completed")).toBeVisible();

  const telemetryStream = page.getByTestId("command-telemetry-stream");
  const firstTelemetryCard = page.getByTestId("telemetry-mission.completed");
  const firstPayload = page.getByTestId("telemetry-payload").first();

  await expect
    .poll(() =>
      telemetryStream.evaluate((element) => element.scrollWidth - element.clientWidth)
    )
    .toBeLessThanOrEqual(2);
  await expect
    .poll(() =>
      firstPayload.evaluate((element) => element.scrollWidth - element.clientWidth)
    )
    .toBeLessThanOrEqual(2);

  const telemetryPanelBox = await telemetryPanel.boundingBox();
  const completedEventBox = await firstTelemetryCard.boundingBox();
  if (!telemetryPanelBox || !completedEventBox) {
    throw new Error("Expected telemetry panel and event to be visible");
  }
  expect(completedEventBox.x + completedEventBox.width).toBeLessThanOrEqual(
    telemetryPanelBox.x + telemetryPanelBox.width + 2
  );

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
  await loginAsCaptain(page);
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

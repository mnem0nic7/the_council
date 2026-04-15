import { expect, test, type Page } from "@playwright/test";

const pausedEditableWorkflow = {
  id: "mission-workflow",
  name: "Mission Workflow",
  description: "Pause, edit, resume mission workflow",
  version: 1,
  nodes: [
    {
      id: "captain-intake",
      name: "Captain Intake",
      type: "agent",
      description: "",
      position: { x: 80, y: 120 },
      config: {
        agentId: "captain",
        promptTemplate: "Mission prompt: {{mission.input.prompt}}\\nroute={{mission.input.route}}"
      }
    },
    {
      id: "holding-pattern",
      name: "Holding Pattern",
      type: "delay",
      description: "",
      position: { x: 320, y: 120 },
      config: { seconds: 4 }
    },
    {
      id: "engineering-scan",
      name: "Engineering Scan",
      type: "tool",
      description: "",
      position: { x: 560, y: 120 },
      config: {
        agentId: "engineer",
        tool: "shell",
        args: { command: "echo before" }
      }
    },
    {
      id: "mission-log",
      name: "Mission Log",
      type: "terminal",
      description: "",
      position: { x: 820, y: 120 },
      config: {
        output: {
          captain: "{{results.captain-intake.output}}",
          engineering: "{{results.engineering-scan.result.stdout}}"
        }
      }
    }
  ],
  edges: [
    { id: "e1", source: "captain-intake", target: "holding-pattern", label: "" },
    { id: "e2", source: "holding-pattern", target: "engineering-scan", label: "" },
    { id: "e3", source: "engineering-scan", target: "mission-log", label: "" }
  ]
};

async function loginAsCaptain(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Bridge Authorization" })).toBeVisible();
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: "Bridge Online" })).toBeVisible();
  await expect(page.getByText("Operator captain")).toBeVisible();
}

test("captain can create a mission workspace, crew it, edit its workflow mid-run, and inspect replay", async ({
  page
}) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1520, height: 1024 });
  await loginAsCaptain(page);

  await page.getByTestId("mission-name").fill("Nebula Sweep");
  await page.getByTestId("mission-prompt").fill("Scan the bridge and report system readiness.");
  await page.getByTestId("mission-create").click();

  await expect(page.getByRole("heading", { name: "Nebula Sweep", exact: true })).toBeVisible();

  await page.getByTestId("station-engineering").click();
  await expect(page.getByTestId("mission-agent-editor")).toBeVisible();

  await page.getByTestId("template-import-select").selectOption("captain");
  await page.getByTestId("template-import-button").click();
  await expect(page.getByTestId("mission-agent-card-captain")).toBeVisible();

  await page.getByTestId("mission-agent-card-captain").click();
  await page.getByTestId("mission-agent-name").fill("Mission Captain");
  await page.getByTestId("mission-agent-save").click();
  await expect(page.getByTestId("mission-agent-card-captain")).toContainText("Mission Captain");
  await expect(page.getByTestId("template-import-select")).toContainText("Captain");

  await page.getByTestId("template-import-select").selectOption("engineer");
  await page.getByTestId("template-import-button").click();
  await expect(page.getByTestId("mission-agent-card-engineer")).toBeVisible();

  await page.getByTestId("mission-agent-new").click();
  await page.getByTestId("mission-agent-id").fill("science-officer");
  await page.getByTestId("mission-agent-name").fill("Science Officer");
  await page.getByTestId("mission-agent-role").fill("research-analyst");
  await page.getByTestId("mission-agent-system-prompt").fill(
    "Investigate carefully, validate claims, and report crisp findings."
  );
  await page.getByTestId("mission-agent-tool-web").click();
  await page.getByTestId("mission-agent-tool-api").click();
  await page.getByTestId("mission-agent-save").click();
  await expect(page.getByTestId("mission-agent-card-science-officer")).toBeVisible();

  await page.getByTestId("station-crew").click();
  await expect(page.getByText("Science Officer")).toBeVisible();

  await page.getByTestId("station-tactical").click();
  await expect(page.getByTestId("workflow-json-editor")).toBeVisible();

  await page
    .getByTestId("workflow-json-editor")
    .fill(JSON.stringify(pausedEditableWorkflow, null, 2));
  await page.getByTestId("workflow-save").click();
  await expect(page.locator("strong", { hasText: "Captain Intake" }).first()).toBeVisible();
  await expect(page.locator("strong", { hasText: "Engineering Scan" }).first()).toBeVisible();

  await page.getByTestId("station-command").click();
  await page.getByTestId("mission-prompt").fill("Assess the bridge and keep a route log.");
  await page.getByTestId("launch-mission").click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeEnabled({ timeout: 10000 });
  await page.getByTestId("launch-mission").click();
  await expect(page.getByText("Mission already has an active run")).toBeVisible();

  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.locator("[data-testid^='run-card-']").first()).toContainText("paused", { timeout: 10000 });

  await page.getByTestId("station-tactical").click();
  const updatedWorkflow = JSON.stringify(
    {
      ...pausedEditableWorkflow,
      nodes: pausedEditableWorkflow.nodes.map((node) =>
        node.id === "engineering-scan"
          ? {
              ...node,
              config: {
                agentId: "engineer",
                tool: "shell",
                args: { command: "echo after" }
              }
            }
          : node
      )
    },
    null,
    2
  );
  await page.getByTestId("workflow-json-editor").fill(updatedWorkflow);
  await page.getByTestId("workflow-save").click();

  await page.getByTestId("station-command").click();
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByTestId("telemetry-mission.completed")).toBeVisible({ timeout: 20000 });

  await page.getByTestId("station-archive").click();
  await expect(page.getByTestId("replay-event-mission.completed")).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("artifact-shell-result")).toBeVisible();
  await expect(page.getByText("after")).toBeVisible();
});

import { expect, test } from "@playwright/test";

const summary = "Hermes loaded the checkout recovery skill, inspected current operating data, and prepared a manager recommendation with two feasible options.";
const resetStartedAt = "2026-08-10T17:00:00.000Z";
let morningPresentationReady = true;

function telemetryResponse(reset: boolean) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-10T17:00:00.000Z",
    source: {
      status: "connected",
      freshness: reset ? "empty" : "recent",
      project: "default",
      lastTelemetryAt: reset ? null : "2026-08-10T16:59:00.000Z",
      message: reset ? "No telemetry is available in this window." : "Recent Hermes activity is available.",
    },
    window: { startedAt: reset ? resetStartedAt : "2026-08-09T17:00:00.000Z", lookbackHours: 24, spanCount: reset ? 0 : 8, truncated: false },
    summary: {
      agentTurns: reset ? 0 : 1,
      sessions: reset ? 0 : 1,
      completedTurns: reset ? 0 : 1,
      completionRate: reset ? null : 100,
      modelCalls: reset ? 0 : 1,
      toolCalls: reset ? 0 : 2,
      latencyP50Ms: reset ? null : 4321,
      latencyP95Ms: reset ? null : 4321,
      tokens: { prompt: reset ? 0 : 900, completion: reset ? 0 : 180, total: reset ? 0 : 1080 },
    },
    activity: reset ? [] : [{
      ref: "trace-example",
      startedAt: "2026-08-10T16:58:55.000Z",
      durationMs: 4321,
      status: "completed",
      channel: "Telegram",
      summary,
      toolCalls: 2,
      modelCalls: 1,
      model: "example-model",
      visionModel: null,
      visionModelSource: null,
    }],
    channels: reset ? [] : [{ name: "Telegram", count: 1 }],
    tools: reset ? [] : [{ name: "skill_view", count: 1 }],
    models: reset ? [] : [{ name: "example-model", count: 1, tokens: 1080 }],
    vision: {
      analyses: 0,
      configuredModel: "nvidia/configured-vision-model",
      observedModels: [],
      modelSource: "configuration",
    },
    pipeline: [
      { id: "hermes", name: "Hermes", role: "Agent runtime", state: reset ? "unobserved" : "recent", evidence: reset ? "No turns observed" : "1 turn observed" },
      { id: "relay", name: "NeMo Relay", role: "Lifecycle capture", state: reset ? "unobserved" : "recent", evidence: reset ? "No Relay evidence" : "Relay evidence observed" },
      { id: "otlp", name: "OpenInference / OTLP", role: "Trace transport", state: reset ? "unobserved" : "recent", evidence: reset ? "No spans delivered" : "Spans delivered" },
      { id: "phoenix", name: "Phoenix", role: "Trace store", state: "connected", evidence: "Project: default" },
    ],
    privacy: {
      contentIncluded: false,
      note: "Prompts, responses, tool arguments, file paths, commands, and session identifiers are removed by the demo adapter.",
    },
  };
}

async function mockTelemetry(page: import("@playwright/test").Page) {
  morningPresentationReady = true;
  await page.route("**/api/platform-telemetry*", async (route) => {
    const reset = new URL(route.request().url()).searchParams.has("since");
    await route.fulfill({ contentType: "application/json", json: telemetryResponse(reset) });
  });
  await page.route("**/api/morning-briefing", async (route) => {
    if (route.request().method() === "DELETE") morningPresentationReady = false;
    await route.fulfill({
      contentType: "application/json",
      json: {
        connected: true,
        status: morningPresentationReady ? "ready" : "empty",
        storeId: "SEA-014",
        businessDate: "2026-08-03",
        presentation: morningPresentationReady ? {
          id: "MBR-EXAMPLE",
          publishedAt: "2026-08-10T16:58:50.000Z",
          priorities: [
            { rank: 1, title: "Verify the opening safety observations", evidence: "Two observations still require confirmation." },
            { rank: 2, title: "Cover the morning fulfillment shortage", evidence: "Two associates are scheduled where three are needed." },
            { rank: 3, title: "Review the first online-order promises", evidence: "The first pick started 15 minutes late." },
          ],
          openingTeam: [
            { reference: "SYNTH-COACH-01", displayName: "Elena Martinez", role: "Opening Coach", departments: ["Storewide"], shift: "06:00-15:00", status: "on_site" },
            { reference: "SYNTH-TL-01", displayName: "Priya Shah", role: "Front End Team Lead", departments: ["Checkout"], shift: "07:00-16:00", status: "scheduled" },
          ],
          readiness: {
            overallStatus: "attention_needed",
            areasReady: 1,
            areasChecked: 2,
            issues: [{ id: "OPEN-ISSUE-001", area: "Outdoor promotional display", severity: "medium", description: "The patio display is missing promotional price signs.", ownerRole: "Salesfloor Team Lead", targetResolutionAt: "2026-08-03T09:00:00-07:00" }],
            staffingGaps: [{ department: "Fulfillment", timeWindow: "09:00-12:00", scheduledHeadcount: 2, requiredHeadcount: 3, shortage: 1 }],
          },
        } : null,
      },
    });
  });
}

test("opens the complete agent activity summary in an accessible modal", async ({ page }) => {
  await mockTelemetry(page);

  await page.goto("/");
  const activity = page.getByRole("button", { name: `View agent activity details: ${summary}` });
  await expect(activity).toBeVisible();
  await activity.click();

  const dialog = page.getByRole("dialog", { name: "Agent activity details" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(summary);
  await expect(dialog).toContainText("Telegram");
  await expect(dialog).toContainText("example-model");

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(activity).toBeFocused();
});
test("keeps the last successful activity when a telemetry poll fails", async ({ page }) => {
  morningPresentationReady = true;
  let requests = 0;
  await page.route("**/api/platform-telemetry*", async (route) => {
    requests += 1;
    if (requests === 1) {
      await route.fulfill({ contentType: "application/json", json: telemetryResponse(false) });
      return;
    }
    await route.abort("connectionrefused");
  });
  await page.route("**/api/morning-briefing", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        connected: true,
        status: "empty",
        storeId: "SEA-014",
        businessDate: "2026-08-03",
        presentation: null,
      },
    });
  });

  await page.goto("/");
  await expect(page.getByText(summary)).toBeVisible();
  await expect.poll(() => requests, { timeout: 15_000 }).toBeGreaterThan(1);
  await expect(page.getByText(summary)).toBeVisible();
  await expect(page.getByText("The browser cannot reach the demo API")).toBeHidden();
  await expect(page.getByText("UI connection failed")).toBeHidden();
});

test("starts a reversible fresh UI view without deleting Phoenix history", async ({ page }) => {
  await mockTelemetry(page);
  await page.goto("/");

  await expect(page.getByText(summary)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Opening brief" })).toBeVisible();
  await expect(page.locator(".morning-priority-card")).toHaveCount(3);
  await expect(page.getByText("Two associates are scheduled where three are needed.")).toBeVisible();
  await page.getByRole("button", { name: "Reset activity view" }).click();
  await expect(page.getByText("Fresh demo view ready")).toBeVisible();
  await expect(page.getByText("Phoenix history was not deleted.", { exact: false })).toBeVisible();
  await expect(page.getByText(summary)).toBeHidden();
  await expect(page.getByRole("heading", { name: "Opening brief" })).toBeHidden();
  await expect(page.getByText("Run the morning briefing skill to populate this dashboard.")).toBeVisible();

  await page.reload();
  await expect(page.getByText("Fresh demo view ready")).toBeVisible();
  await page.getByRole("button", { name: "Show telemetry history" }).click();
  await expect(page.getByText(summary)).toBeVisible();
});

test("shows opening team and store readiness in focused detail dialogs", async ({ page }) => {
  await mockTelemetry(page);
  await page.goto("/");

  await page.getByRole("button", { name: "View opening team" }).click();
  const teamDialog = page.getByRole("dialog", { name: "Opening team" });
  await expect(teamDialog).toContainText("Elena Martinez");
  await expect(teamDialog).toContainText("On site");
  await page.keyboard.press("Escape");
  await expect(teamDialog).toBeHidden();

  await page.getByRole("button", { name: "View store readiness" }).click();
  const readinessDialog = page.getByRole("dialog", { name: "Store readiness" });
  await expect(readinessDialog).toContainText("1/2");
  await expect(readinessDialog).toContainText("The patio display is missing promotional price signs.");
  await expect(readinessDialog).not.toContainText("Outdoor promotional display");
  await expect(readinessDialog).toContainText("Fulfillment");
});

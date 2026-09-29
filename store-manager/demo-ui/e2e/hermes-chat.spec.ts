import { expect, test } from "@playwright/test";

const sessionId = "retail_ui_11111111-1111-4111-8111-111111111111";
const finalResponse = [
  "## Opening priorities",
  "",
  "| Priority | Status |",
  "|---|---|",
  "| OPD | Ready |",
].join("\n");

test("keeps a rich Hermes conversation in the right panel", async ({ page }) => {
  let submittedBriefings = 0;
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
  await page.route("**/api/hermes-chat*", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      const body = request.postDataJSON() as { input?: string };
      expect(body.input).toBe("Give me the morning briefing");
      submittedBriefings += 1;
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: [
          `data: ${JSON.stringify({ type: "run.started", session_id: sessionId })}`,
          `data: ${JSON.stringify({ type: "tool.started", session_id: sessionId, tool_name: "skill_view" })}`,
          `data: ${JSON.stringify({ type: "tool.completed", session_id: sessionId, tool_name: "skill_view" })}`,
          `data: ${JSON.stringify({ type: "assistant.completed", session_id: sessionId, content: finalResponse })}`,
          `data: ${JSON.stringify({ type: "done", session_id: sessionId })}`,
          "",
        ].join("\n\n"),
      });
      return;
    }

    const hasSession = new URL(request.url()).searchParams.has("session_id");
    await route.fulfill({
      contentType: "application/json",
      json: {
        enabled: true,
        connected: true,
        session_id: hasSession ? sessionId : null,
        messages: hasSession ? [
          { id: "user-history", role: "user", content: "Give me the morning briefing." },
          { id: "assistant-history", role: "assistant", content: finalResponse },
        ] : [],
      },
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Give me a morning briefing", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Chat" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "Chat" })).toBeFocused();

  await expect(page.getByRole("heading", { name: "Opening priorities" })).toBeVisible();
  expect(submittedBriefings).toBe(1);
  await expect(page.getByRole("cell", { name: "OPD" })).toBeVisible();
  await expect(page.getByText("Reading skill")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.sessionStorage.getItem("retail-store-manager.hermes-chat-session"))).toBe(sessionId);

  await page.reload();
  await page.getByRole("tab", { name: "Chat" }).click();
  await expect(page.getByRole("heading", { name: "Opening priorities" })).toBeVisible();
  await expect(page.getByText("Give me the morning briefing.")).toBeVisible();
  expect(submittedBriefings).toBe(1);
});

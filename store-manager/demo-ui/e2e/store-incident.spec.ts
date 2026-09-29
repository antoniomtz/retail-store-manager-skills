import { expect, test } from "@playwright/test";

const readyState = {
  schemaVersion: 1,
  connected: true,
  active: false,
  phase: "ready",
  deliveryTarget: null,
  telegramEnabled: false,
  deliveryId: null,
  image: {
    src: "/incident.jpg",
    alt: "Current camera view of the reported produce-area incident",
    location: "Fruit and vegetable section",
  },
};

test("streams a UI incident assessment into an accessible dialog", async ({ page }) => {
  await page.route("**/api/incident-demo", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      await route.fulfill({ contentType: "application/json", json: readyState });
      return;
    }
    await route.fulfill({ contentType: "application/json", json: readyState });
  });
  await page.route("**/api/incident-demo/stream", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: [
        `data: ${JSON.stringify({ type: "run.started" })}`,
        `data: ${JSON.stringify({ type: "tool.started", tool_name: "vision_analyze" })}`,
        `data: ${JSON.stringify({ type: "tool.completed", tool_name: "vision_analyze" })}`,
        `data: ${JSON.stringify({ type: "assistant.completed", content: "## Incident assessment\n\n- Keep the aisle closed.\n- Remove the obstruction safely." })}`,
        `data: ${JSON.stringify({ type: "done" })}`,
        "",
      ].join("\n\n"),
    });
  });

  await page.goto("/");
  // The store scene settles only after hydration, so the tabs are interactive.
  await expect(page.locator(".store-stage")).toHaveAttribute("data-scene", /ready|unavailable/, { timeout: 60_000 });
  await page.getByRole("tab", { name: "Store incident" }).click();
  await expect(page.locator(".incident-map-layer")).toHaveAttribute("data-spill", "visible");
  const scenario = page.getByRole("region", { name: "Store incident scenario" });

  await expect(scenario.getByRole("radio", { name: "UI" })).toBeChecked();
  await expect(scenario.getByRole("radio", { name: "Telegram" })).toBeDisabled();
  await scenario.getByRole("button", { name: "Trigger store incident" }).click();

  const dialog = page.getByRole("dialog", { name: "Hermes incident assessment" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Image analyzed")).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Incident assessment", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close assessment" })).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await scenario.getByRole("button", { name: "View assessment" }).click();
  await dialog.getByRole("button", { name: "Reset" }).click();
  await expect(dialog).toBeHidden();
  await expect(scenario.getByText("Incident scene ready")).toBeVisible();
});

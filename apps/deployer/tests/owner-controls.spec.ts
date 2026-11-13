import { test, expect } from "@playwright/test";

test.describe("VELTRON owner controls", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("https://**/*", route => route.abort());
    await page.goto("/owner-controls.html");
  });

  test("renders all five owner-control areas and the audit limitation", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Owner controls" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Agent management/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Safety reserve management/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Emergency payment controls/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Commitment settlement center/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Financial audit and reconciliation/ })).toBeVisible();
    await expect(page.getByText(/not a complete historical event log/i)).toBeVisible();
  });

  test("does not expose state-changing actions before owner and finalized-state checks", async ({ page }) => {
    for (const id of ["save-agent", "save-reserve", "pause", "resume", "reconcile"]) {
      await expect(page.locator("#" + id)).toBeDisabled();
    }
    await expect(page.locator("#read-status")).toContainText(/not yet verified|reading finalized state/i);
  });

  test("provides navigation to existing owner workflows", async ({ page }) => {
    await expect(page.getByRole("link", { name: "Overview / preflight" })).toHaveAttribute("href", "./index.html");
    await expect(page.getByRole("link", { name: "Payment queue" })).toHaveAttribute("href", "./payment-queue.html");
    await expect(page.getByRole("link", { name: "Commitments" })).toHaveAttribute("href", "./commitment-management.html");
    await expect(page.getByRole("link", { name: "Balance audit" })).toHaveAttribute("href", "./audit.html");
  });
});

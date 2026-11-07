import { test, expect } from "@playwright/test";

test("preflight renders without horizontal overflow", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "VELTRON Testnet Deployer" })).toBeVisible();
  await expect(page.getByLabel("Treasury contract WASM")).toBeVisible();
  await expect(page.getByLabel("Test-token contract WASM")).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
});

test("rejects an unrecognized WASM file", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Treasury contract WASM").setInputFiles({
    name: "wrong-contract.wasm",
    mimeType: "application/wasm",
    buffer: Buffer.from("not-the-verified-contract")
  });
  await expect(page.locator("#treasury-result")).toContainText("MISMATCH");
  await expect(page.locator("#overall")).toContainText("Both files must match");
  await expect(page.locator("#treasury-result")).toHaveAttribute("data-ok", "false");
  await expect(page.locator("#token-result")).toContainText("Not checked");
});
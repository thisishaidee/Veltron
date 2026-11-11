import { test, expect } from "@playwright/test";
import { resolve } from "node:path";

const rpcUrls = [
  "https://rpc.testnet.fastnear.com",
  "https://near-testnet.drpc.org",
  "https://rpc.testnet.near.org"
];

async function mockAllRpc(page, handler) {
  for (const url of rpcUrls) await page.route(url + "/**", handler);
}

test("preflight renders without horizontal overflow", async ({ page }) => {
  await mockAllRpc(page, route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ jsonrpc: "2.0", id: "veltron-network-check", result: { chain_id: "testnet" } })
  }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "VELTRON Testnet Deployer" })).toBeVisible();
  await expect(page.getByLabel("Treasury contract WASM")).toBeVisible();
  await expect(page.getByLabel("Test-token contract WASM")).toBeVisible();
  await expect(page.locator("#wallet-network")).toHaveText("Not independently verified");
  await expect(page.locator("#rpc-network")).toContainText("Testnet verified via FastNEAR");
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
});

test("does not verify an RPC endpoint that reports another chain", async ({ page }) => {
  await mockAllRpc(page, route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ jsonrpc: "2.0", id: "veltron-network-check", result: { chain_id: "mainnet" } })
  }));
  await page.goto("/");
  await expect(page.locator("#rpc-network")).toContainText("Unverified — No RPC endpoint could be verified as NEAR Testnet");
  await expect(page.locator("#wallet-network")).toHaveText("Not independently verified");
});

test("fails closed when the configured RPC cannot be reached", async ({ page }) => {
  await mockAllRpc(page, route => route.abort());
  await page.goto("/");
  await expect(page.locator("#rpc-network")).toContainText("Unverified — No RPC endpoint could be verified as NEAR Testnet");
});

test("falls back to another endpoint only after verifying Testnet", async ({ page }) => {
  await page.route("https://rpc.testnet.fastnear.com/**", route => route.abort());
  await page.route("https://near-testnet.drpc.org/**", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ jsonrpc: "2.0", id: "veltron-read-only-check", result: { chain_id: "testnet" } })
  }));
  await page.route("https://rpc.testnet.near.org/**", route => route.abort());
  await page.goto("/");
  await expect(page.locator("#rpc-network")).toContainText("Testnet verified via dRPC");
  await expect(page.locator("#wallet-network")).toHaveText("Not independently verified");
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

test("accepts both actual CI-built contract files", async ({ page }) => {
  const treasuryWasm = resolve(process.cwd(), "../../target/wasm32-unknown-unknown/release/veltron_treasury.wasm");
  const tokenWasm = resolve(process.cwd(), "../../target/wasm32-unknown-unknown/release/veltron_test_token.wasm");

  await mockAllRpc(page, route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ jsonrpc: "2.0", id: "veltron-network-check", result: { chain_id: "testnet" } })
  }));
  await page.goto("/");
  await page.getByLabel("Treasury contract WASM").setInputFiles(treasuryWasm);
  await expect(page.locator("#treasury-result")).toHaveAttribute("data-ok", "true");
  await expect(page.locator("#treasury-result")).toContainText(/^MATCH —/);
  await page.getByLabel("Test-token contract WASM").setInputFiles(tokenWasm);
  await expect(page.locator("#token-result")).toHaveAttribute("data-ok", "true");
  await expect(page.locator("#token-result")).toContainText(/^MATCH —/);
  await expect(page.locator("#overall")).toContainText("Both files match the recorded CI build");
  await expect(page.locator("#treasury-result")).toHaveAttribute("data-ok", "true");
  await expect(page.locator("#token-result")).toHaveAttribute("data-ok", "true");
});

test("deployment request remains gated until wallet connection and user Testnet confirmation", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#deploy-token-contract")).toBeDisabled();
  await expect(page.locator("#confirm-testnet-network")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#deployment-execution-status")).toContainText("Not ready");
  await expect(page.locator("#verify-deployed-code")).toBeVisible();
  await expect(page.locator("#wallet-panel")).toContainText("No initialization");
});

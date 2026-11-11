import { test, expect } from "@playwright/test";

const endpoints = ["https://rpc.testnet.near.org", "https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org"];

async function mockRpc(page, overrides = {}) {
  for (const endpoint of endpoints) {
    await page.route(endpoint + "/**", async route => {
      const request = route.request().postDataJSON();
      let result;
      if (request.method === "status") result = { chain_id: "testnet" };
      else {
        const method = request.params.method_name;
        const values = {
          get_owner: "haideedotxyz.testnet",
          get_agent_config: { agent_id: "veltron-agent.testnet", max_per_transaction: "50000000" },
          get_pause_status: true,
          ...overrides[endpoint]
        };
        const value = values[method];
        result = { result: Array.from(new TextEncoder().encode(JSON.stringify(value))) };
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: request.id, result })
      });
    });
  }
}

test("live treasury panel verifies and displays matching read-only views", async ({ page }) => {
  await mockRpc(page);
  await page.goto("/");
  await expect(page.locator("#live-owner")).toHaveText("haideedotxyz.testnet");
  await expect(page.locator("#live-agent")).toHaveText("veltron-agent.testnet");
  await expect(page.locator("#live-cap")).toContainText("50,000,000 base units");
  await expect(page.locator("#live-paused")).toHaveText("YES — treasury paused");
  await expect(page.locator("#treasury-config-status")).toContainText("VERIFIED");
});

test("withholds values when independent RPCs disagree", async ({ page }) => {
  await mockRpc(page, {
    "https://rpc.testnet.fastnear.com": { get_owner: "unexpected.testnet" }
  });
  await page.goto("/");
  await expect(page.locator("#treasury-config-status")).toContainText("disagree");
  await expect(page.locator("#live-owner")).toContainText("Unavailable");
  await expect(page.locator("#live-paused")).toContainText("Unavailable");
});

test("fails closed if the treasury is not paused", async ({ page }) => {
  await mockRpc(page, {
    "https://rpc.testnet.fastnear.com": { get_pause_status: false }
  });
  await page.goto("/");
  await expect(page.locator("#treasury-config-status")).toContainText("differs from the reviewed VELTRON safety configuration");
  await expect(page.locator("#live-owner")).toContainText("Unavailable");
});

test("refresh remains read-only and does not add wallet signing controls", async ({ page }) => {
  await mockRpc(page);
  await page.goto("/");
  await expect(page.locator("#refresh-treasury-config")).toBeEnabled();
  await expect(page.locator("#live-treasury-config")).toContainText("does not connect a wallet");
});

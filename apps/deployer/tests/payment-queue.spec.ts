import { test, expect } from "@playwright/test";

const OWNER = "haideedotxyz.testnet";
const queued = {
  id: "17", amount: "125500000", created_at_ns: "1730000000000000000",
  kind: { DiscretionaryRequest: { recipient_id: "vendor.testnet", memo: "Invoice 42" } }
};
const transfer = {
  id: "18", amount: "1000000", created_at_ns: "1730000000000000001",
  kind: { Discretionary: { recipient_id: "supplier.testnet", memo: null } }
};

async function mockRpc(page, disagree = false, legacyContract = false) {
  const handler = async (route, provider) => {
    const body = route.request().postDataJSON();
    let result;
    if (body.method === "status") {
      result = { chain_id: "testnet" };
    } else if (body.method === "block") {
      result = { header: { hash: "shared-finalized-block", height: 12345 } };
    } else if (body.method === "query" && body.params.request_type === "view_account") {
      result = {
        block_hash: body.params.block_id,
        code_hash: legacyContract ? "CF74dvxu77P84Xzh8heyCM5xUgDgmM93oRYroWiHkAgR" : "qNrDinLxStGuvUQQKj6NZDWKmj3vSccU6rnfVUrseAn"
      };
    } else if (body.method === "query") {
      const method = body.params.method_name;
      const values = {
        get_owner: OWNER,
        get_financial_position: {
          treasury_balance: provider === "fast" && disagree ? "5000000001" : "5000000000", active_commitments: "1000000000",
          safety_reserve: "200000000", pending_discretionary: "125500000",
          spendable_balance: "3674500000"
        },
        get_pause_status: false,
        get_pending_transfers: [queued, transfer]
      };
      result = { block_hash: body.params.block_id, result: Array.from(new TextEncoder().encode(JSON.stringify(values[method]))) };
    } else {
      return route.fulfill({ status: 400, json: { error: { message: "Unexpected RPC method" } } });
    }
    return route.fulfill({ json: { jsonrpc: "2.0", id: body.id, result } });
  };
  await page.route("https://rpc.testnet.near.org", route => handler(route, "public"));
  await page.route("https://rpc.testnet.fastnear.com", route => handler(route, "fast"));
}

test("shows queued requests separately from in-flight transfers and keeps owner actions locked", async ({ page }) => {
  await mockRpc(page);
  await page.goto("/payment-queue.html");
  await expect(page.locator("#read-status")).toContainText("VERIFIED");
  await expect(page.locator("#queue")).toContainText("REQUEST #17");
  await expect(page.locator("#queue")).toContainText("125.5 VTT");
  await expect(page.locator("#queue")).toContainText("vendor.testnet");
  await expect(page.locator("#transfers")).toContainText("TRANSFER #18");
  await expect(page.getByRole("button", { name: "Approve payment" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Reject request" })).toBeDisabled();
});

test("keeps payment requests visible but disables decisions on the legacy deployed contract", async ({ page }) => {
  await mockRpc(page, false, true);
  await page.goto("/payment-queue.html");
  await expect(page.locator("#read-status")).toContainText("does not expose approve_payment/reject_payment");
  await expect(page.locator("#queue")).toContainText("REQUEST #17");
  await expect(page.getByRole("button", { name: "Approve payment" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Reject request" })).toBeDisabled();
});

test("withholds queue and all owner controls when finalized block providers disagree", async ({ page }) => {
  await mockRpc(page, true);
  await page.goto("/payment-queue.html");
  await expect(page.locator("#read-status")).toContainText("disagree on treasury state at the same finalized block");
  await expect(page.locator("#queue")).toContainText("Requests withheld");
  await expect(page.getByRole("button", { name: "Refresh verified state" })).toBeEnabled();
});

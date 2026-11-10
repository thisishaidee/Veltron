import {test,expect} from "@playwright/test";

test("dedicated treasury deployer renders with the upgrade locked",async({page})=>{
  await page.route("https://rpc.testnet.near.org/**",route=>route.fulfill({
    status:200,contentType:"application/json",
    body:JSON.stringify({jsonrpc:"2.0",id:"veltron-treasury-preflight",result:{chain_id:"testnet"}})
  }));
  await page.route("https://rpc.testnet.fastnear.com/**",route=>route.fulfill({
    status:200,contentType:"application/json",
    body:JSON.stringify({jsonrpc:"2.0",id:"veltron-treasury-preflight",result:{chain_id:"testnet"}})
  }));
  await page.goto("/treasury.html");
  await expect(page.getByRole("heading",{name:"VELTRON Treasury — Testnet Deployment"})).toBeVisible();
  await expect(page.locator("#wallet-network")).toHaveText("Not independently verified");
  await expect(page.locator("#deploy-treasury")).toBeDisabled();
  await expect(page.locator("#verify-upgraded-code")).toBeDisabled();
  await expect(page.locator("#artifact-status")).toContainText("Artifact not checked");
  const dimensions=await page.evaluate(()=>({viewport:document.documentElement.clientWidth,content:document.documentElement.scrollWidth}));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
});

test("treasury deployment page explicitly excludes initialization and transfers",async({page})=>{
  await page.goto("/treasury.html");
  await expect(page.getByText("Initialization: excluded")).toBeVisible();
  await expect(page.getByText("No initialization or token movement is available on this page.")).toBeVisible();
  await expect(page.locator("#deploy-treasury")).toBeDisabled();
});

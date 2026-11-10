import { defineConfig, devices } from "@playwright/test";
import process from "node:process";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:4173", trace: "retain-on-failure" },
  webServer: {
    command: "python3 -m http.server 4173 --directory .",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI
  },
  projects: [
    { name: "iphone-chromium-emulation", use: { ...devices["iPhone 13"], browserName: "chromium" } },
    { name: "android-chromium-emulation", use: { ...devices["Pixel 7"], browserName: "chromium" } },
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"], browserName: "chromium" } },
    { name: "desktop-firefox", use: { ...devices["Desktop Firefox"], browserName: "firefox" } },
    { name: "desktop-webkit-safari-engine", use: { ...devices["Desktop Safari"], browserName: "webkit" } }
  ]
});

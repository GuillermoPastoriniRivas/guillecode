import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./tests/e2e",
  // Playwright clears its output folder. Keep native captures/restart reports
  // beside it so a UI run never deletes the underlying evidence.
  outputDir: "./test-results/playwright",
  timeout: 60000,
  use: { baseURL: "http://127.0.0.1:5188", channel: "msedge" },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 5188",
    url: "http://127.0.0.1:5188",
    reuseExistingServer: true,
  },
})

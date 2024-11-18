import { test, expect } from "@playwright/test";

test("shows that the health endpoint is working", async ({ page }) => {
  await page.goto("/health");
  await expect(page.locator("h1")).toHaveText("healthy");
});

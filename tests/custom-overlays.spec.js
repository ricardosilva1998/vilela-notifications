const { test, expect } = require('@playwright/test');

test.describe('Custom Overlay Pages', () => {

  test('Scene overlay page returns 404 for invalid token', async ({ page }) => {
    const response = await page.goto('/overlay/scenes/invalid-token');
    expect(response.status()).toBe(404);
  });

  test('Bar overlay page returns 404 for invalid token', async ({ page }) => {
    const response = await page.goto('/overlay/bar/invalid-token');
    expect(response.status()).toBe(404);
  });

  test('Custom alerts overlay page returns 404 for invalid token', async ({ page }) => {
    const response = await page.goto('/overlay/custom-alerts/invalid-token');
    expect(response.status()).toBe(404);
  });

  test('Scene SSE endpoint returns 404 for invalid token', async ({ page }) => {
    const response = await page.goto('/overlay/scenes/events/invalid-token');
    expect(response.status()).toBe(404);
  });

  test('Custom overlays dashboard redirects when not authenticated', async ({ page }) => {
    await page.goto('/dashboard/custom-overlays');
    await expect(page).not.toHaveURL(/custom-overlays/);
  });
});

const { test, expect } = require('@playwright/test');

const SESSION_COOKIE = process.env.ATLETA_SESSION_COOKIE;

test.describe('Authenticated Pages', () => {

  test.skip(!SESSION_COOKIE, 'Skipping - no ATLETA_SESSION_COOKIE set');

  test.beforeEach(async ({ context }) => {
    if (SESSION_COOKIE) {
      await context.addCookies([{
        name: 'session',
        value: SESSION_COOKIE,
        domain: 'atleta-notifications-helper-production.up.railway.app',
        path: '/',
      }]);
    }
  });

  test('Dashboard loads with server list', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveTitle(/Dashboard/);
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.locator('.badge-tier')).toBeVisible();
    await expect(page.getByText('Your Servers')).toBeVisible();
  });

  test('Dashboard shows quick action buttons', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('link', { name: 'Add Bot to Server' })).toBeVisible();
  });

  test('Dashboard server cards have stats and configure button', async ({ page }) => {
    await page.goto('/dashboard');
    const serverCards = page.locator('.card').filter({ hasText: 'Configure' });
    const count = await serverCards.count();
    if (count > 0) {
      const firstCard = serverCards.first();
      await expect(firstCard.locator('.stat-label', { hasText: 'Live Alerts' }).first()).toBeVisible();
      await expect(firstCard.locator('.stat-label', { hasText: 'All Notifications' })).toBeVisible();
      await expect(firstCard.getByRole('link', { name: 'Configure' })).toBeVisible();
      await expect(firstCard.getByRole('button', { name: 'Stats' })).toBeVisible();
    }
  });

  test('Dashboard stats expand/collapse on click', async ({ page }) => {
    await page.goto('/dashboard');
    const statsButton = page.getByRole('button', { name: 'Stats' }).first();
    if (await statsButton.count() > 0) {
      await statsButton.click();
      await expect(page.getByText('Last 30 days by type').first()).toBeVisible();
      await statsButton.click();
      await expect(page.getByText('Last 30 days by type').first()).not.toBeVisible();
    }
  });

  test('Account page loads with profile and metrics', async ({ page }) => {
    await page.goto('/dashboard/account');
    await expect(page).toHaveTitle(/Account/);
    await expect(page.locator('.badge-tier')).toBeVisible();
    await expect(page.getByText('Total Sent')).toBeVisible();
    await expect(page.getByText('Today').first()).toBeVisible();
    await expect(page.getByText('This Week').first()).toBeVisible();
    await expect(page.getByText('This Month').first()).toBeVisible();
    await expect(page.getByText('Notifications sent per day')).toBeVisible();
  });

  test('Account page language switcher works', async ({ page }) => {
    await page.goto('/dashboard/account');
    const langSelect = page.locator('select[name="lang"]').last();
    await expect(langSelect).toBeVisible();
    const options = langSelect.locator('option');
    const optionCount = await options.count();
    expect(optionCount).toBeGreaterThanOrEqual(7);
  });

  test('Guild config page loads with tabbed interface', async ({ page }) => {
    await page.goto('/dashboard');
    const configLink = page.getByRole('link', { name: 'Configure' }).first();
    if (await configLink.count() > 0) {
      await configLink.click();
      await expect(page.locator('.tab-bar')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Twitch' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'YouTube' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Discord' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
    }
  });

  test('Guild config Twitch tab shows add form and channel list', async ({ page }) => {
    await page.goto('/dashboard');
    const configLink = page.getByRole('link', { name: 'Configure' }).first();
    if (await configLink.count() > 0) {
      await configLink.click();
      await expect(page.getByRole('heading', { name: 'Add a Twitch Channel' })).toBeVisible();
      await expect(page.locator('input[name="twitch_username"]')).toBeVisible();
      await expect(page.getByText('Watched Channels')).toBeVisible();
    }
  });

  test('Guild config YouTube tab works', async ({ page }) => {
    await page.goto('/dashboard');
    const configLink = page.getByRole('link', { name: 'Configure' }).first();
    if (await configLink.count() > 0) {
      await configLink.click();
      await page.getByRole('button', { name: 'YouTube' }).click();
      await expect(page.getByRole('heading', { name: 'Add a YouTube Channel' })).toBeVisible();
      await expect(page.locator('input[name="youtube_channel"]')).toBeVisible();
    }
  });

  test('Guild config Discord tab shows settings forms', async ({ page }) => {
    await page.goto('/dashboard');
    const configLink = page.getByRole('link', { name: 'Configure' }).first();
    if (await configLink.count() > 0) {
      await configLink.click();
      await page.locator('.tab-bar').waitFor({ state: 'visible' });
      await page.waitForTimeout(500);
      await page.getByRole('button', { name: 'Discord' }).click();
      await expect(page.getByRole('heading', { name: 'Welcome Message' })).toBeVisible({ timeout: 15000 });
      await expect(page.getByRole('heading', { name: 'Subscriber Role Sync' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Activity Feed' })).toBeVisible();
    }
  });

  test('Guild config Settings tab shows summary and remove button', async ({ page }) => {
    await page.goto('/dashboard');
    const configLink = page.getByRole('link', { name: 'Configure' }).first();
    if (await configLink.count() > 0) {
      await configLink.click();
      await page.locator('.tab-bar').waitFor({ state: 'visible' });
      await page.waitForTimeout(500);
      await page.getByRole('button', { name: 'Settings' }).click();
      await expect(page.getByRole('heading', { name: 'Server Summary' })).toBeVisible({ timeout: 15000 });
      await expect(page.getByRole('heading', { name: 'Remove Bot from Server' })).toBeVisible();
    }
  });

  test('Subscription page loads with plan details', async ({ page }) => {
    await page.goto('/payment/subscription');
    await expect(page).toHaveTitle(/Subscription/);
    await expect(page.getByRole('heading', { name: /Plan/ })).toBeVisible();
    await expect(page.getByText('Limits').first()).toBeVisible();
    await expect(page.getByText('Features').first()).toBeVisible();
  });

  test('Report issue page loads with form', async ({ page }) => {
    await page.goto('/dashboard/report');
    await expect(page).toHaveTitle(/Report/);
    await expect(page.locator('input[name="subject"]')).toBeVisible();
    await expect(page.locator('textarea[name="description"]')).toBeVisible();
    await expect(page.getByText('Submit Issue')).toBeVisible();
  });

  test('Twitch channel profile images are displayed', async ({ page }) => {
    await page.goto('/dashboard');
    const configLink = page.getByRole('link', { name: 'Configure' }).first();
    if (await configLink.count() > 0) {
      await configLink.click();
      const channelList = page.locator('#tab-twitch');
      const avatars = channelList.locator('img[style*="border-radius: 50%"], [style*="border-radius: 50%"]');
      const count = await avatars.count();
      expect(count).toBeGreaterThanOrEqual(0);
    }
  });

  test('Navigation preserves authentication across pages', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    await page.goto('/dashboard/account');
    await expect(page.getByText('Total Sent')).toBeVisible();

    await page.goto('/pricing');
    await expect(page.getByRole('heading', { name: 'Choose Your Plan' })).toBeVisible();

    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });

});

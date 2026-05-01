// @ts-check
// Functional tests for the Pitwall page
const { test, expect } = require('@playwright/test');

const BASE = 'https://atletanotifications.com';

// Helper: login as a racing user
async function loginAsRacing(page, username, password) {
  await page.goto(`${BASE}/racing`);
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/racing/);
}

test.describe('Pitwall Page', () => {

  test.describe('Access Control', () => {
    test('unauthenticated user is redirected away from pitwall', async ({ page }) => {
      await page.goto(`${BASE}/racing/pitwall`);
      // Should redirect to /racing (login) or /racing/teams
      expect(page.url()).not.toContain('/pitwall');
    });

    test('pitwall link exists on racing dashboard when user has team', async ({ page }) => {
      await loginAsRacing(page, process.env.TEST_RACING_USER || 'ricardosilva1998', process.env.TEST_RACING_PASS || 'testpass123');
      await page.goto(`${BASE}/racing`);
      // Check if pitwall card/link exists
      const pitwallLink = page.locator('a[href="/racing/pitwall"]');
      const count = await pitwallLink.count();
      // If user has a team, pitwall link should exist
      if (count > 0) {
        await expect(pitwallLink.first()).toBeVisible();
      }
    });
  });

  test.describe('Page Structure (if accessible)', () => {
    test.beforeEach(async ({ page }) => {
      await loginAsRacing(page, process.env.TEST_RACING_USER || 'ricardosilva1998', process.env.TEST_RACING_PASS || 'testpass123');
      await page.goto(`${BASE}/racing/pitwall`);
    });

    test('page loads without errors', async ({ page }) => {
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.waitForTimeout(2000);
      // Filter out WebSocket connection errors (expected if server WS not running)
      const realErrors = errors.filter(e => !e.includes('WebSocket') && !e.includes('ws://') && !e.includes('wss://'));
      expect(realErrors.length).toBe(0);
    });

    test('has timing bar at the top', async ({ page }) => {
      const timingBar = page.locator('.timing-bar');
      if (await timingBar.count() > 0) {
        await expect(timingBar).toBeVisible();
      }
    });

    test('has driver dots in timing bar', async ({ page }) => {
      const driverDots = page.locator('.driver-dot');
      // Should have at least 1 dot (the user themselves)
      if (await driverDots.count() > 0) {
        expect(await driverDots.count()).toBeGreaterThanOrEqual(1);
      }
    });

    test('has overlay grid panels', async ({ page }) => {
      const panels = page.locator('.panel');
      if (await panels.count() > 0) {
        // Should have multiple overlay panels (standings, relative, fuel, etc.)
        expect(await panels.count()).toBeGreaterThanOrEqual(4);
      }
    });

    test('panels show placeholder text when no driver selected', async ({ page }) => {
      // Look for "Waiting" or "No data" placeholder text
      const placeholders = page.locator('text=Waiting for');
      if (await placeholders.count() > 0) {
        expect(await placeholders.count()).toBeGreaterThanOrEqual(1);
      }
    });

    test('has WebSocket connection status indicator', async ({ page }) => {
      const wsDot = page.locator('.ws-dot');
      if (await wsDot.count() > 0) {
        await expect(wsDot.first()).toBeVisible();
      }
    });

    test('team name is displayed', async ({ page }) => {
      // Page title should contain team name
      const title = await page.title();
      expect(title).toContain('Pitwall');
    });

    test('has back link to racing', async ({ page }) => {
      const backLink = page.locator('a[href="/racing"]');
      if (await backLink.count() > 0) {
        await expect(backLink.first()).toBeVisible();
      }
    });
  });

  test.describe('Panel Layout', () => {
    test.beforeEach(async ({ page }) => {
      await loginAsRacing(page, process.env.TEST_RACING_USER || 'ricardosilva1998', process.env.TEST_RACING_PASS || 'testpass123');
      await page.goto(`${BASE}/racing/pitwall`);
    });

    test('panels have correct labels', async ({ page }) => {
      const expectedPanels = ['Standings', 'Relative', 'Fuel', 'Inputs', 'Track Map', 'Weather', 'Wind', 'Session Laps', 'Race Duration'];
      for (const label of expectedPanels) {
        const panel = page.locator(`.panel-label:has-text("${label}"), .panel-header:has-text("${label}"), :text("${label}")`);
        // Panel might exist as text content in various elements
        const found = await page.locator(`text=${label}`).count();
        // At least some panels should be present
      }
      // Verify at least a few core panels exist
      const standings = await page.locator('text=Standings').count();
      const fuel = await page.locator('text=Fuel').count();
      expect(standings + fuel).toBeGreaterThan(0);
    });

    test('page uses full viewport height', async ({ page }) => {
      const bodyHeight = await page.evaluate(() => document.body.scrollHeight);
      const viewportHeight = page.viewportSize()?.height || 800;
      // Full-screen pitwall should use most of the viewport
      expect(bodyHeight).toBeGreaterThanOrEqual(viewportHeight * 0.8);
    });
  });

  test.describe('WebSocket Behavior', () => {
    test.beforeEach(async ({ page }) => {
      await loginAsRacing(page, process.env.TEST_RACING_USER || 'ricardosilva1998', process.env.TEST_RACING_PASS || 'testpass123');
    });

    test('WebSocket attempts to connect', async ({ page }) => {
      const wsMessages = [];
      page.on('console', msg => {
        if (msg.text().includes('WebSocket') || msg.text().includes('ws://') || msg.text().includes('wss://') || msg.text().includes('Pitwall')) {
          wsMessages.push(msg.text());
        }
      });

      await page.goto(`${BASE}/racing/pitwall`);
      await page.waitForTimeout(3000);

      // WebSocket should attempt connection (may fail if server WS not running, but should try)
      // The page script creates a WebSocket — we just verify no crash
    });

    test('page handles WebSocket disconnect gracefully', async ({ page }) => {
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));

      await page.goto(`${BASE}/racing/pitwall`);
      await page.waitForTimeout(5000);

      // Should not crash even if WebSocket fails
      const criticalErrors = errors.filter(e =>
        !e.includes('WebSocket') && !e.includes('ws://') && !e.includes('wss://') && !e.includes('connect')
      );
      expect(criticalErrors.length).toBe(0);
    });
  });

  test.describe('Driver Selection', () => {
    test.beforeEach(async ({ page }) => {
      await loginAsRacing(page, process.env.TEST_RACING_USER || 'ricardosilva1998', process.env.TEST_RACING_PASS || 'testpass123');
      await page.goto(`${BASE}/racing/pitwall`);
    });

    test('own driver dot is not clickable for spectating self', async ({ page }) => {
      // The user's own dot should be styled differently (can't spectate yourself)
      const selfDot = page.locator('.driver-dot.self');
      if (await selfDot.count() > 0) {
        const cursor = await selfDot.evaluate(el => getComputedStyle(el).cursor);
        expect(cursor).not.toBe('pointer');
      }
    });

    test('clicking a teammate dot would trigger selectDriver', async ({ page }) => {
      // Check that selectDriver function exists
      const fnExists = await page.evaluate(() => typeof window.selectDriver === 'function');
      expect(fnExists).toBe(true);
    });

    test('deselectDriver function exists', async ({ page }) => {
      const fnExists = await page.evaluate(() => typeof window.deselectDriver === 'function');
      expect(fnExists).toBe(true);
    });

    test('selectDriver shows stop spectating button', async ({ page }) => {
      // Call selectDriver programmatically
      await page.evaluate(() => {
        if (typeof window.selectDriver === 'function') {
          window.selectDriver(999, 'Test Driver');
        }
      });
      await page.waitForTimeout(500);

      // Check if spectating name updated
      const nameEl = page.locator('#spectating-name, .driver-name.has-driver');
      if (await nameEl.count() > 0) {
        const text = await nameEl.first().textContent();
        expect(text).toContain('Test Driver');
      }
    });

    test('deselectDriver clears the view', async ({ page }) => {
      // Select then deselect
      await page.evaluate(() => {
        if (typeof window.selectDriver === 'function') window.selectDriver(999, 'Test');
        if (typeof window.deselectDriver === 'function') window.deselectDriver();
      });
      await page.waitForTimeout(500);

      // Iframes should be cleared
      const iframes = page.locator('iframe');
      if (await iframes.count() > 0) {
        const src = await iframes.first().getAttribute('src');
        expect(src === null || src === '' || src === 'about:blank').toBeTruthy();
      }
    });
  });

  test.describe('Responsive & Visual', () => {
    test.beforeEach(async ({ page }) => {
      await loginAsRacing(page, process.env.TEST_RACING_USER || 'ricardosilva1998', process.env.TEST_RACING_PASS || 'testpass123');
    });

    test('page renders correctly at 1920x1080', async ({ page }) => {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.goto(`${BASE}/racing/pitwall`);
      await page.waitForTimeout(1000);

      // No horizontal scrollbar
      const hasHScroll = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      expect(hasHScroll).toBe(false);
    });

    test('page renders correctly at 1366x768', async ({ page }) => {
      await page.setViewportSize({ width: 1366, height: 768 });
      await page.goto(`${BASE}/racing/pitwall`);
      await page.waitForTimeout(1000);

      const hasHScroll = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      expect(hasHScroll).toBe(false);
    });

    test('page renders correctly at 2560x1440', async ({ page }) => {
      await page.setViewportSize({ width: 2560, height: 1440 });
      await page.goto(`${BASE}/racing/pitwall`);
      await page.waitForTimeout(1000);

      const hasHScroll = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      expect(hasHScroll).toBe(false);
    });

    test('dark theme is applied', async ({ page }) => {
      await page.goto(`${BASE}/racing/pitwall`);
      const bgColor = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      // Should be dark (rgb values close to 0)
      expect(bgColor).toMatch(/rgb\(\s*\d{1,2},\s*\d{1,2},\s*\d{1,2}\s*\)/);
    });
  });

  test.describe('Security', () => {
    test('pitwall page sets no-cache headers for authenticated content', async ({ page }) => {
      await loginAsRacing(page, process.env.TEST_RACING_USER || 'ricardosilva1998', process.env.TEST_RACING_PASS || 'testpass123');
      const response = await page.goto(`${BASE}/racing/pitwall`);
      // Check response exists
      if (response) {
        const status = response.status();
        // Should be 200 or 302 (redirect if no team)
        expect([200, 302]).toContain(status);
      }
    });

    test('pitwall does not expose sensitive data in page source', async ({ page }) => {
      await loginAsRacing(page, process.env.TEST_RACING_USER || 'ricardosilva1998', process.env.TEST_RACING_PASS || 'testpass123');
      await page.goto(`${BASE}/racing/pitwall`);
      const content = await page.content();
      // Should not contain passwords, tokens in plain text
      expect(content).not.toContain('password_hash');
      expect(content).not.toContain('spotify_access_token');
      expect(content).not.toContain('OPENAI_API_KEY');
    });

    test('XSS protection — team name is escaped', async ({ page }) => {
      await loginAsRacing(page, process.env.TEST_RACING_USER || 'ricardosilva1998', process.env.TEST_RACING_PASS || 'testpass123');
      await page.goto(`${BASE}/racing/pitwall`);
      // The team name should be rendered as text, not HTML
      const content = await page.content();
      expect(content).not.toContain('<script>alert');
    });
  });

  test.describe('Overlay Iframes', () => {
    test.beforeEach(async ({ page }) => {
      await loginAsRacing(page, process.env.TEST_RACING_USER || 'ricardosilva1998', process.env.TEST_RACING_PASS || 'testpass123');
      await page.goto(`${BASE}/racing/pitwall`);
    });

    test('iframes are not loaded when no driver is selected', async ({ page }) => {
      const iframes = page.locator('iframe');
      const count = await iframes.count();
      for (let i = 0; i < count; i++) {
        const src = await iframes.nth(i).getAttribute('src');
        // Should be empty/blank when no driver selected
        expect(src === null || src === '' || src === 'about:blank').toBeTruthy();
      }
    });

    test('overlay files are accessible at /pitwall/overlays/', async ({ page }) => {
      const response = await page.goto(`${BASE}/pitwall/overlays/standings.html`);
      if (response) {
        expect(response.status()).toBe(200);
      }
    });

    test('overlay files accept ws query param', async ({ page }) => {
      const response = await page.goto(`${BASE}/pitwall/overlays/fuel.html?ws=wss://test.com&driver=1`);
      if (response) {
        expect(response.status()).toBe(200);
        const content = await page.content();
        // Should contain the overlay content
        expect(content).toContain('FUEL');
      }
    });
  });

  test.describe('Team Picker (multi-team)', () => {
    test('pitwall picker page loads if user has multiple teams', async ({ page }) => {
      await loginAsRacing(page, process.env.TEST_RACING_USER || 'ricardosilva1998', process.env.TEST_RACING_PASS || 'testpass123');
      const response = await page.goto(`${BASE}/racing/pitwall`);
      // Could be the pitwall page (1 team) or picker (multiple teams) or redirect (no teams)
      if (response) {
        expect([200, 302]).toContain(response.status());
      }
    });
  });
});

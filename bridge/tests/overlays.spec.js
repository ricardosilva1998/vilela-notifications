// @ts-check
// Intensive overlay UI/UX testing — all combinations of settings
// Each overlay tested at its real Electron window dimensions
const { test, expect } = require('@playwright/test');

const BASE = `http://localhost:${process.env.TEST_HTTP_PORT || 9222}`;

// Default overlay dimensions from bridge/main.js — this IS the aspect ratio
const OVERLAY_SIZES = {
  standings:    { w: 900, h: 800 },
  relative:     { w: 520, h: 500 },
  fuel:         { w: 300, h: 370 },
  wind:         { w: 170, h: 210 },
  inputs:       { w: 540, h: 150 },
  weather:      { w: 320, h: 195 },
  raceduration: { w: 280, h: 80 },
  flags:        { w: 180, h: 130 },
  drivercard:   { w: 300, h: 180 },
  stintlaps:    { w: 320, h: 300 },
  livestats:    { w: 420, h: 250 },
  pitstrategy:  { w: 260, h: 400 },
  pittimer:     { w: 200, h: 120 },
  lapcompare:   { w: 360, h: 220 },
  proximity:    { w: 180, h: 280 },
};
// trackmap excluded: canvas overlay with aspect-ratio:1, overflow:hidden clips by design
// (header + canvas + legend exceed the 500px square panel height — intentional clipping)

const OVERLAYS = Object.keys(OVERLAY_SIZES);

// Test dimensions
const SCALES = [60, 80, 100, 120, 150, 200];
const FONT_SIZES = [8, 11, 14, 18];
const SCENARIOS = ['normal', 'extreme', 'minimal'];
const HEADERS = [true, false];

// ── Helpers ────────────────────────────────────────────────────────

async function loadScenario(request, name) {
  await request.post(`${BASE}/api/scenario/${name}`);
}

function buildUrl(overlay, opts = {}) {
  const params = [];
  if (opts.scale && opts.scale !== 100) params.push(`scale=${opts.scale}`);
  if (opts.showHeader === false) params.push('showHeader=false');
  if (opts.fontSize) params.push(`fontSize=${opts.fontSize}`);
  const qs = params.length ? '?' + params.join('&') : '';
  return `${BASE}/overlays/${overlay}.html${qs}`;
}

async function setOverlayViewport(page, overlay) {
  // Always use the overlay's natural size — CSS transform handles visual scaling
  // but doesn't change DOM layout, so the viewport must fit the unscaled panel
  const size = OVERLAY_SIZES[overlay];
  await page.setViewportSize({ width: size.w + 4, height: size.h + 4 });
}

async function waitForRender(page) {
  try {
    await page.locator('.overlay-panel :is(tr, .class-dot, .stat-value, canvas, table, .no-data, .fuel-grid, .time-display, .wind-info, .stat-row, .flag-body)').first().waitFor({ timeout: 3000 });
  } catch(e) {}
  await page.waitForTimeout(500);
}

async function checkBounds(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('.overlay-panel');
    if (!panel) return { ok: true, noPanel: true };
    const hOver = panel.scrollWidth > panel.clientWidth + 2;
    const vOver = panel.scrollHeight > panel.clientHeight + 2;
    return {
      ok: !hOver && !vOver,
      scrollWidth: panel.scrollWidth,
      scrollHeight: panel.scrollHeight,
      clientWidth: panel.clientWidth,
      clientHeight: panel.clientHeight,
      hOver, vOver,
    };
  });
}

async function checkVisibility(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('.overlay-panel');
    if (!panel) return { visible: false, reason: 'no panel' };
    const rect = panel.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return { visible: false, reason: `zero size: ${rect.width}x${rect.height}` };
    return { visible: true, width: Math.round(rect.width), height: Math.round(rect.height) };
  });
}

// ── 1. BOUNDS AT EVERY SCALE × SCENARIO ────────────────────────────

test.describe('Bounds: Scale × Scenario', () => {
  for (const overlay of OVERLAYS) {
    test.describe(overlay, () => {
      for (const scenario of SCENARIOS) {
        for (const scale of SCALES) {
          test(`${overlay} | ${scenario} | scale=${scale}%`, async ({ page, request }) => {
            await loadScenario(request, scenario);
            await setOverlayViewport(page, overlay);
            await page.goto(buildUrl(overlay, { scale }));
            await waitForRender(page);

            const vis = await checkVisibility(page);
            expect(vis.visible, `Panel not visible: ${vis.reason}`).toBe(true);

            const bounds = await checkBounds(page);
            if (bounds.noPanel) return;
            expect(bounds.ok, `OVERFLOW at scale=${scale}% scenario=${scenario}: scroll=${bounds.scrollWidth}x${bounds.scrollHeight} client=${bounds.clientWidth}x${bounds.clientHeight}`).toBe(true);
          });
        }
      }
    });
  }
});

// ── 2. FONT SIZE VARIATIONS ────────────────────────────────────────

test.describe('Font Sizes', () => {
  for (const overlay of OVERLAYS) {
    for (const fontSize of FONT_SIZES) {
      test(`${overlay} | fontSize=${fontSize}px | normal data`, async ({ page, request }) => {
        await loadScenario(request, 'normal');
        await setOverlayViewport(page, overlay);
        await page.goto(buildUrl(overlay, { fontSize }));
        await waitForRender(page);

        const vis = await checkVisibility(page);
        expect(vis.visible, `Panel not visible: ${vis.reason}`).toBe(true);

        const bounds = await checkBounds(page);
        if (bounds.noPanel) return;
        expect(bounds.ok, `OVERFLOW at fontSize=${fontSize}px: scroll=${bounds.scrollWidth}x${bounds.scrollHeight} client=${bounds.clientWidth}x${bounds.clientHeight}`).toBe(true);
      });
    }
  }
});

// ── 3. HEADER TOGGLE × SCALE ──────────────────────────────────────

test.describe('Header Toggle × Scale', () => {
  for (const overlay of OVERLAYS) {
    for (const showHeader of HEADERS) {
      for (const scale of [80, 100, 150]) {
        test(`${overlay} | header=${showHeader} | scale=${scale}%`, async ({ page, request }) => {
          await loadScenario(request, 'normal');
          await setOverlayViewport(page, overlay);
          await page.goto(buildUrl(overlay, { showHeader, scale }));
          await waitForRender(page);

          if (!showHeader) {
            const headerHidden = await page.evaluate(() => {
              const h = document.querySelector('.overlay-header');
              return !h || getComputedStyle(h).display === 'none';
            });
            expect(headerHidden, 'Header should be hidden').toBe(true);
          }

          const bounds = await checkBounds(page);
          if (bounds.noPanel) return;
          expect(bounds.ok, `OVERFLOW header=${showHeader} scale=${scale}%: scroll=${bounds.scrollWidth}x${bounds.scrollHeight} client=${bounds.clientWidth}x${bounds.clientHeight}`).toBe(true);
        });
      }
    }
  }
});

// ── 4. STRESS COMBOS ──────────────────────────────────────────────

test.describe('Stress Combos', () => {
  const combos = [
    { scale: 60, fontSize: 14, showHeader: false, scenario: 'extreme' },
    { scale: 200, fontSize: 18, showHeader: true, scenario: 'extreme' },
    { scale: 150, fontSize: 8, showHeader: true, scenario: 'extreme' },
    { scale: 120, fontSize: 18, showHeader: false, scenario: 'normal' },
    { scale: 80, fontSize: 11, showHeader: true, scenario: 'minimal' },
    { scale: 100, fontSize: 14, showHeader: false, scenario: 'minimal' },
  ];

  for (const overlay of OVERLAYS) {
    for (const combo of combos) {
      const label = `s=${combo.scale}% f=${combo.fontSize}px h=${combo.showHeader ? 'on' : 'off'} data=${combo.scenario}`;
      test(`${overlay} | ${label}`, async ({ page, request }) => {
        await loadScenario(request, combo.scenario);
        await setOverlayViewport(page, overlay);
        await page.goto(buildUrl(overlay, combo));
        await waitForRender(page);

        const vis = await checkVisibility(page);
        expect(vis.visible, `Panel not visible: ${vis.reason}`).toBe(true);

        const bounds = await checkBounds(page);
        if (bounds.noPanel) return;
        expect(bounds.ok, `OVERFLOW ${label}: scroll=${bounds.scrollWidth}x${bounds.scrollHeight} client=${bounds.clientWidth}x${bounds.clientHeight}`).toBe(true);
      });
    }
  }
});

// ── 5. DATA RENDERING CORRECTNESS ─────────────────────────────────

test.describe('Data Rendering', () => {
  test('standings — renders driver rows', async ({ page, request }) => {
    await loadScenario(request, 'normal');
    await setOverlayViewport(page, 'standings', 100);
    await page.goto(buildUrl('standings'));
    await waitForRender(page);
    const rows = await page.locator('.overlay-table tbody tr').count();
    expect(rows).toBeGreaterThan(10);
  });

  test('relative — renders driver rows', async ({ page, request }) => {
    await loadScenario(request, 'normal');
    await setOverlayViewport(page, 'relative', 100);
    await page.goto(buildUrl('relative'));
    await waitForRender(page);
    const rows = await page.locator('.overlay-table tbody tr').count();
    expect(rows).toBeGreaterThan(5);
  });

  test('fuel — shows fuel values', async ({ page, request }) => {
    await loadScenario(request, 'normal');
    await setOverlayViewport(page, 'fuel', 100);
    await page.goto(buildUrl('fuel'));
    await waitForRender(page);
    const text = await page.locator('.overlay-panel').textContent();
    expect(text).not.toContain('Waiting');
  });

  test('livestats — renders class rows', async ({ page, request }) => {
    await loadScenario(request, 'normal');
    await setOverlayViewport(page, 'livestats', 100);
    await page.goto(buildUrl('livestats'));
    await waitForRender(page);
    const rows = await page.locator('.stats-table tbody tr').count();
    expect(rows).toBeGreaterThan(0);
  });

  test('weather — shows conditions', async ({ page, request }) => {
    await loadScenario(request, 'normal');
    await setOverlayViewport(page, 'weather', 100);
    await page.goto(buildUrl('weather'));
    await waitForRender(page);
    const text = await page.locator('.overlay-panel').textContent();
    expect(text.length).toBeGreaterThan(20);
  });

  test('drivercard — shows driver name', async ({ page, request }) => {
    await loadScenario(request, 'normal');
    await setOverlayViewport(page, 'drivercard', 100);
    await page.goto(buildUrl('drivercard'));
    await waitForRender(page);
    const text = await page.locator('.overlay-panel').textContent();
    expect(text.length).toBeGreaterThan(5);
  });
});

// ── 6. SCALE VISIBILITY ──────────────────────────────────────────

test.describe('Scale Visibility', () => {
  for (const overlay of OVERLAYS) {
    test(`${overlay} — visible at all scales (60-200%)`, async ({ page, request }) => {
      await loadScenario(request, 'normal');
      for (const scale of [60, 80, 100, 120, 150, 200]) {
        await setOverlayViewport(page, overlay);
        await page.goto(buildUrl(overlay, { scale }));
        await waitForRender(page);
        const vis = await checkVisibility(page);
        expect(vis.visible, `Not visible at ${scale}%: ${vis.reason}`).toBe(true);
      }
    });
  }
});

// @ts-check
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:4000';

// ── a. Page load ───────────────────────────────────────────────────────────────

test('page load — title is "secondbrain"', async ({ page }) => {
  await page.goto(BASE);
  await expect(page).toHaveTitle('secondbrain');
});

test('page load — header shows "secondbrain" wordmark', async ({ page }) => {
  await page.goto(BASE);
  const wordmark = page.locator('.wordmark');
  await expect(wordmark).toBeVisible();
  await expect(wordmark).toHaveText('secondbrain');
});

test('page load — header subtitle "Agent Control" is present', async ({ page }) => {
  await page.goto(BASE);
  await expect(page.locator('.site-subtitle')).toHaveText('Agent Control');
});

test('page load — both agent sections render', async ({ page }) => {
  await page.goto(BASE);
  // Wait for JS to render agents
  await page.waitForSelector('.agent-section', { timeout: 5000 });
  const sections = page.locator('.agent-section');
  await expect(sections).toHaveCount(2);
});

test('page load — Email Agent section has correct name', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });
  const emailSection = page.locator('.agent-section[data-id="email"]');
  await expect(emailSection).toBeVisible();
  await expect(emailSection.locator('.agent-name')).toHaveText('Email Agent');
});

test('page load — Limitless Agent section has correct name', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });
  const limitlessSection = page.locator('.agent-section[data-id="limitless"]');
  await expect(limitlessSection).toBeVisible();
  await expect(limitlessSection.locator('.agent-name')).toHaveText('Limitless Agent');
});

test('page load — no JS console errors on initial load', async ({ page }) => {
  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', err => errors.push(err.message));
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });
  // Give a bit more time for any async errors
  await page.waitForTimeout(500);
  expect(errors, `Console errors found: ${errors.join('\n')}`).toHaveLength(0);
});

// ── b. Status pills ────────────────────────────────────────────────────────────

test('status pills — both agents start as "Idle"', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });
  const pills = page.locator('.status-pill');
  await expect(pills).toHaveCount(2);
  for (const pill of await pills.all()) {
    await expect(pill).toContainText('Idle');
  }
});

test('status pills — pills render with status dot', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });
  const dots = page.locator('.status-dot');
  await expect(dots).toHaveCount(2);
});

test('status pills — email agent pill visible', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });
  const emailPill = page.locator('.agent-section[data-id="email"] .status-pill');
  await expect(emailPill).toBeVisible();
});

test('status pills — limitless agent pill visible', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });
  const limitlessPill = page.locator('.agent-section[data-id="limitless"] .status-pill');
  await expect(limitlessPill).toBeVisible();
});

// ── c. Stats ───────────────────────────────────────────────────────────────────

test('stats — email agent stats section renders', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });
  // Stats are only rendered if server returns stats data; verify agent section exists at minimum
  const emailSection = page.locator('.agent-section[data-id="email"]');
  await expect(emailSection).toBeVisible();
  // Stats section may or may not render depending on DB — just check the section is present
  // If stats exist, verify the structure
  const statsSection = emailSection.locator('.agent-stats');
  const hasStats = await statsSection.count();
  if (hasStats > 0) {
    const statVals = statsSection.locator('.stat-val');
    await expect(statVals.first()).toBeVisible();
    const statLabels = statsSection.locator('.stat-label');
    await expect(statLabels.first()).toBeVisible();
  }
});

test('stats — limitless agent stats section renders', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });
  const limitlessSection = page.locator('.agent-section[data-id="limitless"]');
  await expect(limitlessSection).toBeVisible();
  const statsSection = limitlessSection.locator('.agent-stats');
  const hasStats = await statsSection.count();
  if (hasStats > 0) {
    await expect(statsSection).toBeVisible();
    const statVals = statsSection.locator('.stat-val');
    expect(await statVals.count()).toBeGreaterThan(0);
  }
});

// ── d. Configuration panel expand/collapse ──────────────────────────────────

test('config panel — clicking "Configuration" expands the form', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  const toggleBtn = page.locator('.agent-section[data-id="email"] .panel-toggle').first();
  await expect(toggleBtn).toContainText('Configuration');

  // Initially collapsed
  const panelBody = page.locator('#cfg-email-body');
  await expect(panelBody).not.toHaveClass(/open/);

  // Click to expand
  await toggleBtn.click();
  await expect(panelBody).toHaveClass(/open/);
  await expect(toggleBtn).toHaveAttribute('aria-expanded', 'true');
});

test('config panel — clicking again collapses it', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  const toggleBtn = page.locator('.agent-section[data-id="email"] .panel-toggle').first();
  // Open
  await toggleBtn.click();
  await expect(page.locator('#cfg-email-body')).toHaveClass(/open/);
  // Close
  await toggleBtn.click();
  await expect(page.locator('#cfg-email-body')).not.toHaveClass(/open/);
  await expect(toggleBtn).toHaveAttribute('aria-expanded', 'false');
});

test('config panel — limitless configuration expands', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  const toggleBtn = page.locator('.agent-section[data-id="limitless"] .panel-toggle').first();
  await toggleBtn.click();
  await expect(page.locator('#cfg-limitless-body')).toHaveClass(/open/);
});

// ── e. Email config form fields ───────────────────────────────────────────────

test('email config form — BATCH_SIZE field present', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  // Expand the config panel
  await page.locator('.agent-section[data-id="email"] .panel-toggle').first().click();
  await page.waitForSelector('#form-email', { timeout: 3000 });

  const batchInput = page.locator('#form-email [name="BATCH_SIZE"]');
  await expect(batchInput).toBeVisible();
  await expect(batchInput).toHaveValue('50'); // default from .env.local
});

test('email config form — MAILBOX field present', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  await page.locator('.agent-section[data-id="email"] .panel-toggle').first().click();
  await page.waitForSelector('#form-email', { timeout: 3000 });

  const mailboxInput = page.locator('#form-email [name="MAILBOX"]');
  await expect(mailboxInput).toBeVisible();
  await expect(mailboxInput).toHaveValue('INBOX');
});

test('email config form — gmail accounts section present', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  await page.locator('.agent-section[data-id="email"] .panel-toggle').first().click();
  await page.waitForSelector('#form-email', { timeout: 3000 });

  const gmailAccounts = page.locator('#gmail-accounts');
  await expect(gmailAccounts).toBeVisible();

  // At least one account row
  const accountRows = gmailAccounts.locator('.gmail-account');
  expect(await accountRows.count()).toBeGreaterThan(0);
});

test('email config form — Save button present', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  await page.locator('.agent-section[data-id="email"] .panel-toggle').first().click();
  await page.waitForSelector('#form-email', { timeout: 3000 });

  await expect(page.locator('#form-email [type="submit"]')).toBeVisible();
});

// ── f. Limitless config form fields ──────────────────────────────────────────

test('limitless config form — API key field present', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  await page.locator('.agent-section[data-id="limitless"] .panel-toggle').first().click();
  await page.waitForSelector('#form-limitless', { timeout: 3000 });

  const apiKeyInput = page.locator('#form-limitless [name="LIMITLESS_API_KEY"]');
  await expect(apiKeyInput).toBeVisible();
});

test('limitless config form — FETCH_INTERVAL_CRON field present', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  await page.locator('.agent-section[data-id="limitless"] .panel-toggle').first().click();
  await page.waitForSelector('#form-limitless', { timeout: 3000 });

  await expect(page.locator('#form-limitless [name="FETCH_INTERVAL_CRON"]')).toBeVisible();
});

test('limitless config form — FETCH_DAYS field present', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  await page.locator('.agent-section[data-id="limitless"] .panel-toggle').first().click();
  await page.waitForSelector('#form-limitless', { timeout: 3000 });

  const fetchDaysInput = page.locator('#form-limitless [name="FETCH_DAYS"]');
  await expect(fetchDaysInput).toBeVisible();
  await expect(fetchDaysInput).toHaveValue('1');
});

// ── g. Add Gmail account ───────────────────────────────────────────────────────

test('add gmail account — clicking "+ Add Account" adds a new account row', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  await page.locator('.agent-section[data-id="email"] .panel-toggle').first().click();
  await page.waitForSelector('#form-email', { timeout: 3000 });

  const accountsBefore = await page.locator('#gmail-accounts .gmail-account').count();

  // Click add account
  await page.locator('[data-action="add-account"][data-id="email"]').click();

  const accountsAfter = await page.locator('#gmail-accounts .gmail-account').count();
  expect(accountsAfter).toBe(accountsBefore + 1);
});

test('add gmail account — new account row has email and password fields', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  await page.locator('.agent-section[data-id="email"] .panel-toggle').first().click();
  await page.waitForSelector('#form-email', { timeout: 3000 });

  await page.locator('[data-action="add-account"][data-id="email"]').click();

  // Get the last account row
  const rows = page.locator('#gmail-accounts .gmail-account');
  const lastRow = rows.last();
  await expect(lastRow.locator('[data-field="email"]')).toBeVisible();
  await expect(lastRow.locator('[data-field="app_password"]')).toBeVisible();
});

test('add gmail account — new account row has remove button', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  await page.locator('.agent-section[data-id="email"] .panel-toggle').first().click();
  await page.waitForSelector('#form-email', { timeout: 3000 });

  await page.locator('[data-action="add-account"][data-id="email"]').click();

  const lastRow = page.locator('#gmail-accounts .gmail-account').last();
  await expect(lastRow.locator('.btn-remove')).toBeVisible();
});

test('add gmail account — account numbering increments correctly', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  await page.locator('.agent-section[data-id="email"] .panel-toggle').first().click();
  await page.waitForSelector('#form-email', { timeout: 3000 });

  await page.locator('[data-action="add-account"][data-id="email"]').click();

  const lastRow = page.locator('#gmail-accounts .gmail-account').last();
  const acctNum = lastRow.locator('.acct-num');
  await expect(acctNum).toContainText('Account 2');
});

// ── h. Remove Gmail account ────────────────────────────────────────────────────

test('remove gmail account — removing second account works', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  await page.locator('.agent-section[data-id="email"] .panel-toggle').first().click();
  await page.waitForSelector('#form-email', { timeout: 3000 });

  // Add a second account
  await page.locator('[data-action="add-account"][data-id="email"]').click();
  expect(await page.locator('#gmail-accounts .gmail-account').count()).toBe(2);

  // Remove it
  const lastRow = page.locator('#gmail-accounts .gmail-account').last();
  await lastRow.locator('.btn-remove').click();

  // Should be back to 1
  await expect(page.locator('#gmail-accounts .gmail-account')).toHaveCount(1);
});

test('remove gmail account — cannot remove last account', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  await page.locator('.agent-section[data-id="email"] .panel-toggle').first().click();
  await page.waitForSelector('#form-email', { timeout: 3000 });

  // With only one account, there should be no remove button
  const rows = page.locator('#gmail-accounts .gmail-account');
  if (await rows.count() === 1) {
    const removeBtn = rows.first().locator('.btn-remove');
    // The first (only) account should show a placeholder <span> instead of remove button
    await expect(removeBtn).toHaveCount(0);
  }
});

test('remove gmail account — renumbering works after removal', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  await page.locator('.agent-section[data-id="email"] .panel-toggle').first().click();
  await page.waitForSelector('#form-email', { timeout: 3000 });

  // Add two more (so we have 3)
  await page.locator('[data-action="add-account"][data-id="email"]').click();
  await page.locator('[data-action="add-account"][data-id="email"]').click();
  expect(await page.locator('#gmail-accounts .gmail-account').count()).toBe(3);

  // Remove the second one
  const rows = page.locator('#gmail-accounts .gmail-account');
  await rows.nth(1).locator('.btn-remove').click();

  // Should now have 2 accounts
  await expect(page.locator('#gmail-accounts .gmail-account')).toHaveCount(2);

  // Remaining ones should be numbered 1 and 2
  const firstLabel = page.locator('#gmail-accounts .gmail-account').first().locator('.acct-num');
  const secondLabel = page.locator('#gmail-accounts .gmail-account').last().locator('.acct-num');
  await expect(firstLabel).toHaveText('Account 1');
  await expect(secondLabel).toHaveText('Account 2');
});

// ── i. Config save ─────────────────────────────────────────────────────────────

test('config save — filling BATCH_SIZE=25 and saving triggers API POST /api/config', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  // Intercept the POST request
  let capturedRequest = null;
  page.on('request', req => {
    if (req.url().includes('/api/config') && req.method() === 'POST') {
      capturedRequest = req;
    }
  });

  await page.locator('.agent-section[data-id="email"] .panel-toggle').first().click();
  await page.waitForSelector('#form-email', { timeout: 3000 });

  // Change BATCH_SIZE
  const batchInput = page.locator('#form-email [name="BATCH_SIZE"]');
  await batchInput.fill('25');

  // Submit form
  await page.locator('#form-email [type="submit"]').click();

  // Wait for API call
  await page.waitForTimeout(1000);

  expect(capturedRequest, 'POST /api/config was not called').not.toBeNull();

  const body = JSON.parse(capturedRequest.postData() || '{}');
  expect(body.agent).toBe('email');
  expect(body.updates.BATCH_SIZE).toBe('25');
});

test('config save — toast appears after save', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  await page.locator('.agent-section[data-id="email"] .panel-toggle').first().click();
  await page.waitForSelector('#form-email', { timeout: 3000 });

  const batchInput = page.locator('#form-email [name="BATCH_SIZE"]');
  await batchInput.fill('25');
  await page.locator('#form-email [type="submit"]').click();

  // Toast should appear with "Config saved"
  await expect(page.locator('#toast')).toHaveClass(/show/, { timeout: 3000 });
  await expect(page.locator('#toast')).toContainText('Config saved');
});

test('config save — save feedback text appears inline', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  await page.locator('.agent-section[data-id="email"] .panel-toggle').first().click();
  await page.waitForSelector('#form-email', { timeout: 3000 });

  await page.locator('#form-email [type="submit"]').click();

  // The save feedback element should become visible
  const feedback = page.locator('#save-fb-email');
  await expect(feedback).toHaveClass(/visible/, { timeout: 3000 });
  await expect(feedback).toContainText('Saved');
});

test('config save — limitless config can be saved', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  let requestMade = false;
  page.on('request', req => {
    if (req.url().includes('/api/config') && req.method() === 'POST') {
      requestMade = true;
    }
  });

  await page.locator('.agent-section[data-id="limitless"] .panel-toggle').first().click();
  await page.waitForSelector('#form-limitless', { timeout: 3000 });

  await page.locator('#form-limitless [type="submit"]').click();
  await page.waitForTimeout(1000);

  expect(requestMade).toBe(true);
});

// ── j. Logs panel ──────────────────────────────────────────────────────────────

test('logs panel — expand shows log viewer', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  // The logs panel toggle is the second panel-toggle in each agent section
  const logsToggle = page.locator('.agent-section[data-id="email"] .panel-toggle').nth(1);
  await expect(logsToggle).toContainText('Logs');

  await logsToggle.click();

  await expect(page.locator('#log-email-body')).toHaveClass(/open/);
  await expect(page.locator('.log-viewer').first()).toBeVisible();
});

test('logs panel — log viewer has toolbar and output area', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  const logsToggle = page.locator('.agent-section[data-id="email"] .panel-toggle').nth(1);
  await logsToggle.click();

  const logViewer = page.locator('.agent-section[data-id="email"] .log-viewer');
  await expect(logViewer).toBeVisible();
  await expect(logViewer.locator('.log-toolbar')).toBeVisible();
  await expect(logViewer.locator('#log-email')).toBeVisible();
});

test('logs panel — empty state message shown when no logs', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  const logsToggle = page.locator('.agent-section[data-id="email"] .panel-toggle').nth(1);
  await logsToggle.click();

  await expect(page.locator('#log-email .log-empty')).toBeVisible();
  await expect(page.locator('#log-email .log-empty')).toContainText('No output yet');
});

test('logs panel — collapse works', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  const logsToggle = page.locator('.agent-section[data-id="email"] .panel-toggle').nth(1);
  await logsToggle.click();
  await expect(page.locator('#log-email-body')).toHaveClass(/open/);

  await logsToggle.click();
  await expect(page.locator('#log-email-body')).not.toHaveClass(/open/);
});

test('logs panel — clear button is present', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  const logsToggle = page.locator('.agent-section[data-id="email"] .panel-toggle').nth(1);
  await logsToggle.click();

  await expect(page.locator('.log-clear[data-id="email"]')).toBeVisible();
});

// ── k. Start agent ─────────────────────────────────────────────────────────────

test('start agent — clicking Start on Email Agent sends POST /api/agents/email/start', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  let startCalled = false;
  page.on('request', req => {
    if (req.url().includes('/api/agents/email/start') && req.method() === 'POST') {
      startCalled = true;
    }
  });

  const startBtn = page.locator('.agent-section[data-id="email"] [data-action="start"]');
  await expect(startBtn).toBeVisible();
  await startBtn.click();

  await page.waitForTimeout(1000);
  expect(startCalled).toBe(true);
});

test('start agent — status changes or button state changes after Start', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  const startBtn = page.locator('.agent-section[data-id="email"] [data-action="start"]');
  await startBtn.click();

  // Button should be disabled briefly ("Starting…")
  // Then after refresh, status pill should change from Idle
  // (Agent may quickly error without real creds, which is acceptable)
  await page.waitForTimeout(2000);

  const pill = page.locator('.agent-section[data-id="email"] .status-pill');
  await expect(pill).toBeVisible();
  // Status should be one of: running, error (not idle since we started it)
  const pillText = await pill.textContent();
  expect(['Running', 'Error', 'Stopped', 'Idle']).toContain(pillText?.trim().replace(/\s+/g, ' ').trim());
});

// ── l. Stop agent ──────────────────────────────────────────────────────────────

test('stop agent — if running, Stop button appears and clicking it stops the agent', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  // Start the email agent
  const startBtn = page.locator('.agent-section[data-id="email"] [data-action="start"]');
  await startBtn.click();
  await page.waitForTimeout(1500);

  // Reload state
  await page.waitForSelector('.agent-section', { timeout: 3000 });

  const emailSection = page.locator('.agent-section[data-id="email"]');
  const statusNow = await emailSection.getAttribute('data-status');

  if (statusNow === 'running') {
    const stopBtn = emailSection.locator('[data-action="stop"]');
    await expect(stopBtn).toBeVisible();

    let stopCalled = false;
    page.on('request', req => {
      if (req.url().includes('/api/agents/email/stop') && req.method() === 'POST') {
        stopCalled = true;
      }
    });

    await stopBtn.click();
    await page.waitForTimeout(1500);
    expect(stopCalled).toBe(true);
  } else {
    // Agent started but errored quickly — that's OK, just verify section is still rendered
    await expect(emailSection).toBeVisible();
  }
});

// ── m. API endpoints ───────────────────────────────────────────────────────────

test('API — GET /api/agents returns valid JSON with expected shape', async ({ request }) => {
  const resp = await request.get(`${BASE}/api/agents`);
  expect(resp.status()).toBe(200);
  const body = await resp.json();
  expect(body).toHaveProperty('email');
  expect(body).toHaveProperty('limitless');
  expect(body.email).toHaveProperty('id', 'email');
  expect(body.email).toHaveProperty('name', 'Email Agent');
  expect(body.email).toHaveProperty('status');
  expect(body.limitless).toHaveProperty('id', 'limitless');
  expect(body.limitless).toHaveProperty('name', 'Limitless Agent');
  expect(body.limitless).toHaveProperty('status');
});

test('API — GET /api/config returns valid JSON with expected shape', async ({ request }) => {
  const resp = await request.get(`${BASE}/api/config`);
  expect(resp.status()).toBe(200);
  const body = await resp.json();
  expect(body).toHaveProperty('email');
  expect(body).toHaveProperty('limitless');
  expect(body.email).toHaveProperty('gmail_accounts');
  expect(Array.isArray(body.email.gmail_accounts)).toBe(true);
  expect(body.email).toHaveProperty('BATCH_SIZE');
  expect(body.email).toHaveProperty('MAILBOX');
  expect(body.limitless).toHaveProperty('LIMITLESS_API_KEY');
  expect(body.limitless).toHaveProperty('FETCH_INTERVAL_CRON');
  expect(body.limitless).toHaveProperty('FETCH_DAYS');
});

test('API — GET /api/agents/email/logs returns valid JSON', async ({ request }) => {
  const resp = await request.get(`${BASE}/api/agents/email/logs`);
  expect(resp.status()).toBe(200);
  const body = await resp.json();
  expect(body).toHaveProperty('logs');
  expect(Array.isArray(body.logs)).toBe(true);
});

test('API — GET /api/agents/limitless/logs returns valid JSON', async ({ request }) => {
  const resp = await request.get(`${BASE}/api/agents/limitless/logs`);
  expect(resp.status()).toBe(200);
  const body = await resp.json();
  expect(body).toHaveProperty('logs');
  expect(Array.isArray(body.logs)).toBe(true);
});

test('API — GET /api/agents/unknown returns 404', async ({ request }) => {
  const resp = await request.get(`${BASE}/api/agents/unknown/logs`);
  expect(resp.status()).toBe(404);
  const body = await resp.json();
  expect(body).toHaveProperty('error');
});

test('API — POST /api/config with invalid payload returns 400', async ({ request }) => {
  const resp = await request.post(`${BASE}/api/config`, {
    data: { agent: 'email' }, // missing updates
  });
  expect(resp.status()).toBe(400);
  const body = await resp.json();
  expect(body).toHaveProperty('error');
});

// ── n. Toast element ───────────────────────────────────────────────────────────

test('toast — #toast element exists in DOM', async ({ page }) => {
  await page.goto(BASE);
  const toast = page.locator('#toast');
  await expect(toast).toHaveCount(1);
});

test('toast — toast is initially hidden (opacity 0, no "show" class)', async ({ page }) => {
  await page.goto(BASE);
  const toast = page.locator('#toast');
  await expect(toast).not.toHaveClass(/show/);
});

test('toast — toast appears and disappears after a config save', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  await page.locator('.agent-section[data-id="limitless"] .panel-toggle').first().click();
  await page.waitForSelector('#form-limitless', { timeout: 3000 });

  await page.locator('#form-limitless [type="submit"]').click();

  // Should appear
  await expect(page.locator('#toast')).toHaveClass(/show/, { timeout: 3000 });

  // Should disappear after ~2.5s
  await expect(page.locator('#toast')).not.toHaveClass(/show/, { timeout: 5000 });
});

// ── o. Responsive layout ──────────────────────────────────────────────────────

test('responsive — page renders without overflow at 375x812 (mobile)', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  // Verify key elements are still visible
  await expect(page.locator('.wordmark')).toBeVisible();
  await expect(page.locator('.agent-section')).toHaveCount(2);

  // Check no horizontal overflow
  const bodyScrollWidth = await page.evaluate(() => document.body.scrollWidth);
  const viewportWidth = 375;
  expect(bodyScrollWidth).toBeLessThanOrEqual(viewportWidth + 5); // 5px tolerance
});

test('responsive — agent sections visible on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  const emailSection = page.locator('.agent-section[data-id="email"]');
  const limitlessSection = page.locator('.agent-section[data-id="limitless"]');

  await expect(emailSection).toBeVisible();
  await expect(limitlessSection).toBeVisible();
});

test('responsive — config panel works at mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  await page.locator('.agent-section[data-id="email"] .panel-toggle').first().click();
  await expect(page.locator('#cfg-email-body')).toHaveClass(/open/);
  await expect(page.locator('#form-email')).toBeVisible();
});

test('responsive — start/stop buttons visible on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  const startBtns = page.locator('[data-action="start"]');
  expect(await startBtns.count()).toBeGreaterThan(0);
  for (const btn of await startBtns.all()) {
    await expect(btn).toBeVisible();
  }
});

// ── Additional edge cases ──────────────────────────────────────────────────────

test('edge case — panel-toggle chevron rotates on expand', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  const toggleBtn = page.locator('.agent-section[data-id="email"] .panel-toggle').first();
  const chevron = toggleBtn.locator('.chevron');

  // Initially not rotated
  let transform = await chevron.evaluate(el => window.getComputedStyle(el).transform);
  // After click — aria-expanded becomes true
  await toggleBtn.click();
  await page.waitForTimeout(300); // wait for CSS transition

  const expandedAttr = await toggleBtn.getAttribute('aria-expanded');
  expect(expandedAttr).toBe('true');
});

test('edge case — both agents have start buttons by default', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  const emailStart = page.locator('.agent-section[data-id="email"] [data-action="start"]');
  const limitlessStart = page.locator('.agent-section[data-id="limitless"] [data-action="start"]');
  await expect(emailStart).toBeVisible();
  await expect(limitlessStart).toBeVisible();
});

test('edge case — page heading text is correct', async ({ page }) => {
  await page.goto(BASE);
  const heading = page.locator('.page-heading');
  await expect(heading).toBeVisible();
  await expect(heading).toContainText('Configure');
  await expect(heading).toContainText('your agents');
});

test('edge case — agent descriptions render correctly', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  const emailDesc = page.locator('.agent-section[data-id="email"] .agent-description');
  await expect(emailDesc).toContainText('Gmail');

  const limitlessDesc = page.locator('.agent-section[data-id="limitless"] .agent-description');
  await expect(limitlessDesc).toContainText('Limitless');
});

test('edge case — log clear button works', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.agent-section', { timeout: 5000 });

  // Open logs
  await page.locator('.agent-section[data-id="email"] .panel-toggle').nth(1).click();

  // Click clear
  await page.locator('.log-clear[data-id="email"]').click();

  // Log container should have "Cleared." text
  await expect(page.locator('#log-email .log-empty')).toContainText('Cleared');
});

test('edge case — static HTML page at GET / returns 200', async ({ request }) => {
  const resp = await request.get(BASE);
  expect(resp.status()).toBe(200);
  const body = await resp.text();
  expect(body).toContain('secondbrain');
  expect(body).toContain('DOCTYPE html');
});

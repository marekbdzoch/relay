import fs from 'node:fs';
import { expect, request, test as setup } from '@playwright/test';
import { AUTH_DIR, BOB, DANA, OWNER, WORKSPACE, type TestUser } from './support/users';
import { api, channelHeader, waitForClient } from './support/app';

setup.describe.configure({ mode: 'serial' });

setup('first-run setup creates the workspace and the owner, lands in #general', async ({ page }) => {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const status = await (await page.request.get('/api/setup/status')).json();

  if (status.needsSetup) {
    await page.goto('/');
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.getByRole('heading', { name: 'Set up your workspace' })).toBeVisible();

    await page.getByPlaceholder('e.g. Acme Inc.').fill(WORKSPACE);
    await page.getByPlaceholder('Full name').fill(OWNER.fullName);
    await page.getByPlaceholder('name@work-email.com').fill(OWNER.email);
    await page.getByPlaceholder('Password (min. 8 characters)').fill(OWNER.password);
    await page.getByRole('button', { name: 'Create workspace' }).click();

    // the first-run setup guide opens for the new owner; the suites set things up themselves, so skip it
    const guide = page.getByRole('dialog', { name: `Set up ${WORKSPACE}` });
    await expect(guide.getByRole('heading', { name: /Welcome to Relay/ })).toBeVisible();
    await guide.getByRole('button', { name: 'Skip setup' }).click();
    await expect(guide).toBeHidden();
  } else {
    // a retry after a later step failed: the workspace exists already, just sign in
    const res = await page.request.post('/api/auth/login', { data: { email: OWNER.email, password: OWNER.password } });
    expect(res.ok()).toBeTruthy();
    await page.goto('/');
  }

  await waitForClient(page);
  await expect(page).toHaveURL(/\/c\/C[A-Z0-9]+$/);
  await expect(channelHeader(page)).toHaveText('general');
  await expect(page.locator('.left-col .ws-name')).toContainText(WORKSPACE);
  // #general and #random are created with the workspace
  await expect(page.locator('.sidebar-pane .sb-name').getByText('general', { exact: true })).toBeVisible();
  await expect(page.locator('.sidebar-pane .sb-name').getByText('random', { exact: true })).toBeVisible();

  await page.context().storageState({ path: OWNER.state });
});

setup('create the shared test accounts', async ({ page, baseURL }) => {
  await page.context().addCookies(JSON.parse(fs.readFileSync(OWNER.state, 'utf8')).cookies);
  for (const user of [BOB, DANA] satisfies TestUser[]) {
    const ctx = await request.newContext({ baseURL });
    const { code } = await api.invite(page);
    let res = await ctx.post('/api/auth/signup', { data: { inviteCode: code, fullName: user.fullName, email: user.email, password: user.password, timezone: 'Europe/Prague' } });
    if (res.status() === 409) res = await ctx.post('/api/auth/login', { data: { email: user.email, password: user.password } });
    expect(res.ok(), await res.text()).toBeTruthy();
    expect((await res.json()).me.username).toBe(user.username);
    await ctx.storageState({ path: user.state });
    await ctx.dispose();
  }
});

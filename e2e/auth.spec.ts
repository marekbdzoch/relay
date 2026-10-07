import { expect, test } from '@playwright/test';
import { OWNER, WORKSPACE } from './support/users';
import { channelHeader, menuItem, waitForClient } from './support/app';

// start signed out; this test creates (and destroys) its own sessions so the shared owner session stays valid
test.use({ storageState: { cookies: [], origins: [] } });

test('sign in, sign out via the user menu, wrong password error', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: `Sign in to ${WORKSPACE}` })).toBeVisible();

  // wrong password
  await page.getByPlaceholder('name@work-email.com').fill(OWNER.email);
  await page.getByPlaceholder('Password').fill('definitely-wrong');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Wrong email or password.')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);

  // correct password (username works as well as email)
  await page.getByPlaceholder('name@work-email.com').fill(OWNER.username);
  await page.getByPlaceholder('Password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await waitForClient(page);
  await expect(channelHeader(page)).toBeVisible();

  // sign out from the footer profile menu
  await page.getByRole('button', { name: 'Your profile' }).click();
  await menuItem(page, 'Sign out').click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

  // the session is really gone
  const res = await page.request.get('/api/bootstrap');
  expect(res.status()).toBe(401);

  // and signing in again works
  await page.getByPlaceholder('name@work-email.com').fill(OWNER.email);
  await page.getByPlaceholder('Password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await waitForClient(page);
  await expect(channelHeader(page)).toBeVisible();
  await page.getByRole('button', { name: 'Your profile' }).click();
  await menuItem(page, 'Sign out').click();
  await expect(page).toHaveURL(/\/login$/);
});

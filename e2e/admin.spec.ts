import { expect, test } from '@playwright/test';
import { BOB, DANA, OWNER, WORKSPACE } from './support/users';
import { api, dialog, menuItem, uid, waitForClient } from './support/app';

test.afterEach(async ({ page }) => {
  // other tests rely on the original workspace name
  await api.workspace(page, { name: WORKSPACE });
});

test('workspace settings: rename the workspace, members tab lists users', async ({ page }) => {
  const newName = `Renamed ${uid('ws')}`;
  await page.goto('/');
  await waitForClient(page);

  const header = page.locator('.left-col .ws-name');
  await expect(header).toContainText(WORKSPACE);
  await header.click();
  await menuItem(page, 'Workspace settings').click();

  const settings = dialog(page, 'Workspace settings');
  const nameInput = settings.locator('label', { hasText: 'Workspace name' }).locator('input');
  await expect(nameInput).toHaveValue(WORKSPACE);
  await nameInput.fill(newName);
  await settings.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();

  // header, search box and workspace icon letter update live
  await expect(header).toContainText(newName);
  await expect(page.getByRole('button', { name: `Search ${newName}` })).toBeVisible();

  // members tab
  await settings.getByRole('button', { name: 'Members' }).click();
  const table = settings.locator('table');
  for (const u of [OWNER, BOB, DANA]) {
    const row = table.locator('tr').filter({ hasText: u.email });
    await expect(row).toBeVisible();
    await expect(row).toContainText(u.fullName);
  }
  await expect(table.locator('tr').filter({ hasText: OWNER.email }).locator('select')).toHaveValue('owner');
  await expect(table.locator('tr').filter({ hasText: BOB.email }).locator('select')).toHaveValue('member');
  await settings.getByPlaceholder('Search members').fill('bob');
  await expect(table.locator('tbody tr')).toHaveCount(1);

  await settings.getByRole('button', { name: 'Close' }).click();
  await expect(settings).toHaveCount(0);

  // the new name is persisted
  await page.reload();
  await expect(page.locator('.left-col .ws-name')).toContainText(newName);
});

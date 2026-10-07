import { expect, test } from '@playwright/test';
import { BOB } from './support/users';
import { channelHeader, dialog, menuItem, message, openSection, openAs, send, sidebarItem, sidebarSection, uid, waitForClient } from './support/app';

test('start a DM from the New message dialog, see it in the DMs list, close it', async ({ page, browser }, testInfo) => {
  const text = `direct hello ${uid()}`;
  await page.goto('/');
  await waitForClient(page);

  await page.getByRole('button', { name: 'New message', exact: true }).first().click();
  const modal = dialog(page, 'New message');
  await modal.getByPlaceholder('@somebody or somebody@example.com').fill('bob');
  await modal.locator('.up-option').filter({ hasText: BOB.fullName }).click();
  await expect(modal.locator('.up-chip')).toContainText(BOB.fullName);
  await modal.getByRole('button', { name: 'Go' }).click();

  await expect(modal).toHaveCount(0);
  await expect(page).toHaveURL(/\/c\/D[A-Z0-9]+$/);
  await expect(channelHeader(page)).toHaveText(BOB.fullName);
  await expect(page.locator('.channel-view .composer-wrap textarea')).toHaveAttribute('placeholder', `Message ${BOB.fullName}`);
  await send(page, text);
  await expect(message(page, text)).toBeVisible();
  await expect(sidebarSection(page, 'Direct messages').locator('.sb-name').getByText(BOB.fullName, { exact: true })).toBeVisible();

  // Bob receives it with an unread badge and sees it in his DMs list
  const bob = await openAs(browser, BOB, testInfo);
  await bob.page.goto('/dms');
  const bobRow = bob.page.locator('.dm-row').filter({ hasText: 'Alice Owner' });
  await expect(bobRow.locator('.dm-row-preview')).toHaveText(text);
  await expect(bobRow.locator('.dm-row-badge')).toHaveText('1');
  await bob.context.close();

  // the DMs view lists the conversation with a preview of the last message
  await openSection(page, 'DMs');
  await expect(page).toHaveURL(/\/dms$/);
  const row = page.locator('.dm-row').filter({ hasText: BOB.fullName });
  await expect(row.locator('.dm-row-preview')).toHaveText(`You: ${text}`);
  await row.click();
  await expect(page).toHaveURL(/\/dms\/D[A-Z0-9]+$/);
  await expect(channelHeader(page)).toHaveText(BOB.fullName);
  await expect(message(page, text)).toBeVisible();

  // close the conversation from the sidebar (while looking at another channel)
  await openSection(page, 'Home');
  await sidebarItem(page, 'general').click();
  await expect(channelHeader(page)).toHaveText('general');
  const dmItem = sidebarItem(page, BOB.fullName);
  await dmItem.click({ button: 'right' });
  await menuItem(page, 'Close conversation').click();
  await expect(dmItem).toHaveCount(0);

  // it's hidden in the DMs list too, but the history is kept when reopened
  await openSection(page, 'DMs');
  await expect(page.locator('.dm-row').filter({ hasText: BOB.fullName })).toHaveCount(0);
  await page.getByRole('button', { name: 'New message', exact: true }).first().click();
  await dialog(page, 'New message').getByPlaceholder('@somebody or somebody@example.com').fill('bob');
  await dialog(page, 'New message').locator('.up-option').filter({ hasText: BOB.fullName }).click();
  await dialog(page, 'New message').getByRole('button', { name: 'Go' }).click();
  await expect(channelHeader(page)).toHaveText(BOB.fullName);
  await expect(message(page, text)).toBeVisible();
});

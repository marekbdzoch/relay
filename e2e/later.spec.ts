import { expect, test } from '@playwright/test';
import { api, gotoChannel, menuItem, message, messageAction, openSection, uid } from './support/app';

test('save for later, mark complete, and set a reminder', async ({ page }) => {
  const ch = await api.createChannel(page, uid('later'));
  const saveText = `save this ${uid()}`;
  const remindText = `remind me about this ${uid()}`;
  await api.post(page, ch.id, saveText);
  await api.post(page, ch.id, remindText);
  await gotoChannel(page, ch.id, ch.name);

  // save a message
  const saved = message(page, saveText);
  await messageAction(saved, 'Save for later');
  await expect(saved.locator('.label-saved')).toHaveText('Saved for later');
  await expect(page.getByText('Saved for later', { exact: true }).last()).toBeVisible();

  // it's in Later → In progress
  await openSection(page, 'Later');
  await expect(page).toHaveURL(/\/later$/);
  const tabs = page.locator('.pane-tabs');
  await expect(tabs.getByRole('button', { name: /In progress/ })).toHaveClass(/\bactive\b/);
  const row = page.locator('.later-row').filter({ hasText: saveText });
  await expect(row).toBeVisible();
  await expect(row.locator('.later-top')).toContainText(`#${ch.name}`);

  // mark complete → moves to the Completed tab
  await row.hover();
  await row.getByRole('button', { name: 'Mark complete' }).click();
  await expect(row).toHaveCount(0);
  await tabs.getByRole('button', { name: 'Completed' }).click();
  await expect(page.locator('.later-row').filter({ hasText: saveText })).toBeVisible();

  // remind me about another message in 20 minutes
  await gotoChannel(page, ch.id, ch.name);
  const remind = message(page, remindText);
  await messageAction(remind, 'More actions');
  await menuItem(page, 'Remind me').hover();
  await menuItem(page, 'In 20 minutes').click();
  await expect(page.getByText(/^I’ll remind you /)).toBeVisible();
  await expect(remind.locator('.label-saved')).toBeVisible();

  await openSection(page, 'Later');
  const reminderRow = page.locator('.later-row').filter({ hasText: remindText });
  await expect(reminderRow).toBeVisible();
  await expect(reminderRow.locator('.later-due')).toHaveText(/^\s*Due /);
  await expect(reminderRow.locator('.later-due')).not.toHaveClass(/overdue/);

  // clicking the row opens the message in context
  await reminderRow.click();
  await expect(page).toHaveURL(new RegExp(`/later/${ch.id}/\\d+$`));
  await expect(message(page, remindText)).toBeVisible();
});

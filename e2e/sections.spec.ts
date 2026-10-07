import { expect, test } from '@playwright/test';
import { api, dialog, gotoChannel, menuItem, openSectionOptions, sidebarItem, sidebarSection, uid } from './support/app';

test('create a sidebar section and move a channel into it', async ({ page }) => {
  const ch = await api.createChannel(page, uid('sect'));
  const sectionName = uid('team').toUpperCase(); // sections are shown upper-case
  await gotoChannel(page, ch.id, ch.name);

  const channels = sidebarSection(page, /^Channels$/);
  await expect(channels.locator('.sb-item').filter({ hasText: ch.name })).toBeVisible();

  // Channels ⋮ → Create a new section
  await openSectionOptions(channels);
  await menuItem(page, 'Create a new section').click();
  const modal = dialog(page, 'Create a section');
  await modal.getByRole('button', { name: '🚀' }).click();
  await modal.getByPlaceholder('e.g. Clients').fill(sectionName.toLowerCase());
  await modal.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(modal).toHaveCount(0);

  const section = sidebarSection(page, sectionName);
  await expect(section).toBeVisible();
  await expect(section.locator('.sb-section-toggle')).toContainText('🚀');
  await expect(section.getByText('Right-click a channel → Move to add it here')).toBeVisible();

  // right-click → Move channel → the new section
  await sidebarItem(page, ch.name).click({ button: 'right' });
  await menuItem(page, 'Move channel').hover();
  await menuItem(page, new RegExp(sectionName)).click();

  await expect(section.locator('.sb-item').filter({ hasText: ch.name })).toBeVisible();
  await expect(channels.locator('.sb-item').filter({ hasText: ch.name })).toHaveCount(0);
  await expect(section.getByText('Right-click a channel → Move to add it here')).toHaveCount(0);

  // survives a reload (stored in the user's preferences)
  await page.reload();
  await expect(sidebarSection(page, sectionName).locator('.sb-item').filter({ hasText: ch.name })).toBeVisible();

  // collapse hides the (read) channel, expand shows it again
  await section.locator('.sb-section-toggle').click();
  await sidebarItem(page, 'general').click();
  await expect(section.locator('.sb-item').filter({ hasText: ch.name })).toHaveCount(0);
  await section.locator('.sb-section-toggle').click();
  await expect(section.locator('.sb-item').filter({ hasText: ch.name })).toBeVisible();

  // deleting the section puts the channel back under Channels
  await openSectionOptions(section);
  await menuItem(page, 'Delete section').click();
  await expect(sidebarSection(page, sectionName)).toHaveCount(0);
  await expect(channels.locator('.sb-item').filter({ hasText: ch.name })).toBeVisible();
});

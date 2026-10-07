import { expect, test, type Page } from '@playwright/test';
import { BOB, OWNER } from './support/users';
import { api, channelHeader, message, sidebarItem, uid } from './support/app';

// iPhone 12/13/14-sized viewport (Chromium mobile emulation)
test.use({ storageState: BOB.state, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const tabbar = (page: Page) => page.locator('nav.tabbar');
const backButton = (page: Page) => page.locator('.channel-header').getByRole('button', { name: 'Back' });

test.describe('mobile layout', () => {
  test('DM list → conversation → back button returns to the list', async ({ page }) => {
    const aliceId = await api.userId(page, OWNER.username);
    const dm = await (await page.request.post('/api/dms', { data: { userIds: [aliceId] } })).json();
    const text = `mobile hello ${uid()}`;
    await api.post(page, dm.channel.id, text);

    await page.goto('/dms');
    const row = page.locator('.dm-row').filter({ hasText: OWNER.fullName });
    await expect(row).toBeVisible();
    await expect(tabbar(page)).toBeVisible();
    await expect(page.locator('.main-col')).toBeHidden(); // list only

    await row.tap();
    await expect(page).toHaveURL(new RegExp(`/dms/${dm.channel.id}$`));
    await expect(channelHeader(page)).toHaveText(OWNER.fullName);
    await expect(message(page, text)).toBeVisible();
    await expect(page.locator('.left-col')).toBeHidden(); // conversation only
    await expect(backButton(page)).toBeVisible();

    await backButton(page).tap();
    await expect(page).toHaveURL(/\/dms$/);
    await expect(row).toBeVisible();
    await expect(page.locator('.main-col')).toBeHidden();
  });

  test('channel list is visible, open a channel, back button returns to the list', async ({ page }) => {
    await page.goto('/dms');
    await expect(tabbar(page)).toBeVisible();
    await tabbar(page).getByRole('button', { name: 'Home' }).tap();
    const general = sidebarItem(page, 'general');
    await expect(general).toBeVisible({ timeout: 5_000 });

    await general.tap();
    await expect(channelHeader(page)).toHaveText('general');
    await expect(page.locator('.left-col')).toBeHidden();

    await backButton(page).tap();
    await expect(general).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.main-col')).toBeHidden();
  });
});

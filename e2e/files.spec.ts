import { expect, test } from '@playwright/test';
import { PNG_8x8, api, gotoChannel, message, openSection, uid } from './support/app';

test('upload an image from the composer, see it in the channel and in Files', async ({ page }) => {
  const ch = await api.createChannel(page, uid('files'));
  const fileName = `${uid('pixel')}.png`;
  await gotoChannel(page, ch.id, ch.name);

  const composerWrap = page.locator('.channel-view .composer-wrap');
  await composerWrap.locator('input[type=file]').setInputFiles({ name: fileName, mimeType: 'image/png', buffer: PNG_8x8 });

  // preview while uploading, then the send button becomes active
  await expect(composerWrap.locator('.cf-item.image img')).toBeVisible();
  await expect(composerWrap.locator('.cf-progress')).toHaveCount(0);
  const sendBtn = composerWrap.getByRole('button', { name: 'Send now' });
  await expect(sendBtn).toBeEnabled();
  await composerWrap.locator('textarea').fill(`here is a picture ${fileName}`);
  await sendBtn.click();
  await expect(composerWrap.locator('.cf-item')).toHaveCount(0);

  // the image renders in the message
  const msg = message(page, `here is a picture ${fileName}`);
  await expect(msg.locator('.file-collapse-head')).toContainText(fileName);
  await expect(msg.getByRole('img', { name: fileName })).toBeVisible();
  await expect.poll(() => msg.getByRole('img', { name: fileName }).evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(8);

  // channel "Files & links" tab
  await page.locator('.ch-tabs').getByRole('button', { name: 'Files & links' }).click();
  await expect(page.locator('.files-grid').getByRole('img', { name: fileName })).toBeVisible();

  // Files view lists it
  await openSection(page, 'Files');
  await expect(page).toHaveURL(/\/files/);
  const row = page.locator('.file-row').filter({ hasText: fileName });
  await expect(row).toBeVisible();
  await expect(row).toContainText(`#${ch.name}`);
  await page.locator('.files-nav').getByRole('button', { name: 'Images' }).click();
  await expect(row).toBeVisible();
  await page.locator('.files-nav').getByRole('button', { name: 'PDFs' }).click();
  await expect(row).toHaveCount(0);
});

import { expect, test } from '@playwright/test';
import { WORKSPACE } from './support/users';
import { api, channelHeader, gotoChannel, message, uid } from './support/app';

test('search finds a message by a unique word and narrows results with in:#channel', async ({ page }) => {
  const word = `quokka${Date.now().toString(36)}`;
  const a = await api.createChannel(page, uid('srch-a'));
  const b = await api.createChannel(page, uid('srch-b'));
  await api.post(page, a.id, `the ${word} lives in channel a`);
  await api.post(page, b.id, `another ${word} sighting in channel b`);

  await gotoChannel(page, b.id, b.name);

  // top bar search
  await page.getByRole('button', { name: `Search ${WORKSPACE}` }).click();
  const box = page.getByPlaceholder('Search for messages, files, people, channels…');
  await expect(box).toBeFocused();
  await box.fill(word);
  await box.press('Enter');

  await expect(page).toHaveURL(new RegExp(`/search\\?q=${word}$`));
  await expect(page.getByRole('heading', { name: `Results for “${word}”` })).toBeVisible();
  const results = page.locator('.search-result');
  await expect(page.locator('.search-count')).toHaveText('2 results');
  await expect(results.filter({ hasText: 'lives in channel a' }).locator('.draft-where')).toHaveText(`#${a.name}`);
  await expect(results.filter({ hasText: 'sighting in channel b' }).locator('.draft-where')).toHaveText(`#${b.name}`);

  // in:#channel filter
  await page.getByRole('button', { name: `Search ${WORKSPACE}` }).click();
  await box.fill(`${word} in:#${a.name}`);
  await box.press('Enter');
  await expect(page.getByRole('heading', { name: `Results for “${word} in:#${a.name}”` })).toBeVisible();
  await expect(page.locator('.search-count')).toHaveText('1 result');
  await expect(results).toHaveCount(1);
  await expect(results.first()).toContainText('lives in channel a');

  // a result opens the message in its channel
  await results.first().click();
  await expect(page).toHaveURL(new RegExp(`/c/${a.id}/\\d+`));
  await expect(channelHeader(page)).toHaveText(a.name);
  await expect(message(page, 'lives in channel a')).toBeVisible();

  // "Search in conversation" pre-fills the channel filter
  await page.locator('.channel-header').getByTitle('Search in conversation').click();
  await expect(box).toHaveValue(`in:#${a.name} `);
  await box.press('End');
  await box.pressSequentially('nothingmatchesthis');
  await box.press('Enter');
  await expect(page.getByRole('heading', { name: 'No results' })).toBeVisible();
});

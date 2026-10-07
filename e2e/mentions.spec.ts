import { expect, test } from '@playwright/test';
import { BOB, OWNER } from './support/users';
import { api, channelHeader, gotoChannel, message, openAs, sectionButton, send, uid, waitForClient } from './support/app';

test('a mention shows up in Activity with a badge and opens the message', async ({ page, browser }, testInfo) => {
  const bob = await openAs(browser, BOB, testInfo);
  const bobId = await api.userId(page, BOB.username);
  const ch = await api.createChannel(page, uid('mention'), { memberIds: [bobId] });

  // start from a clean activity feed
  await page.request.put('/api/activity/read', { data: { all: true } });
  await page.goto('/browse/channels');
  await waitForClient(page);
  await expect((await sectionButton(page, 'Activity')).locator('.badge')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Bob mentions Alice
  await gotoChannel(bob.page, ch.id, ch.name);
  const word = uid('ping');
  await send(bob.page, `hey @${OWNER.username} could you look at ${word} please`);
  const sent = message(bob.page, word);
  await expect(sent.locator('.msg-text')).toContainText(`@${OWNER.fullName}`);

  // Alice gets a badge on the Activity icon of the section switcher
  const activityItem = sectionButton(page, 'Activity');
  await expect(activityItem.locator('.badge')).toHaveText('1');

  // ...and the mention in the Activity list
  await activityItem.click();
  await expect(sectionButton(page, 'Activity').locator('.badge')).toHaveText('1');
  await expect(page).toHaveURL(/\/activity$/);
  const row = page.locator('.activity-card').filter({ hasText: word });
  await expect(row).toBeVisible();
  await expect(row.locator('.activity-actor')).toHaveText(BOB.fullName);
  await expect(row.locator('.activity-label')).toHaveText(`Mention in #${ch.name}`);
  await expect(row).toHaveClass(/\bunread\b/);

  // Mentions filter keeps it
  await page.locator('.pane-tabs').getByRole('button', { name: 'Mentions' }).click();
  await expect(row).toBeVisible();

  // clicking opens the message in context and marks the item read
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/activity/${ch.id}/\\d+$`));
  await expect(channelHeader(page)).toHaveText(ch.name);
  const msg = message(page, word);
  await expect(msg).toBeVisible();
  await expect(msg).toHaveClass(/\bmentioned\b/);
  await expect(row).not.toHaveClass(/\bunread\b/);
  await expect(sectionButton(page, 'Activity').locator('.badge')).toHaveCount(0);

  await bob.context.close();
});

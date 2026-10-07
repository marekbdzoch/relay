import { expect, test } from '@playwright/test';
import { OWNER, WORKSPACE } from './support/users';
import { api, channelHeader, composer, dialog, gotoChannel, message, send, sidebarItem, uid, waitForClient } from './support/app';

test('invite link signup, real-time messages, typing indicator and unread badges', async ({ page, browser }, testInfo) => {
  const suffix = uid('c').slice(2);
  const carol = { fullName: `Carol ${suffix}`, email: `carol-${suffix}@example.com`, password: 'carol-secret-123' };

  // owner creates an invite link from the footer "+" menu
  await page.goto('/');
  await waitForClient(page);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('button', { name: 'Invite people' }).click();
  const invite = dialog(page, `Invite people to ${WORKSPACE}`);
  await invite.getByRole('button', { name: 'Create invite link' }).click();
  const linkInput = invite.locator('input[readonly]');
  await expect(linkInput).toHaveValue(/\/invite\/[A-Za-z0-9_-]+$/);
  const inviteUrl = new URL(await linkInput.inputValue());
  await invite.getByRole('button', { name: 'Close' }).click();

  // a second person signs up through the link in a separate browser
  // (browser.newContext() inherits the project's owner storageState, so start explicitly signed out)
  const ctx = await browser.newContext({ baseURL: testInfo.project.use.baseURL, locale: 'en-US', storageState: { cookies: [], origins: [] } });
  const p2 = await ctx.newPage();
  await p2.goto(inviteUrl.pathname);
  await expect(p2.getByRole('heading', { name: `Join ${WORKSPACE}` })).toBeVisible();
  await p2.getByPlaceholder('Full name').fill(carol.fullName);
  await p2.getByPlaceholder('name@work-email.com').fill(carol.email);
  await p2.getByPlaceholder('Password (min. 8 characters)').fill(carol.password);
  await p2.getByRole('button', { name: 'Create account' }).click();
  await waitForClient(p2);
  await expect(channelHeader(p2)).toHaveText('general');

  // a fresh channel with both of them
  const carolId = (await (await p2.request.get('/api/bootstrap')).json()).me.id as string;
  const ch = await api.createChannel(page, uid('rt'), { memberIds: [carolId] });
  await gotoChannel(page, ch.id, ch.name);
  await gotoChannel(p2, ch.id, ch.name);

  // real-time in both directions
  const hello = `hello from alice ${uid()}`;
  await send(page, hello);
  await expect(message(p2, hello)).toBeVisible();
  await expect(message(p2, hello).locator('.msg-author')).toHaveText(OWNER.fullName);

  // typing indicator while Carol writes her reply, cleared once the reply arrives
  const reply = `hi alice, carol here ${uid()}`;
  await composer(p2).fill(reply);
  const typing = page.locator('.channel-view .typing');
  await expect(typing).toHaveText(`${carol.fullName} is typing…`);
  await composer(p2).press('Enter');
  await expect(message(page, reply)).toBeVisible();
  await expect(typing).toHaveText('');

  // unread state: Alice moves away, Carol writes in the channel and sends a DM
  await sidebarItem(page, 'general').click();
  await expect(channelHeader(page)).toHaveText('general');
  const unreadText = `are you there? ${uid()}`;
  await send(p2, unreadText);
  await expect(sidebarItem(page, ch.name)).toHaveClass(/\bunread\b/);

  const aliceId = await api.userId(page, OWNER.username);
  const dm = await (await p2.request.post('/api/dms', { data: { userIds: [aliceId] } })).json();
  await p2.request.post(`/api/channels/${dm.channel.id}/messages`, { data: { text: `psst ${uid()}` } });
  await expect(sidebarItem(page, carol.fullName).locator('.badge')).toHaveText('1');
  await expect(page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'DMs', exact: true }).locator('.badge')).toBeVisible();

  // opening the channel (in the focused window) clears its unread state
  await page.bringToFront();
  await sidebarItem(page, ch.name).click();
  await expect(message(page, unreadText)).toBeVisible();
  await expect(sidebarItem(page, ch.name)).not.toHaveClass(/\bunread\b/);

  await ctx.close();
});

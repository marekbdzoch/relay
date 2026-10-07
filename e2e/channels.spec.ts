import { expect, test, type Page } from '@playwright/test';
import { BOB } from './support/users';
import { api, channelHeader, dialog, gotoChannel, menuItem, openAs, sidebarItem, uid, waitForClient } from './support/app';

async function pickUser(page: Page, modal: ReturnType<typeof dialog>, name: string) {
  await modal.getByPlaceholder('Type the name of a person').fill(name.split(' ')[0]);
  await modal.locator('.up-option').filter({ hasText: name }).click();
  await expect(modal.locator('.up-chip').filter({ hasText: name })).toBeVisible();
}

function browseRow(page: Page, name: string) {
  return page.locator('.browse-row').filter({ has: page.locator('.browse-name').getByText(name, { exact: true }) });
}

test.describe('channels', () => {
  test('create a public channel, set its topic, add a member who then sees it, leave and archive', async ({ page, browser }, testInfo) => {
    const name = uid('pub');
    const topic = `Topic ${uid()}`;
    const bob = await openAs(browser, BOB, testInfo);
    await bob.page.goto('/');
    await waitForClient(bob.page);

    // sidebar "Add channels" -> channel browser -> "Create channel"
    await page.goto('/');
    await waitForClient(page);
    await page.locator('.sidebar-pane').getByRole('button', { name: 'Add channels' }).click();
    await expect(page).toHaveURL(/\/browse\/channels$/);
    await page.getByRole('button', { name: 'Create channel' }).click();
    const create = dialog(page, 'Create a channel');
    await create.getByPlaceholder('e.g. plan-budget').fill(name);
    await create.getByPlaceholder('What is this channel about?').fill('Created by the e2e suite');
    await create.getByRole('button', { name: 'Create', exact: true }).click();

    // second step: add people
    const add = dialog(page, `Add people to #${name}`);
    await expect(add).toBeVisible();
    await pickUser(page, add, BOB.fullName);
    await add.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(add).toHaveCount(0);
    await expect(channelHeader(page)).toHaveText(name);
    await expect(sidebarItem(page, name)).toHaveClass(/\bactive\b/);

    // Bob sees the new channel (after a reload: see the real-time test below, which documents a bug)
    await bob.page.reload();
    await expect(sidebarItem(bob.page, name)).toBeVisible();

    // set the topic in channel details
    await page.locator('.channel-header .ch-title').click();
    const details = page.getByRole('dialog').filter({ has: page.locator('.cd-title') });
    await expect(details.locator('.cd-title')).toHaveText(name);
    const topicBlock = details.locator('.detail-block').filter({ has: page.locator('b', { hasText: /^Topic$/ }) });
    await topicBlock.getByRole('button', { name: 'Edit' }).click();
    await topicBlock.locator('textarea').fill(topic);
    await topicBlock.getByRole('button', { name: 'Save' }).click();
    await expect(topicBlock).toContainText(topic);
    await details.getByRole('button', { name: 'Members' }).click();
    await expect(details.locator('.cd-member-name').filter({ hasText: BOB.fullName })).toBeVisible();
    await details.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('.channel-header .ch-topic')).toHaveText(topic);

    // Bob sees the topic too, then leaves via the sidebar context menu
    await sidebarItem(bob.page, name).click();
    await expect(bob.page.locator('.channel-header .ch-topic')).toHaveText(topic);
    await sidebarItem(bob.page, name).click({ button: 'right' });
    await menuItem(bob.page, 'Leave channel').click();
    await expect(sidebarItem(bob.page, name)).toHaveCount(0);
    await bob.page.goto('/browse/channels');
    await expect(browseRow(bob.page, name)).toBeVisible();
    await expect(browseRow(bob.page, name)).not.toContainText('Joined');
    await browseRow(bob.page, name).hover(); // row actions only show on hover
    await expect(browseRow(bob.page, name).getByRole('button', { name: 'Join' })).toBeVisible();

    // owner archives the channel from its settings
    await page.locator('.channel-header .ch-title').click();
    await details.getByRole('button', { name: 'Settings' }).click();
    await details.getByRole('button', { name: 'Archive channel' }).click();
    const confirm = dialog(page, `Archive #${name}?`);
    await confirm.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(page.locator('.channel-footer-note')).toContainText(`You are viewing #${name}, an archived channel.`);
    await expect(page.locator('.channel-view .composer-wrap')).toHaveCount(0);

    // archived channels move out of the sidebar and into the "Archived channels" browser filter
    await page.locator('.sidebar-pane').getByRole('button', { name: 'Add channels' }).click();
    await expect(sidebarItem(page, name)).toHaveCount(0);
    await expect(browseRow(page, name)).toHaveCount(0);
    await page.getByLabel('Archived channels').check();
    await expect(browseRow(page, name)).toBeVisible();

    await bob.context.close();
  });

  test('a private channel is invisible to non-members until they are added', async ({ page, browser }, testInfo) => {
    const name = uid('priv');
    const bob = await openAs(browser, BOB, testInfo);

    await page.goto('/');
    await waitForClient(page);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.locator('.create-menu').getByRole('button', { name: /^Channel\b/ }).click();
    const create = dialog(page, 'Create a channel');
    await create.getByPlaceholder('e.g. plan-budget').fill(name);
    await create.getByText('Make private').click();
    await expect(create.getByText('Only invited people can see a private channel.')).toBeVisible();
    await create.getByRole('button', { name: 'Create', exact: true }).click();
    await dialog(page, `Add people to #${name}`).getByRole('button', { name: 'Skip for now' }).click();
    await expect(channelHeader(page)).toHaveText(name);
    await expect(sidebarItem(page, name).locator('.sb-icon svg')).toBeVisible();

    // Bob can't find it
    await bob.page.goto('/browse/channels');
    await expect(bob.page.locator('.browse-count')).toBeVisible();
    await bob.page.getByPlaceholder('Search for channels').fill(name);
    await expect(bob.page.locator('.browse-count')).toHaveText('0 results');
    await expect(sidebarItem(bob.page, name)).toHaveCount(0);

    // owner adds Bob from the members tab
    await page.locator('.channel-header .ch-title').click();
    const details = page.getByRole('dialog').filter({ has: page.locator('.cd-title') });
    await details.getByRole('button', { name: 'Members' }).click();
    await details.getByRole('button', { name: 'Add people' }).click();
    const add = dialog(page, `Add people to #${name}`);
    await pickUser(page, add, BOB.fullName);
    await add.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByText('1 person added')).toBeVisible();

    // now Bob sees it in the browser and in the sidebar
    await expect(browseRow(bob.page, name)).toBeVisible();
    await expect(browseRow(bob.page, name)).toContainText('Joined');
    await bob.page.goto('/');
    await expect(sidebarItem(bob.page, name)).toBeVisible();
    await sidebarItem(bob.page, name).click();
    await expect(channelHeader(bob.page)).toHaveText(name);
    await expect(bob.page.locator('.channel-view .msg.system').filter({ hasText: `was added to #${name} by` })).toBeVisible();

    await bob.context.close();
  });

  test('a member added to a new public channel sees it in the sidebar without reloading', async ({ page, browser }, testInfo) => {
    const bob = await openAs(browser, BOB, testInfo);
    await bob.page.goto('/');
    await waitForClient(bob.page);
    const bobId = (await (await bob.page.request.get('/api/bootstrap')).json()).me.id as string;

    const ch = await api.createChannel(page, uid('live'));
    await api.addMembers(page, ch.id, [bobId]);
    await expect(sidebarItem(bob.page, ch.name)).toBeVisible({ timeout: 5_000 });
    await bob.context.close();
  });
});

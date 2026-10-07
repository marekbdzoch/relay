import { expect, test, type Page } from '@playwright/test';
import { api, composer, dialog, gotoChannel, menuItem, message, messageAction, send, uid } from './support/app';

async function freshChannel(page: Page, prefix: string) {
  const ch = await api.createChannel(page, uid(prefix));
  await gotoChannel(page, ch.id, ch.name);
  return ch;
}

test.describe('messaging', () => {
  test('formatted message renders bold, italic, code and a link', async ({ page }) => {
    await freshChannel(page, 'fmt');
    const word = uid('w');
    await send(page, `*bold ${word}* and _italic text_ with \`inline code\` see https://example.com/docs?id=1 ok`);
    const msg = message(page, word);
    await expect(msg).toBeVisible();
    const text = msg.locator('.msg-text');
    await expect(text.locator('b')).toHaveText(`bold ${word}`);
    await expect(text.locator('i')).toHaveText('italic text');
    await expect(text.locator('code')).toHaveText('inline code');
    const link = text.getByRole('link', { name: 'https://example.com/docs?id=1' });
    await expect(link).toHaveAttribute('href', 'https://example.com/docs?id=1');
    await expect(link).toHaveAttribute('target', '_blank');
    // the raw markup characters are gone
    await expect(text).not.toContainText('*bold');
    await expect(text).not.toContainText('`');
  });

  test('edit the last message with ArrowUp in an empty composer', async ({ page }) => {
    await freshChannel(page, 'edit');
    const original = `original ${uid()}`;
    const edited = `edited ${uid()}`;
    await send(page, original);
    await expect(message(page, original)).toBeVisible();
    // ArrowUp only picks messages the server has confirmed (pending ones have a temporary id)
    await expect(message(page, original)).not.toHaveClass(/\bpending\b/);

    await composer(page).press('ArrowUp');
    const editBox = page.locator('.channel-view .msg.editing .edit-box textarea');
    await expect(editBox).toBeFocused();
    await expect(editBox).toHaveValue(original);
    await editBox.fill(edited);
    await editBox.press('Enter');

    const msg = message(page, edited);
    await expect(msg).toBeVisible();
    await expect(msg.locator('.edited')).toHaveText('(edited)');
    await expect(message(page, original)).toHaveCount(0);
  });

  test('delete a message from the hover menu after confirming', async ({ page }) => {
    await freshChannel(page, 'del');
    const keep = `keep me ${uid()}`;
    const doomed = `delete me ${uid()}`;
    await send(page, keep);
    await send(page, doomed);
    const msg = message(page, doomed);
    await expect(msg).toBeVisible();

    await messageAction(msg, 'More actions');
    await menuItem(page, /Delete message/).click();
    const confirm = dialog(page, 'Delete message');
    await expect(confirm).toContainText('Are you sure you want to delete this message?');
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click();

    await expect(confirm).toHaveCount(0);
    await expect(message(page, doomed)).toHaveCount(0);
    await expect(message(page, keep)).toBeVisible();
  });

  test('add a quick reaction and remove it again', async ({ page }) => {
    await freshChannel(page, 'react');
    const text = `react to me ${uid()}`;
    await send(page, text);
    const msg = message(page, text);

    await msg.hover();
    const quick = msg.locator('.msg-actions .tip').first();
    const code = (await quick.getByRole('tooltip', { includeHidden: true }).textContent())!.trim(); // e.g. ":white_check_mark:"
    expect(code).toMatch(/^:[a-z0-9_+-]+:$/);
    await quick.locator('button').click();

    const chip = msg.locator('.reactions .reaction:not(.reaction-add)');
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveClass(/\bmine\b/);
    await expect(chip.locator('.reaction-count')).toHaveText('1');
    await expect(chip.locator('.emoji')).toHaveAttribute('title', code);

    await chip.click();
    await expect(chip).toHaveCount(0);
  });

  test('reply in a thread, thread summary and "Also send to #channel"', async ({ page }) => {
    const ch = await freshChannel(page, 'thread');
    const root = `thread root ${uid()}`;
    await send(page, root);
    const rootMsg = message(page, root);

    await messageAction(rootMsg, 'Reply in thread');
    const panel = page.locator('.right-panel');
    await expect(panel.getByRole('heading', { name: 'Thread' })).toBeVisible();
    await expect(panel.locator('.rp-sub')).toHaveText(`#${ch.name}`);
    await expect(panel.locator('.msg').filter({ hasText: root })).toBeVisible();

    const replyBox = panel.getByPlaceholder('Reply…');
    const reply1 = `first reply ${uid()}`;
    await send(page, reply1, replyBox);
    await expect(panel.locator('.msg').filter({ hasText: reply1 })).toBeVisible();

    // the root in the channel shows the summary, the reply itself stays in the thread
    await expect(rootMsg.locator('.thread-summary .ts-count')).toHaveText('1 reply');
    await expect(message(page, reply1)).toHaveCount(0);

    // second reply, broadcast to the channel
    const reply2 = `broadcast reply ${uid()}`;
    await panel.getByLabel(`Also send to #${ch.name}`).check();
    await send(page, reply2, replyBox);
    await expect(panel.locator('.msg').filter({ hasText: reply2 })).toBeVisible();
    await expect(rootMsg.locator('.thread-summary .ts-count')).toHaveText('2 replies');
    const broadcast = message(page, reply2);
    await expect(broadcast).toBeVisible();
    await expect(broadcast.locator('.thread-broadcast')).toContainText('replied to a thread:');
    await expect(panel.getByLabel(`Also send to #${ch.name}`)).not.toBeChecked();

    // closing the panel
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect(panel).toHaveCount(0);
  });
});

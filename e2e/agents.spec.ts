import { expect, test } from '@playwright/test';
import { channelHeader, dialog, message, openSection, send, sidebarSection, uid, waitForClient } from './support/app';

test('create an agent from a template, it shows in the sidebar and answers a DM without an AI key', async ({ page }) => {
  const name = `Mia ${uid('agent').slice(6)}`;
  await page.goto('/');
  await waitForClient(page);

  await openSection(page, 'Agents');
  await expect(page).toHaveURL(/\/agents$/);
  await expect(page.getByRole('heading', { name: 'AI agents' })).toBeVisible();
  // no ANTHROPIC_API_KEY in the e2e server
  await expect(page.getByText('Connect an AI model')).toBeVisible();

  await page.locator('.agent-templates').getByRole('button', { name: /Marketing specialist/ }).click();
  const modal = dialog(page, 'New AI agent');
  await expect(modal.getByPlaceholder('e.g. Mia Marketing')).toHaveValue('Mia Marketing');
  await expect(modal.getByPlaceholder('e.g. Marketing specialist')).toHaveValue('Marketing specialist');
  await expect(modal.getByText('No AI provider connected yet – the agent will reply once an admin sets one up.')).toBeVisible();
  await modal.getByPlaceholder('e.g. Mia Marketing').fill(name);
  await modal.getByRole('button', { name: 'Create agent' }).click();

  // the new agent's DM opens
  await expect(modal).toHaveCount(0);
  await expect(page.getByText(`${name} joined the team`)).toBeVisible();
  await expect(channelHeader(page)).toHaveText(name);
  await expect(page.locator('.composer-notice')).toContainText(`${name} is an AI agent (Marketing specialist)`);

  // ...and the agent is listed in the sidebar's Agents section
  const agents = sidebarSection(page, /^Agents$/);
  const item = agents.locator('.sb-item').filter({ hasText: name });
  await expect(item).toBeVisible();
  await expect(item.locator('.sb-sub')).toHaveText(/Marketing specialist/);

  // DM it: without an API key it explains that it can't think yet
  await send(page, 'Hi! Can you draft a launch tweet?');
  const answer = message(page, /not connected to an AI model/);
  await expect(answer).toBeVisible({ timeout: 15_000 });
  await expect(answer.locator('.msg-author')).toHaveText(name);
  await expect(answer.locator('.agent-badge')).toHaveText('AGENT');

  // it's listed on the Agents page too
  await openSection(page, 'Agents');
  await expect(page.locator('.agent-row').filter({ hasText: name })).toContainText('Marketing specialist');
});

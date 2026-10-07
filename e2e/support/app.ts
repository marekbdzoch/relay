import { expect, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { TestUser } from './users';

let seq = 0;
/** Short unique suffix so tests never collide in the shared database. */
export function uid(prefix = 'e2e') {
  return `${prefix}-${Date.now().toString(36)}${(seq++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

// ---------------------------------------------------------------------------
// API helpers (they run with the cookie of the page's browser context)

async function call<T>(req: APIRequestContext, method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, data?: unknown): Promise<T> {
  const res = await req[method](url, data === undefined ? undefined : { data });
  const text = await res.text();
  if (!res.ok()) throw new Error(`${method.toUpperCase()} ${url} -> ${res.status()} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

export interface ChannelInfo {
  id: string;
  name: string;
  kind: string;
}

export const api = {
  me: (page: Page) => call<{ me: { id: string; username: string; prefs: Record<string, unknown> }; users: { id: string; username: string }[] }>(page.request, 'get', '/api/bootstrap'),
  userId: async (page: Page, username: string) => {
    const b = await api.me(page);
    const u = b.users.find((x) => x.username === username);
    if (!u) throw new Error(`user ${username} not found`);
    return u.id;
  },
  createChannel: (page: Page, name: string, o: { isPrivate?: boolean; memberIds?: string[]; description?: string } = {}) =>
    call<ChannelInfo>(page.request, 'post', '/api/channels', { name, ...o }),
  addMembers: (page: Page, channelId: string, userIds: string[]) => call(page.request, 'post', `/api/channels/${channelId}/members`, { userIds }),
  joinChannel: (page: Page, channelId: string) => call(page.request, 'post', `/api/channels/${channelId}/join`, {}),
  post: (page: Page, channelId: string, text: string, o: { threadRootId?: number } = {}) =>
    call<{ id: number }>(page.request, 'post', `/api/channels/${channelId}/messages`, { text, ...o }),
  invite: (page: Page) => call<{ code: string }>(page.request, 'post', '/api/invites', { role: 'member', maxUses: null }),
  setPrefs: (page: Page, prefs: Record<string, unknown>) => call(page.request, 'put', '/api/users/me/prefs', prefs),
  workspace: (page: Page, body: { name?: string }) => call(page.request, 'patch', '/api/workspace', body),
};

// ---------------------------------------------------------------------------
// extra signed-in browser contexts (the default `page` is the workspace owner)

export async function openAs(browser: Browser, user: TestUser, testInfo: TestInfo, viewport = { width: 1360, height: 860 }): Promise<{ context: BrowserContext; page: Page }> {
  const use = testInfo.project.use;
  const context = await browser.newContext({ baseURL: use.baseURL, locale: use.locale, timezoneId: use.timezoneId, storageState: user.state, viewport });
  const page = await context.newPage();
  return { context, page };
}

// ---------------------------------------------------------------------------
// UI helpers

/** Waits for the signed-in client shell (left column + composer or a view). */
export async function waitForClient(page: Page) {
  await expect(page.getByRole('button', { name: 'Your profile' })).toBeVisible({ timeout: 15_000 });
}

export async function gotoChannel(page: Page, channelId: string, name?: string) {
  await page.goto(`/c/${channelId}`);
  if (name) await expect(channelHeader(page)).toHaveText(name);
}

export function channelHeader(page: Page) {
  return page.locator('.channel-header .ch-name');
}

/** The main composer of the open conversation. */
export function composer(page: Page) {
  return page.locator('.channel-view .composer-wrap textarea').first();
}

export async function send(page: Page, text: string, box: Locator = composer(page)) {
  await box.click();
  await box.fill(text);
  await box.press('Enter');
  await expect(box).toHaveValue('');
}

/** A message row in the open conversation (main column). */
export function message(page: Page, text: string | RegExp) {
  return page.locator('.channel-view .message-list .msg').filter({ hasText: text });
}

/** Clicks one of the hover actions of a message (they are icon buttons with a tooltip label). */
export async function messageAction(msg: Locator, label: string) {
  await msg.hover();
  const btn = msg.locator('.msg-actions .tip').filter({ has: msg.page().getByRole('tooltip', { name: label, exact: true, includeHidden: true }) }).locator('button');
  await btn.click();
}

/** A conversation entry in the left sidebar. */
export function sidebarItem(page: Page, name: string) {
  return page.locator('.sidebar-pane .sb-item').filter({ has: page.locator('.sb-name').getByText(name, { exact: true }) });
}

/** A section (Channels, Direct messages, Agents, custom ones) of the sidebar. */
export function sidebarSection(page: Page, title: string | RegExp) {
  return page.locator('.sidebar-pane .sb-section').filter({ has: page.locator('.sb-section-toggle').filter({ hasText: title }) });
}

/** Opens the ⋮ menu of a sidebar section (the button only shows while the header is hovered). */
export async function openSectionOptions(section: Locator) {
  await section.locator('.sb-section-head').hover();
  await section.getByRole('button', { name: 'Section options' }).click();
}

export function menuItem(page: Page, name: string | RegExp) {
  return page.getByRole('menuitem', { name });
}

export function dialog(page: Page, title?: string | RegExp) {
  const d = page.getByRole('dialog');
  return title ? d.filter({ has: page.getByRole('heading', { name: title }) }) : d;
}

export type SectionName = 'Home' | 'DMs' | 'Activity' | 'Files' | 'Later' | 'Agents';

/** The section switcher at the top of the left column. */
export function sectionNav(page: Page) {
  return page.getByRole('navigation', { name: 'Sections' });
}

/** The icon button of a section in the switcher (all sections are visible by default). */
export function sectionButton(page: Page, name: SectionName) {
  return sectionNav(page).getByRole('button', { name, exact: true });
}

/** Switches the left column to a section. */
export async function openSection(page: Page, name: SectionName) {
  await sectionButton(page, name).click();
}

/** A tiny valid PNG (8x8 red square). */
export const PNG_8x8 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGO4o2GDFTEMLQkAaplQARifz48AAAAASUVORK5CYII=',
  'base64',
);

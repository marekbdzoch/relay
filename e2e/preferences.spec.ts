import { expect, test, type Page } from '@playwright/test';
import { DANA } from './support/users';
import { api, dialog, waitForClient } from './support/app';

// Dana's personal preferences get changed here, so the shared owner account stays untouched
test.use({ storageState: DANA.state });

const mode = (page: Page) => page.locator('html').getAttribute('data-mode');
const accent = (page: Page) => page.evaluate(() => document.documentElement.style.getPropertyValue('--accent'));

test.afterEach(async ({ page }) => {
  await api.setPrefs(page, { theme: null, colorMode: null, language: 'en' });
});

test('theme, dark/light mode and language preferences', async ({ page }) => {
  await page.goto('/');
  await waitForClient(page);
  await expect.poll(() => mode(page)).toBe('light');

  // footer toggle
  await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
  await expect.poll(() => mode(page)).toBe('dark');
  await page.getByRole('button', { name: 'Light mode', exact: true }).click();
  await expect.poll(() => mode(page)).toBe('light');

  // the choice is stored on the account: it survives a reload
  await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
  await expect.poll(() => mode(page)).toBe('dark');
  await page.reload();
  await waitForClient(page);
  await expect.poll(() => mode(page)).toBe('dark');
  await expect(page.getByRole('button', { name: 'Light mode', exact: true })).toBeVisible();

  // Preferences → Themes
  await page.getByRole('button', { name: 'Preferences', exact: true }).click();
  const prefs = dialog(page, 'Preferences');
  await prefs.getByRole('button', { name: 'Themes' }).click();
  await prefs.getByRole('button', { name: 'Light', exact: true }).click();
  await expect.poll(() => mode(page)).toBe('light');
  await expect(prefs.getByRole('button', { name: 'Light', exact: true })).toHaveClass(/\bactive\b/);
  const themes = prefs.locator('.theme-option');
  expect(await themes.count()).toBeGreaterThan(1);
  await expect(themes.first()).toHaveClass(/\bactive\b/); // default theme
  const defaultAccent = await accent(page);
  await themes.nth(1).click();
  await expect(themes.nth(1)).toHaveClass(/\bactive\b/);
  await expect(themes.first()).not.toHaveClass(/\bactive\b/);
  await expect.poll(() => accent(page)).not.toBe(defaultAccent);
  const pickedAccent = await accent(page);
  // dark mode keeps the theme but switches to its dark tones
  await prefs.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect.poll(() => mode(page)).toBe('dark');
  await prefs.getByRole('button', { name: 'Light', exact: true }).click();
  await expect.poll(() => mode(page)).toBe('light');
  await expect.poll(() => accent(page)).toBe(pickedAccent);

  // Language → Czech (the page reloads)
  await prefs.getByRole('button', { name: 'Language & region' }).click();
  await Promise.all([page.waitForEvent('load'), prefs.locator('select').first().selectOption('cs')]);
  await expect(page.getByRole('button', { name: 'Tvůj profil' })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('html')).toHaveAttribute('lang', 'cs');
  await expect(page.getByRole('navigation', { name: 'Sekce' }).getByRole('button', { name: 'Domů', exact: true })).toBeVisible();
  // the theme stayed
  await expect.poll(() => accent(page)).toBe(pickedAccent);

  // ...and back to English
  await page.getByRole('button', { name: 'Předvolby', exact: true }).click();
  const predvolby = dialog(page, 'Předvolby');
  await predvolby.getByRole('button', { name: 'Jazyk a oblast' }).click();
  await Promise.all([page.waitForEvent('load'), predvolby.locator('select').first().selectOption('en')]);
  await expect(page.getByRole('button', { name: 'Your profile' })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Home', exact: true })).toBeVisible();
});

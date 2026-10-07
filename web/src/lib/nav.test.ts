import { describe, expect, it, vi } from 'vitest';

describe('nav', () => {
  it('falls back to history.pushState before a router registers', async () => {
    vi.resetModules();
    const { navigate } = await import('./nav.ts');
    navigate('/c/C42');
    expect(location.pathname).toBe('/c/C42');
  });

  it('delegates to the registered navigate function with options', async () => {
    const { navigate, setNavigate } = await import('./nav.ts');
    const fn = vi.fn();
    setNavigate(fn);
    navigate('/x', { replace: true });
    expect(fn).toHaveBeenCalledWith('/x', { replace: true });
  });

  it('builds channel paths with optional message ids', async () => {
    const { channelPath } = await import('./nav.ts');
    expect(channelPath('C1')).toBe('/c/C1');
    expect(channelPath('C1', 15)).toBe('/c/C1/15');
    expect(channelPath('C1', 0)).toBe('/c/C1');
  });
});

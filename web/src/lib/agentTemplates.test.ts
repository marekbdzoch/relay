import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_COLORS, AGENT_EMOJI, agentTemplates } from './agentTemplates.ts';
import { setLanguage } from '../i18n.ts';

describe('agentTemplates', () => {
  afterEach(() => setLanguage('en'));

  it('returns English templates by default', () => {
    setLanguage('en');
    const list = agentTemplates();
    expect(list.map((t) => t.id)).toEqual(['marketing', 'developer', 'copywriter', 'pm', 'support', 'analyst']);
    const dev = list.find((t) => t.id === 'developer')!;
    expect(dev).toMatchObject({ name: 'Dev Dan', role: 'Software developer', department: 'Development', emoji: '🧑‍💻', color: '#1264a3' });
    expect(dev.instructions).toContain('code reviews');
  });

  it('returns Czech templates when the UI language is Czech', () => {
    setLanguage('cs');
    const dev = agentTemplates().find((t) => t.id === 'developer')!;
    expect(dev.role).toBe('Softwarový vývojář');
    expect(dev.department).toBe('Vývoj');
  });

  it('falls back to English for other languages', () => {
    setLanguage('de');
    expect(agentTemplates()[0].role).toBe('Marketing specialist');
  });

  it('templates are complete in both languages', () => {
    for (const lang of ['en', 'cs']) {
      setLanguage(lang);
      for (const tpl of agentTemplates()) {
        for (const k of ['id', 'emoji', 'color', 'name', 'role', 'department', 'instructions'] as const) expect(tpl[k], `${lang}:${tpl.id}.${k}`).toBeTruthy();
        expect(tpl.color).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  it('exposes avatar pickers without duplicates', () => {
    expect(new Set(AGENT_EMOJI).size).toBe(AGENT_EMOJI.length);
    expect(new Set(AGENT_COLORS).size).toBe(AGENT_COLORS.length);
    for (const tpl of agentTemplates()) expect(AGENT_EMOJI).toContain(tpl.emoji);
  });
});

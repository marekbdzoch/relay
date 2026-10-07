import { S } from '../store.ts';

/**
 * The composer shows human readable text (`@jan.novak`, `#general`), messages are stored
 * with stable tokens (`<@U123>`, `<#C123>`, `<!here>`), so renames never break old messages.
 */
export function encodeMessage(text: string): string {
  const s = S();
  const byUsername = new Map(Object.values(s.users).map((u) => [u.username.toLowerCase(), u.id]));
  const byChannel = new Map(
    Object.values(s.channels)
      .filter((c) => c.kind === 'public' || c.kind === 'private')
      .map((c) => [c.name.toLowerCase(), c.id]),
  );
  // don't touch code
  return text
    .split(/(```[\s\S]*?```|`[^`\n]+`)/g)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part
        .replace(/(^|[\s(>"'])@(here|channel|everyone)\b/g, '$1<!$2>')
        .replace(/(^|[\s(>"'])@([\p{L}\p{N}._-]+)/gu, (m, pre, name: string) => {
          let n = name.toLowerCase();
          // allow trailing punctuation: "@jan." -> mention + "."
          let tail = '';
          while (n && !byUsername.has(n) && /[._-]$/.test(n)) {
            tail = n.slice(-1) + tail;
            n = n.slice(0, -1);
          }
          const id = byUsername.get(n);
          return id ? `${pre}<@${id}>${tail}` : m;
        })
        .replace(/(^|[\s(>"'])#([\p{L}\p{N}_-]+)/gu, (m, pre, name: string) => {
          const id = byChannel.get(name.toLowerCase());
          return id ? `${pre}<#${id}>` : m;
        });
    })
    .join('');
}

export function decodeMessage(text: string): string {
  const s = S();
  return text
    .replace(/<@([A-Z0-9]+)>/g, (m, id) => (s.users[id] ? `@${s.users[id].username}` : m))
    .replace(/<#([A-Z0-9]+)(?:\|[^>]*)?>/g, (m, id) => (s.channels[id] ? `#${s.channels[id].name}` : m))
    .replace(/<!(here|channel|everyone)>/g, '@$1');
}

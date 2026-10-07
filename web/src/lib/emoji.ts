interface EmojiEntry {
  id: string;
  name: string;
  keywords: string[];
  skins: { native: string; unified: string }[];
}

// The emoji dataset (~400 kB) is loaded in its own chunk, in parallel with the app bootstrap.
let emojis: Record<string, EmojiEntry> = {};
let aliases: Record<string, string> = {};
const byNative = new Map<string, string>();
export let emojiData: unknown = null;

let loading: Promise<void> | null = null;
export function loadEmojiData() {
  loading ??= import('@emoji-mart/data').then((mod) => {
    const data = (mod.default ?? mod) as { emojis: Record<string, EmojiEntry>; aliases: Record<string, string> };
    emojis = data.emojis;
    aliases = data.aliases;
    byNative.clear();
    for (const e of Object.values(emojis)) {
      e.skins.forEach((s, i) => byNative.set(s.native, i === 0 ? e.id : `${e.id}::skin-tone-${i + 1}`));
    }
    emojiData = data;
  });
  return loading;
}

// Common Slack-style aliases
const extraAliases: Record<string, string> = {
  thumbsup: '+1',
  thumbsdown: '-1',
  simple_smile: 'slightly_smiling_face',
  white_check_mark: 'white_check_mark',
  tada: 'tada',
  eyes: 'eyes',
  raised_hands: 'raised_hands',
  pray: 'pray',
  joy: 'joy',
  fire: 'fire',
  rocket: 'rocket',
};

export function resolveId(code: string) {
  const [base] = code.split('::');
  if (emojis[base]) return base;
  if (aliases[base]) return aliases[base];
  if (extraAliases[base] && emojis[extraAliases[base]]) return extraAliases[base];
  return null;
}

/** Native character for a shortcode (`+1`, `heart`, `wave::skin-tone-3`), or null. */
export function nativeFor(code: string): string | null {
  const [base, tone] = code.split('::');
  const id = resolveId(base);
  if (!id) return null;
  const skins = emojis[id].skins;
  const toneIdx = tone ? Number(tone.replace('skin-tone-', '')) - 1 : 0;
  return (skins[toneIdx] ?? skins[0]).native;
}

export function shortcodeForNative(native: string): string | null {
  return byNative.get(native) ?? null;
}

export function emojiName(code: string) {
  const id = resolveId(code);
  return id ? emojis[id].id : code;
}

export interface EmojiSuggestion {
  id: string;
  native?: string;
  url?: string;
}

export function searchEmoji(query: string, custom: Record<string, string>, limit = 8): EmojiSuggestion[] {
  const q = query.toLowerCase();
  const out: EmojiSuggestion[] = [];
  for (const [name, url] of Object.entries(custom)) if (name.startsWith(q)) out.push({ id: name, url });
  const starts: EmojiSuggestion[] = [];
  const contains: EmojiSuggestion[] = [];
  for (const e of Object.values(emojis)) {
    if (e.id.startsWith(q)) starts.push({ id: e.id, native: e.skins[0].native });
    else if (e.id.includes(q) || e.keywords.some((k) => k.startsWith(q))) contains.push({ id: e.id, native: e.skins[0].native });
    if (starts.length >= limit) break;
  }
  return [...out, ...starts, ...contains].slice(0, limit);
}

export const DEFAULT_QUICK_REACTIONS = ['white_check_mark', 'eyes', 'raised_hands'];

const EMOJI_ONLY_RE = /^(?:\s|\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|:[a-z0-9_+\-]+(?:::skin-tone-\d)?:)+$/u;
export function isEmojiOnly(text: string) {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 60) return false;
  return EMOJI_ONLY_RE.test(trimmed) && !/^[\d#*\s]+$/.test(trimmed);
}


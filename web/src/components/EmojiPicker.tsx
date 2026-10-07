import { useEffect, useRef } from 'react';
import { emojiData, loadEmojiData } from '../lib/emoji.ts';
import { assetUrl } from '../api.ts';
import { useStore } from '../store.ts';
import { getLanguage } from '../i18n.ts';
import { Popover, type Placement } from './ui.tsx';

export interface PickedEmoji {
  /** shortcode id, e.g. "+1", "heart", "wave::skin-tone-3" or a custom emoji name */
  code: string;
  native?: string;
}

function PickerHost({ onPick }: { onPick: (e: PickedEmoji) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const custom = useStore((s) => s.customEmojiList);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let cancelled = false;
    void (async () => {
    // the picker library is only downloaded the first time someone opens it
    const [{ Picker }] = await Promise.all([import('emoji-mart'), loadEmojiData()]);
    if (cancelled) return;
    const dark = document.documentElement.dataset.mode === 'dark';
    const picker = new Picker({
      data: emojiData,
      theme: dark ? 'dark' : 'light',
      locale: getLanguage() === 'cs' ? 'cs' : 'en',
      previewPosition: 'none',
      skinTonePosition: 'search',
      autoFocus: true,
      maxFrequentRows: 2,
      perLine: 9,
      emojiSize: 22,
      emojiButtonSize: 34,
      custom: custom.length
        ? [{ id: 'custom', name: 'Custom', emojis: custom.map((e) => ({ id: e.name, name: e.name, keywords: [e.name], skins: [{ src: assetUrl(e.url) }] })) }]
        : [],
      categories: ['frequent', ...(custom.length ? ['custom'] : []), 'people', 'nature', 'foods', 'activity', 'places', 'objects', 'symbols', 'flags'],
      onEmojiSelect: (e: { id: string; native?: string; skin?: number }) => {
        const code = e.skin && e.skin > 1 ? `${e.id}::skin-tone-${e.skin}` : e.id;
        onPickRef.current({ code, native: e.native });
      },
    } as any);
    el.appendChild(picker as unknown as Node);
    })();
    return () => {
      cancelled = true;
      el.innerHTML = '';
    };
  }, [custom]);

  return <div ref={host} className="emoji-picker-host" />;
}

export function EmojiPickerPopover({
  anchor,
  onClose,
  onPick,
  placement = 'top-end',
  keepOpen,
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  onPick: (e: PickedEmoji) => void;
  placement?: Placement;
  keepOpen?: boolean;
}) {
  return (
    <Popover anchor={anchor} onClose={onClose} placement={placement} className="emoji-popover">
      <PickerHost
        onPick={(e) => {
          onPick(e);
          if (!keepOpen) onClose();
        }}
      />
    </Popover>
  );
}

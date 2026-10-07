import { createRef, useState, type ComponentProps } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerInput, SLASH_COMMANDS, type ComposerInputHandle } from './ComposerInput.tsx';
import { loadEmojiData, searchEmoji } from '../lib/emoji.ts';
import { set } from '../store.ts';
import { makeChannel, makeMe, makeMembership, makeUser, resetStore } from '../test/helpers.ts';

type Props = ComponentProps<typeof ComposerInput>;

const onSubmit = vi.fn();
const onChangeSpy = vi.fn();

function Harness({ initial = '', ...props }: Partial<Props> & { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <ComposerInput
      value={value}
      onChange={(v) => {
        setValue(v);
        onChangeSpy(v);
      }}
      onSubmit={onSubmit}
      channelId="C1"
      placeholder="Message #general"
      {...props}
    />
  );
}

function setup(props: Partial<Props> & { initial?: string } = {}) {
  const user = userEvent.setup();
  const ref = createRef<ComposerInputHandle>();
  render(<Harness {...props} ref={ref} />);
  const ta = screen.getByPlaceholderText('Message #general') as HTMLTextAreaElement;
  return { user, ta, ref };
}

beforeAll(() => loadEmojiData());

beforeEach(() => {
  onSubmit.mockReset();
  onChangeSpy.mockReset();
  resetStore({
    me: makeMe({ id: 'U1', username: 'me', prefs: {} }),
    users: {
      U1: makeUser({ id: 'U1', username: 'me', fullName: 'Me Myself' }),
      U2: makeUser({ id: 'U2', username: 'jana', fullName: 'Jana Nováková' }),
      U3: makeUser({ id: 'U3', username: 'jakub', fullName: 'Jakub Dvořák', displayName: 'Kuba' }),
      U4: makeUser({ id: 'U4', username: 'janek', fullName: 'Old Account', deactivated: true }),
    },
    channels: {
      C1: makeChannel({ id: 'C1', name: 'general', memberIds: ['U1', 'U2'] }),
      C2: makeChannel({ id: 'C2', name: 'gems', kind: 'private' }),
      C3: makeChannel({ id: 'C3', name: 'geography', kind: 'private' }),
      C4: makeChannel({ id: 'C4', name: 'genealogy', archived: true }),
      C5: makeChannel({ id: 'C5', name: 'getting-started' }),
    },
    memberships: { C1: makeMembership({ channelId: 'C1' }), C2: makeMembership({ channelId: 'C2' }) },
  });
});

const options = () => screen.queryAllByRole('button');

describe('@ mentions', () => {
  it('typing "@ja" shows people and Enter inserts "@jana "', async () => {
    const { user, ta } = setup();
    await user.type(ta, '@ja');
    expect(screen.getByText('People')).toBeInTheDocument();
    // channel members first, deactivated users hidden
    const labels = options().map((b) => b.textContent);
    expect(labels[0]).toContain('Jana Nováková');
    expect(labels[1]).toContain('Kuba');
    expect(labels.join()).not.toContain('Old Account');
    expect(screen.getByText('@jana')).toBeInTheDocument(); // sub-label
    expect(screen.getByText('Jakub Dvořák')).toBeInTheDocument(); // full name shown when it differs
    await user.keyboard('{Enter}');
    expect(ta).toHaveValue('@jana ');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByText('People')).not.toBeInTheDocument();
  });

  it('ArrowDown moves the selection and Tab chooses', async () => {
    const { user, ta } = setup({ initial: 'hi ' });
    await user.type(ta, '@ja');
    await user.keyboard('{ArrowDown}{Tab}');
    expect(ta).toHaveValue('hi @jakub ');
  });

  it('ArrowUp wraps around to the last option', async () => {
    const { user, ta } = setup();
    await user.type(ta, '@ja');
    await user.keyboard('{ArrowUp}{Enter}');
    expect(ta).toHaveValue('@jakub ');
  });

  it('ArrowDown wraps around to the first option', async () => {
    const { user, ta } = setup();
    await user.type(ta, '@ja');
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(ta).toHaveValue('@jana ');
  });

  it('offers @here / @channel in channels only', async () => {
    const { user, ta } = setup();
    await user.type(ta, '@he');
    expect(screen.getByText('@here')).toBeInTheDocument();
    expect(screen.queryByText('@channel')).not.toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(ta).toHaveValue('@here ');
  });

  it('does not offer specials outside channels', async () => {
    const user = userEvent.setup();
    render(<Harness channelId={undefined} />);
    const ta = screen.getByRole('textbox');
    await user.type(ta, '@');
    expect(screen.queryByText('@here')).not.toBeInTheDocument();
    expect(screen.getByText('People')).toBeInTheDocument();
  });

  it('does not trigger inside words (e-mail addresses)', async () => {
    const { user, ta } = setup();
    await user.type(ta, 'mail@ja');
    expect(screen.queryByText('People')).not.toBeInTheDocument();
  });

  it('Escape closes the list without clearing the text', async () => {
    const { user, ta } = setup();
    await user.type(ta, '@ja');
    await user.keyboard('{Escape}');
    expect(screen.queryByText('People')).not.toBeInTheDocument();
    expect(ta).toHaveValue('@ja');
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('clicking (mousedown) an option chooses it', async () => {
    const { user, ta } = setup();
    await user.type(ta, '@ku');
    fireEvent.mouseEnter(options()[0]);
    fireEvent.mouseDown(screen.getByText('Kuba'));
    expect(ta).toHaveValue('@jakub ');
  });

  it('re-evaluates the trigger when clicking into the text', () => {
    const { ta } = setup({ initial: '@ja and more' });
    ta.setSelectionRange(3, 3);
    fireEvent.click(ta);
    expect(screen.getByText('People')).toBeInTheDocument();
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(ta).toHaveValue('@jana  and more');
  });

  it('hides the list shortly after blur', async () => {
    const { user, ta } = setup();
    await user.type(ta, '@ja');
    act(() => ta.blur());
    await waitFor(() => expect(screen.queryByText('People')).not.toBeInTheDocument());
  });
});

describe('# channels', () => {
  it('typing "#ge" lists accessible, non-archived channels, joined first', async () => {
    const { user, ta } = setup();
    await user.type(ta, 'see #ge');
    expect(screen.getByText('Channels')).toBeInTheDocument();
    expect(options().map((b) => b.textContent)).toEqual(['gems', 'general', 'getting-started']);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(ta).toHaveValue('see #general ');
  });

  it('shows nothing when no channel matches', async () => {
    const { user, ta } = setup();
    await user.type(ta, '#zzz');
    expect(screen.queryByText('Channels')).not.toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalled();
  });
});

describe(': emoji', () => {
  it('needs two characters, then lists matching emoji and inserts the native character', async () => {
    const { user, ta } = setup();
    await user.type(ta, ':s');
    expect(screen.queryByText(/Emoji matching/)).not.toBeInTheDocument();
    await user.type(ta, 'mi');
    expect(screen.getByText('Emoji matching “smi”')).toBeInTheDocument();
    const first = searchEmoji('smi', {})[0];
    expect(screen.getByText(`:${first.id}:`)).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(ta).toHaveValue(`${first.native} `);
  });

  it('inserts custom emoji as shortcodes', async () => {
    set((s) => void (s.customEmoji = { smilecat: '/e/smilecat.png' }));
    const { user, ta } = setup();
    await user.type(ta, ':smilec');
    expect(screen.getByText(':smilecat:')).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(ta).toHaveValue(':smilecat: ');
  });
});

describe('/ slash commands', () => {
  it('lists commands at the start of the message', async () => {
    const { user, ta } = setup({ slashCommands: true });
    await user.type(ta, '/');
    expect(screen.getByText('Commands')).toBeInTheDocument();
    expect(options()).toHaveLength(SLASH_COMMANDS.length);
    await user.type(ta, 'sh');
    expect(options().map((b) => b.textContent)).toEqual(['/shrug [message]Appends ¯\\_(ツ)_/¯ to your message']);
    await user.keyboard('{Enter}');
    expect(ta).toHaveValue('/shrug ');
  });

  it('is disabled unless enabled and only at the very start', async () => {
    const { user, ta } = setup();
    await user.type(ta, '/');
    expect(screen.queryByText('Commands')).not.toBeInTheDocument();
  });

  it('does not trigger in the middle of text', async () => {
    const { user, ta } = setup({ slashCommands: true, initial: 'a ' });
    await user.type(ta, '/me');
    expect(screen.queryByText('Commands')).not.toBeInTheDocument();
  });
});

describe('Enter behaviour', () => {
  it('Enter submits, Shift+Enter inserts a newline', async () => {
    const { user, ta } = setup();
    await user.type(ta, 'hello');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(ta).toHaveValue('hello\n');
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('Alt+Enter and Ctrl+Enter do not submit by default', () => {
    const { ta } = setup({ initial: 'x' });
    fireEvent.keyDown(ta, { key: 'Enter', altKey: true });
    fireEvent.keyDown(ta, { key: 'Enter', ctrlKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('inside an open code block Enter adds a newline and Ctrl/Cmd+Enter submits', async () => {
    const { user, ta } = setup();
    await user.type(ta, '```code');
    await user.keyboard('{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('a closed code block does not block sending', async () => {
    const { user, ta } = setup();
    await user.type(ta, '```x``` done');
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('with "Enter to send" disabled, Enter adds a newline and Ctrl+Enter sends', () => {
    set((s) => void (s.me!.prefs.enterToSend = false));
    const { ta } = setup({ initial: 'x' });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(ta, { key: 'Enter', ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('a custom onKeyDown that handles the key wins', () => {
    const onKeyDown = vi.fn(() => true);
    const { ta } = setup({ onKeyDown, initial: 'x' });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onKeyDown).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('ignores keys while an IME composition is active', () => {
    const { ta } = setup({ initial: 'x' });
    fireEvent.keyDown(ta, { key: 'Enter', isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('formatting shortcuts', () => {
  it('Ctrl+B wraps the selection with *', async () => {
    const { ta } = setup({ initial: 'hello world' });
    ta.setSelectionRange(0, 5);
    fireEvent.keyDown(ta, { key: 'b', ctrlKey: true });
    expect(ta).toHaveValue('*hello* world');
    await waitFor(() => expect([ta.selectionStart, ta.selectionEnd]).toEqual([1, 6]));
  });

  it('Cmd+B works too, Cmd+I wraps with _ and Cmd+Shift+X with ~', () => {
    const { ta } = setup({ initial: 'a b c' });
    ta.setSelectionRange(0, 1);
    fireEvent.keyDown(ta, { key: 'B', metaKey: true });
    expect(ta).toHaveValue('*a* b c');
    ta.setSelectionRange(4, 5);
    fireEvent.keyDown(ta, { key: 'i', metaKey: true });
    expect(ta).toHaveValue('*a* _b_ c');
    ta.setSelectionRange(8, 9);
    fireEvent.keyDown(ta, { key: 'x', metaKey: true, shiftKey: true });
    expect(ta).toHaveValue('*a* _b_ ~c~');
  });

  it('wrapping an empty selection inserts the markers at the caret', () => {
    const { ta } = setup({ initial: 'ab' });
    ta.setSelectionRange(1, 1);
    fireEvent.keyDown(ta, { key: 'b', ctrlKey: true });
    expect(ta).toHaveValue('a**b');
  });
});

describe('paste & focus', () => {
  it('passes pasted files to onPasteFiles', () => {
    const onPasteFiles = vi.fn();
    const { ta } = setup({ onPasteFiles });
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    fireEvent.paste(ta, { clipboardData: { files: [file] } });
    expect(onPasteFiles).toHaveBeenCalledWith([file]);
  });

  it('ignores pastes without files', () => {
    const onPasteFiles = vi.fn();
    const { ta } = setup({ onPasteFiles });
    fireEvent.paste(ta, { clipboardData: { files: [] } });
    expect(onPasteFiles).not.toHaveBeenCalled();
  });

  it('reports focus changes and auto-focuses', async () => {
    const onFocusChange = vi.fn();
    const { ta } = setup({ onFocusChange, autoFocus: true });
    expect(ta).toHaveFocus();
    expect(onFocusChange).toHaveBeenCalledWith(true);
    act(() => ta.blur());
    expect(onFocusChange).toHaveBeenLastCalledWith(false);
  });
});

describe('imperative handle', () => {
  it('insert() replaces the selection', async () => {
    const { ta, ref } = setup({ initial: 'hello world' });
    ta.setSelectionRange(6, 11);
    act(() => ref.current!.insert('there'));
    expect(ta).toHaveValue('hello there');
    expect(ref.current!.el()).toBe(ta);
    act(() => ref.current!.focus());
    expect(ta).toHaveFocus();
  });

  it('wrap() uses a placeholder for empty selections', () => {
    const { ta, ref } = setup({ initial: 'see ' });
    ta.setSelectionRange(4, 4);
    act(() => ref.current!.wrap('[', '](url)', 'text'));
    expect(ta).toHaveValue('see [text](url)');
  });

  it('prefixLines() prefixes every selected line', () => {
    const { ta, ref } = setup({ initial: 'a\nb\nc' });
    ta.setSelectionRange(0, 3);
    act(() => ref.current!.prefixLines('> '));
    expect(ta).toHaveValue('> a\n> b\nc');
    ta.setSelectionRange(0, ta.value.length);
    act(() => ref.current!.prefixLines((i) => `${i + 1}. `));
    expect(ta).toHaveValue('1. > a\n2. > b\n3. c');
  });

  it('startTrigger() inserts the trigger (with a space if needed) and opens the list', async () => {
    const { ta, ref } = setup({ initial: 'hi' });
    ta.setSelectionRange(2, 2);
    act(() => ref.current!.startTrigger('@'));
    expect(ta).toHaveValue('hi @');
    await screen.findByText('People');
  });
});

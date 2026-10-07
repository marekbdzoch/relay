import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Emoji, Mrkdwn, renderInline, toPlainText } from './mrkdwn.tsx';
import { setNavigate } from './nav.ts';
import { loadEmojiData } from './emoji.ts';
import { S } from '../store.ts';
import { makeChannel, makeMe, makeUser, resetStore } from '../test/helpers.ts';

const nav = vi.fn();

beforeAll(() => loadEmojiData());

beforeEach(() => {
  nav.mockReset();
  setNavigate(nav);
  resetStore({
    me: makeMe({ id: 'U1', username: 'me' }),
    users: {
      U1: makeUser({ id: 'U1', username: 'me', fullName: 'Me Myself' }),
      U2: makeUser({ id: 'U2', username: 'jana', fullName: 'Jana Nováková', displayName: 'Jana' }),
      U3: makeUser({ id: 'U3', username: 'petr' }),
    },
    channels: { C1: makeChannel({ id: 'C1', name: 'general' }) },
    customEmoji: { party_parrot: '/emoji/parrot.gif' },
  });
});

const html = (text: string) => render(<Mrkdwn text={text} />).container;

describe('<Mrkdwn/> inline formatting', () => {
  it('renders bold, italic and strike', () => {
    const c = html('*bold* _italic_ ~strike~ ~~double~~ **md bold**');
    expect(c.querySelector('b')).toHaveTextContent('bold');
    expect(c.querySelectorAll('b')[1]).toHaveTextContent('md bold');
    expect(c.querySelector('i')).toHaveTextContent('italic');
    const strikes = c.querySelectorAll('s');
    expect(strikes[0]).toHaveTextContent(/^strike$/);
    expect(strikes[1]).toHaveTextContent(/^double$/);
  });

  it('nests formatting', () => {
    const c = html('*bold _and italic_*');
    expect(c.querySelector('b i')).toHaveTextContent('and italic');
  });

  it('does not format inside words or with surrounding spaces', () => {
    const c = html('snake_case_name 2*3*4 a * b * c ~ x ~');
    expect(c.querySelector('i, b, s')).toBeNull();
    expect(c).toHaveTextContent('snake_case_name 2*3*4 a * b * c ~ x ~');
  });

  it('renders inline code without formatting its content', () => {
    const c = html('run `npm *test*` now');
    const code = c.querySelector('code')!;
    expect(code).toHaveTextContent('npm *test*');
    expect(code.querySelector('b')).toBeNull();
  });

  it('keeps the shrug intact', () => {
    const c = html('oh well ¯\\_(ツ)_/¯');
    expect(c).toHaveTextContent('oh well ¯\\_(ツ)_/¯');
    expect(c.querySelector('i')).toBeNull();
  });
});

describe('<Mrkdwn/> blocks', () => {
  it('renders code blocks verbatim and trims surrounding newlines', () => {
    const c = html('before\n```\nconst *x* = `1`;\n<@U2>\n```\nafter');
    const pre = c.querySelector('pre')!;
    expect(pre.textContent).toBe('const *x* = `1`;\n<@U2>');
    expect(c).toHaveTextContent('before');
    expect(c).toHaveTextContent('after');
  });

  it('renders block quotes, also HTML-escaped ones, with line breaks', () => {
    const c = html('> first\n&gt; second\nnormal');
    const q = c.querySelector('blockquote')!;
    expect(q).toHaveTextContent('firstsecond');
    expect(q.querySelectorAll('br')).toHaveLength(1);
    expect(c).toHaveTextContent('normal');
  });

  it('renders bullet lists', () => {
    render(<Mrkdwn text={'- one\n* two\n• *three*'} />);
    const items = screen.getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual(['one', 'two', 'three']);
    expect(screen.getByRole('list').tagName).toBe('UL');
  });

  it('renders ordered lists keeping the start number', () => {
    render(<Mrkdwn text={'3) three\n4. four'} />);
    const list = screen.getByRole('list');
    expect(list.tagName).toBe('OL');
    expect(list).toHaveAttribute('start', '3');
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['three', 'four']);
  });

  it('joins paragraph lines with <br> and drops leading/trailing blank lines', () => {
    const c = html('\n\nline 1\nline 2\n\n');
    expect(c.querySelectorAll('br')).toHaveLength(1);
    expect(c.textContent).toBe('line 1line 2');
  });

  it('renders nothing for empty text', () => {
    expect(html('').textContent).toBe('');
  });

  it('mixes lists, quotes and paragraphs', () => {
    const c = html('intro\n- a\n- b\n> q\n1. x\noutro');
    expect(c.querySelector('ul')).toBeTruthy();
    expect(c.querySelector('blockquote')).toHaveTextContent('q');
    expect(c.querySelector('ol')).toHaveTextContent('x');
    expect(c).toHaveTextContent(/intro.*outro/);
  });
});

describe('<Mrkdwn/> links', () => {
  it('renders Slack-style links with and without labels', () => {
    render(<Mrkdwn text={'<https://example.com|Example *site*> and <https://foo.org/x>'} />);
    const a = screen.getByRole('link', { name: 'Example site' });
    expect(a).toHaveAttribute('href', 'https://example.com');
    expect(a).toHaveAttribute('target', '_blank');
    expect(a).toHaveAttribute('rel', 'noopener noreferrer');
    expect(a.querySelector('b')).toHaveTextContent('site');
    expect(screen.getByRole('link', { name: 'https://foo.org/x' })).toHaveAttribute('href', 'https://foo.org/x');
  });

  it('renders markdown links', () => {
    render(<Mrkdwn text={'see [the docs](https://docs.example.com/a)'} />);
    expect(screen.getByRole('link', { name: 'the docs' })).toHaveAttribute('href', 'https://docs.example.com/a');
  });

  it('auto-links bare URLs without trailing punctuation', () => {
    render(<Mrkdwn text={'Go to https://example.com/path?q=1. Or (https://x.io/a)!'} />);
    expect(screen.getByRole('link', { name: 'https://example.com/path?q=1' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'https://x.io/a' })).toBeInTheDocument();
  });

  it('opens in-app permalinks inside the app', () => {
    render(<Mrkdwn text={`<${location.origin}/c/C1/42|jump>`} />);
    const a = screen.getByRole('link', { name: 'jump' });
    expect(a).not.toHaveAttribute('target');
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(nav).toHaveBeenCalledWith('/c/C1/42', undefined);
  });

  it('opens in-app channel links without a message id', () => {
    render(<Mrkdwn text={`${location.origin}/c/C1`} />);
    fireEvent.click(screen.getByRole('link'));
    expect(nav).toHaveBeenCalledWith('/c/C1', undefined);
  });

  it('lets external links through and stops propagation', () => {
    const parent = vi.fn();
    render(
      <div onClick={parent}>
        <Mrkdwn text="https://example.com" />
      </div>,
    );
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    screen.getByRole('link').dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(parent).not.toHaveBeenCalled();
    expect(nav).not.toHaveBeenCalled();
  });
});

describe('<Mrkdwn/> mentions', () => {
  it('renders user mentions with the display name and opens the profile on click', () => {
    render(<Mrkdwn text="hi <@U2> and <@U3> and <@U1>" />);
    fireEvent.click(screen.getByText('@Jana'));
    expect(S().right).toEqual({ type: 'profile', userId: 'U2' });
    expect(screen.getByText('@petr')).toBeInTheDocument();
    expect(screen.getByText('@Me Myself')).toBeInTheDocument();
  });

  it('shows a placeholder for unknown users', () => {
    render(<Mrkdwn text="<@U999>" />);
    expect(screen.getByText('@unknown user')).toBeInTheDocument();
  });

  it('renders channel mentions and navigates on click', () => {
    render(<Mrkdwn text="<#C1> <#C9|secret-stuff> <#C8>" />);
    fireEvent.click(screen.getByText('#general'));
    expect(nav).toHaveBeenCalledWith('/c/C1', undefined);
    expect(screen.getByText('#secret-stuff')).toBeInTheDocument();
    expect(screen.getByText('#private-channel')).toBeInTheDocument();
  });

  it('renders special mentions', () => {
    render(<Mrkdwn text="<!here> <!channel> <!everyone>" />);
    for (const s of ['@here', '@channel', '@everyone']) expect(screen.getByText(s)).toBeInTheDocument();
  });
});

describe('<Mrkdwn/> emoji', () => {
  it('renders shortcodes as native emoji with a title', () => {
    render(<Mrkdwn text=":tada: :+1::skin-tone-3: :thumbsup:" />);
    expect(screen.getByTitle(':tada:')).toHaveTextContent('🎉');
    expect(screen.getByTitle(':+1::skin-tone-3:')).toHaveTextContent('👍🏼');
    expect(screen.getByTitle(':thumbsup:')).toHaveTextContent('👍');
  });

  it('renders custom emoji as images', () => {
    render(<Mrkdwn text=":party_parrot:" />);
    expect(screen.getByRole('img', { name: ':party_parrot:' })).toHaveAttribute('src', '/emoji/parrot.gif');
  });

  it('leaves unknown shortcodes as text', () => {
    expect(html('time is 10:30:00 and :nope_nope:')).toHaveTextContent('time is 10:30:00 and :nope_nope:');
  });
});

describe('<Emoji/>', () => {
  it('applies the requested size', () => {
    const { container } = render(
      <>
        <Emoji code="fire" size={32} />
        <Emoji code="party_parrot" size={20} />
        <Emoji code="fire" />
      </>,
    );
    const [native, img, plain] = [container.querySelector('span')!, container.querySelector('img')!, container.querySelectorAll('span')[1]];
    expect(native.style.fontSize).toBe('32px');
    expect(img.style.width).toBe('20px');
    expect(plain.getAttribute('style')).toBeNull();
  });
});

describe('renderInline', () => {
  it('returns the plain string when there is no markup', () => {
    expect(renderInline('just text')).toEqual(['just text']);
    expect(renderInline('')).toEqual([]);
  });
});

describe('toPlainText', () => {
  it('replaces mentions, links, code fences and emoji', () => {
    expect(toPlainText('<@U2> <@U999> in <#C1> <#C9|x> <!here>')).toBe('@Jana @Unknown in #general #channel @here');
    expect(toPlainText('<https://a.io|A> <https://b.io>')).toBe('A https://b.io');
    expect(toPlainText('```code```')).toBe('code');
    expect(toPlainText(':tada: :wave::skin-tone-2: :nope_nope:')).toBe('🎉 👋🏻 :nope_nope:');
  });
});

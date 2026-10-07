import { beforeEach, describe, expect, it } from 'vitest';
import { decodeMessage, encodeMessage } from './composerText.ts';
import { makeChannel, makeUser, resetStore } from '../test/helpers.ts';

beforeEach(() => {
  resetStore({
    users: {
      U1: makeUser({ id: 'U1', username: 'jana' }),
      U2: makeUser({ id: 'U2', username: 'jan.novak' }),
      U3: makeUser({ id: 'U3', username: 'Petr-K' }),
    },
    channels: {
      C1: makeChannel({ id: 'C1', name: 'general' }),
      C2: makeChannel({ id: 'C2', name: 'secret', kind: 'private' }),
      D1: makeChannel({ id: 'D1', name: 'dm-name', kind: 'dm' }),
    },
  });
});

describe('encodeMessage', () => {
  it('encodes user mentions to stable tokens', () => {
    expect(encodeMessage('hi @jana')).toBe('hi <@U1>');
    expect(encodeMessage('@jan.novak please')).toBe('<@U2> please');
    expect(encodeMessage('@JANA and @petr-k')).toBe('<@U1> and <@U3>');
  });

  it('keeps trailing punctuation outside the mention', () => {
    expect(encodeMessage('thanks @jana.')).toBe('thanks <@U1>.');
    expect(encodeMessage('@jana... ok')).toBe('<@U1>... ok');
    expect(encodeMessage('(@jana)')).toBe('(<@U1>)');
  });

  it('leaves unknown names and e-mail addresses alone', () => {
    expect(encodeMessage('hi @nobody')).toBe('hi @nobody');
    expect(encodeMessage('mail me at x@jana.cz')).toBe('mail me at x@jana.cz');
    expect(encodeMessage('@nobody.')).toBe('@nobody.');
  });

  it('encodes special mentions', () => {
    expect(encodeMessage('@here @channel @everyone')).toBe('<!here> <!channel> <!everyone>');
    expect(encodeMessage('@heretic')).toBe('@heretic');
  });

  it('encodes public and private channels but not DMs', () => {
    expect(encodeMessage('see #general and #Secret')).toBe('see <#C1> and <#C2>');
    expect(encodeMessage('#dm-name #unknown')).toBe('#dm-name #unknown');
    expect(encodeMessage('issue#general')).toBe('issue#general');
  });

  it('does not touch inline code or code blocks', () => {
    expect(encodeMessage('`@jana` @jana')).toBe('`@jana` <@U1>');
    expect(encodeMessage('```\n@jana #general\n``` #general')).toBe('```\n@jana #general\n``` <#C1>');
  });

  it('accepts mentions after quotes and newlines', () => {
    expect(encodeMessage('"@jana"\n@jana')).toBe('"<@U1>"\n<@U1>');
    expect(encodeMessage('>@jana')).toBe('><@U1>');
  });
});

describe('decodeMessage', () => {
  it('decodes tokens back to readable text', () => {
    expect(decodeMessage('hi <@U1>, see <#C1> <!here>')).toBe('hi @jana, see #general @here');
    expect(decodeMessage('<#C2|old-name>')).toBe('#secret');
    expect(decodeMessage('<!channel> <!everyone>')).toBe('@channel @everyone');
  });

  it('keeps tokens of unknown users and channels', () => {
    expect(decodeMessage('<@U999> <#C999>')).toBe('<@U999> <#C999>');
  });

  it('round-trips with encodeMessage', () => {
    const text = 'Hey @jan.novak, check #general and ping @here';
    expect(decodeMessage(encodeMessage(text))).toBe(text);
  });
});

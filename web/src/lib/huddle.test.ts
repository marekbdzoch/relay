import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HuddleState } from '../../../shared/types.ts';
import { huddleEnded, huddleSignal, huddleStateChanged, joinHuddle, leaveHuddle, rejoinHuddle, toggleCamera, toggleMute, toggleScreenShare, useHuddle } from './huddle.ts';
import { playKnock } from './notify.ts';
import { S } from '../store.ts';
import { flush, makeChannel, makeMe, resetStore } from '../test/helpers.ts';

const sock = vi.hoisted(() => ({ emit: (..._a: any[]) => {} }));
vi.mock('../socket.ts', () => ({ socket: sock }));
vi.mock('./notify.ts', () => ({ playKnock: vi.fn() }));

// ---------- WebRTC / media fakes ----------

let seq = 0;
class FakeTrack {
  enabled = true;
  stop = vi.fn();
  onended: (() => void) | null = null;
  onmute: (() => void) | null = null;
  onunmute: (() => void) | null = null;
  constructor(public kind: 'audio' | 'video') {}
}
class FakeStream {
  id = `stream-${++seq}`;
  constructor(public tracks: FakeTrack[] = []) {}
  getTracks = () => this.tracks;
  getAudioTracks = () => this.tracks.filter((t) => t.kind === 'audio');
  getVideoTracks = () => this.tracks.filter((t) => t.kind === 'video');
}
class FakePC {
  static all: FakePC[] = [];
  signalingState = 'stable';
  connectionState = 'new';
  localDescription: any = null;
  onnegotiationneeded: (() => Promise<void>) | null = null;
  onicecandidate: ((e: { candidate: unknown }) => void) | null = null;
  ontrack: ((e: { track: FakeTrack; streams: FakeStream[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  addTrack = vi.fn((track: FakeTrack) => ({ track }));
  removeTrack = vi.fn();
  setLocalDescription = vi.fn(async () => {
    this.localDescription = { type: this.signalingState === 'have-remote-offer' ? 'answer' : 'offer', sdp: 'local' };
    this.signalingState = this.localDescription.type === 'offer' ? 'have-local-offer' : 'stable';
  });
  setRemoteDescription = vi.fn(async (d: { type: string }) => {
    this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable';
  });
  addIceCandidate = vi.fn(async () => {});
  close = vi.fn();
  restartIce = vi.fn();
  constructor(public config: unknown) {
    FakePC.all.push(this);
  }
}

const getUserMedia = vi.fn();
const getDisplayMedia = vi.fn();
let mic: FakeStream;

const signals = () =>
  vi
    .mocked(sock.emit)
    .mock.calls.filter((c) => c[0] === 'huddle:signal')
    .map((c) => c[1]);
const lastPc = () => FakePC.all.at(-1)!;
const state = (ids: string[], channelId = 'C1'): HuddleState => ({
  channelId,
  startedAt: 1,
  participants: ids.map((userId) => ({ userId, muted: false, sharing: false, video: false })),
});

async function joined(channelId = 'C1') {
  await joinHuddle(channelId);
  const ack = vi.mocked(sock.emit).mock.calls.find((c) => c[0] === 'huddle:join')![2] as (r: { ok: boolean }) => void;
  ack({ ok: true });
}

beforeEach(() => {
  FakePC.all = [];
  sock.emit = vi.fn();
  vi.mocked(playKnock).mockClear();
  vi.stubGlobal('RTCPeerConnection', FakePC);
  vi.stubGlobal('MediaStream', FakeStream);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  mic = new FakeStream([new FakeTrack('audio')]);
  getUserMedia.mockReset().mockImplementation(async (c: MediaStreamConstraints) => (c.video ? new FakeStream([new FakeTrack('video')]) : mic));
  getDisplayMedia.mockReset().mockImplementation(async () => new FakeStream([new FakeTrack('video')]));
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia, getDisplayMedia }, configurable: true });
  resetStore({
    me: makeMe({ id: 'U5', prefs: { audioInput: 'mic-1', videoInput: 'cam-1' } }),
    workspace: { name: 'Acme', iconUrl: null, allowedDomains: '', createdAt: 0, iceServers: [{ urls: 'stun:stun.example.com' }] },
    channels: { C1: makeChannel({ id: 'C1' }), D1: makeChannel({ id: 'D1', kind: 'dm', memberIds: ['U5', 'U2'] }), G1: makeChannel({ id: 'G1', kind: 'group' }) },
  });
});

afterEach(() => {
  leaveHuddle();
});

describe('joinHuddle / leaveHuddle', () => {
  it('asks for the microphone, joins and opens the window', async () => {
    await joined();
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, deviceId: { ideal: 'mic-1' } },
      video: false,
    });
    expect(sock.emit).toHaveBeenCalledWith('huddle:join', { channelId: 'C1' }, expect.any(Function));
    expect(useHuddle.getState()).toMatchObject({ channelId: 'C1', muted: false, connecting: false, windowOpen: true });
  });

  it('uses the default microphone without a preference', async () => {
    resetStore({ me: makeMe({ id: 'U5', prefs: {} }) });
    await joinHuddle('C1');
    expect(getUserMedia.mock.calls[0][0].audio.deviceId).toBeUndefined();
  });

  it('re-opens the window when joining the current huddle again', async () => {
    await joined();
    useHuddle.setState({ windowOpen: false });
    await joinHuddle('C1');
    expect(useHuddle.getState().windowOpen).toBe(true);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('leaves the previous huddle when joining another one', async () => {
    await joined('C1');
    await joinHuddle('D1');
    expect(sock.emit).toHaveBeenCalledWith('huddle:leave', { channelId: 'C1' });
    expect(useHuddle.getState().channelId).toBe('D1');
  });

  it('shows an error when the microphone is denied', async () => {
    getUserMedia.mockRejectedValueOnce(new Error('NotAllowedError'));
    await joinHuddle('C1');
    expect(useHuddle.getState()).toMatchObject({ channelId: null, connecting: false });
    expect(S().toasts.at(-1)).toMatchObject({ text: 'Microphone access is needed to join a huddle.', kind: 'error' });
  });

  it('cleans up when the server refuses the join', async () => {
    await joinHuddle('C1');
    const ack = vi.mocked(sock.emit).mock.calls[0][2] as (r: unknown) => void;
    ack({ ok: false, error: 'full' });
    expect(useHuddle.getState().channelId).toBeNull();
    expect(mic.tracks[0].stop).toHaveBeenCalled();
    expect(S().toasts.at(-1)?.text).toBe('Could not join the huddle.');
    ack(undefined);
  });

  it('turns the camera on after joining with video', async () => {
    await joinHuddle('C1', true);
    const ack = vi.mocked(sock.emit).mock.calls[0][2] as (r: unknown) => void;
    ack({ ok: true });
    await flush();
    expect(useHuddle.getState().camera).toBe(true);
  });

  it('leaveHuddle notifies the server and stops all tracks', async () => {
    await joined();
    leaveHuddle();
    expect(sock.emit).toHaveBeenCalledWith('huddle:leave', { channelId: 'C1' });
    expect(mic.tracks[0].stop).toHaveBeenCalled();
    expect(useHuddle.getState()).toMatchObject({ channelId: null, windowOpen: false });
    vi.mocked(sock.emit).mockClear();
    leaveHuddle();
    expect(sock.emit).not.toHaveBeenCalled();
  });

  it('leaves when the page unloads', async () => {
    await joined();
    window.dispatchEvent(new Event('beforeunload'));
    expect(useHuddle.getState().channelId).toBeNull();
    window.dispatchEvent(new Event('beforeunload'));
  });
});

describe('rejoinHuddle (after a reconnect)', () => {
  it('does nothing outside a call', () => {
    rejoinHuddle();
    expect(sock.emit).not.toHaveBeenCalled();
  });

  it('drops the old peers, rejoins the same room and re-reports media', async () => {
    await joined();
    huddleStateChanged(state(['U5', 'U2']));
    const old = lastPc();
    toggleMute();
    vi.mocked(sock.emit).mockClear();
    rejoinHuddle();
    expect(old.close).toHaveBeenCalled();
    const calls = vi.mocked(sock.emit).mock.calls;
    expect(calls[0]).toEqual(['huddle:leave', { channelId: 'C1' }]);
    expect(calls[1][0]).toBe('huddle:join');
    (calls[1][2] as (r: { ok: boolean }) => void)({ ok: true });
    expect(sock.emit).toHaveBeenCalledWith('huddle:media', { channelId: 'C1', muted: true, sharing: false, video: false });
    expect(useHuddle.getState().channelId).toBe('C1');
    // the mic keeps running across the reconnect
    expect(mic.tracks[0].stop).not.toHaveBeenCalled();
  });

  it('cleans up when the server refuses the rejoin', async () => {
    await joined();
    vi.mocked(sock.emit).mockClear();
    rejoinHuddle();
    (vi.mocked(sock.emit).mock.calls[1][2] as (r: unknown) => void)(undefined);
    expect(useHuddle.getState().channelId).toBeNull();
    expect(S().toasts.at(-1)?.text).toBe('Could not join the huddle.');
  });
});

describe('huddleStateChanged', () => {
  it('knocks when someone starts a huddle in a DM or group DM', () => {
    huddleStateChanged(state(['U2'], 'D1'));
    huddleStateChanged(state(['U2'], 'G1'));
    expect(playKnock).toHaveBeenCalledTimes(2);
  });

  it('does not knock for channels, my own huddles, bigger huddles or when disabled', () => {
    huddleStateChanged(state(['U2'], 'C1'));
    huddleStateChanged(state(['U5'], 'D1'));
    huddleStateChanged(state(['U2', 'U3'], 'D1'));
    huddleStateChanged(state(['U2'], 'X404'));
    resetStore({ me: makeMe({ id: 'U5', prefs: { notifyHuddles: false } }), channels: { D1: makeChannel({ id: 'D1', kind: 'dm' }) } });
    huddleStateChanged(state(['U2'], 'D1'));
    expect(playKnock).not.toHaveBeenCalled();
  });

  it('connects to new participants and drops those who left', async () => {
    await joined();
    huddleStateChanged(state(['U5', 'U2', 'U7']));
    expect(FakePC.all).toHaveLength(2);
    expect(FakePC.all[0].config).toEqual({ iceServers: [{ urls: 'stun:stun.example.com' }] });
    expect(FakePC.all[0].addTrack).toHaveBeenCalledWith(mic.tracks[0], mic);
    // peers are told which streams are camera/screen
    expect(signals()).toContainEqual({ to: 'U2', channelId: 'C1', data: { streams: {} } });

    huddleStateChanged(state(['U5', 'U2', 'U7'])); // idempotent
    expect(FakePC.all).toHaveLength(2);

    huddleStateChanged(state(['U5', 'U2']));
    expect(FakePC.all[1].close).toHaveBeenCalled();
    expect(FakePC.all[0].close).not.toHaveBeenCalled();
  });

  it('ignores states that do not include me', async () => {
    await joined();
    huddleStateChanged(state(['U2']));
    expect(FakePC.all).toHaveLength(0);
  });

  it('huddleEnded cleans up only the current huddle', async () => {
    await joined();
    huddleStateChanged(state(['U5', 'U2']));
    huddleEnded('OTHER');
    expect(useHuddle.getState().channelId).toBe('C1');
    huddleEnded('C1');
    expect(useHuddle.getState().channelId).toBeNull();
    expect(FakePC.all[0].close).toHaveBeenCalled();
  });
});

describe('peer connection', () => {
  beforeEach(async () => {
    await joined();
    huddleStateChanged(state(['U5', 'U2']));
    vi.mocked(sock.emit).mockClear();
  });

  it('sends offers on negotiation and ICE candidates', async () => {
    const pc = lastPc();
    await pc.onnegotiationneeded!();
    expect(signals()).toContainEqual({ to: 'U2', channelId: 'C1', data: { description: { type: 'offer', sdp: 'local' } } });
    pc.onicecandidate!({ candidate: { candidate: 'c1' } });
    pc.onicecandidate!({ candidate: null });
    expect(signals().filter((s) => s.data.candidate)).toHaveLength(1);
  });

  it('logs negotiation failures', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    lastPc().setLocalDescription.mockRejectedValueOnce(new Error('bad state'));
    await lastPc().onnegotiationneeded!();
    expect(warn).toHaveBeenCalledWith('negotiation failed', expect.any(Error));
  });

  it('restarts ICE when the connection fails', () => {
    const pc = lastPc();
    pc.connectionState = 'connected';
    pc.onconnectionstatechange!();
    pc.connectionState = 'failed';
    pc.onconnectionstatechange!();
    expect(pc.restartIce).toHaveBeenCalledTimes(1);
  });

  it('plays remote audio', () => {
    const stream = new FakeStream([new FakeTrack('audio')]);
    lastPc().ontrack!({ track: stream.tracks[0], streams: [stream] });
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });

  it('places remote video once the peer announces its kind', async () => {
    const pc = lastPc();
    const cam = new FakeStream([new FakeTrack('video')]);
    pc.ontrack!({ track: cam.tracks[0], streams: [cam] });
    expect(useHuddle.getState().cameras).toEqual({});
    await huddleSignal({ from: 'U2', channelId: 'C1', data: { streams: { [cam.id]: 'camera' } } });
    expect(useHuddle.getState().cameras.U2).toBe(cam);

    const screen = new FakeStream([new FakeTrack('video')]);
    await huddleSignal({ from: 'U2', channelId: 'C1', data: { streams: { [cam.id]: 'camera', [screen.id]: 'screen' } } });
    pc.ontrack!({ track: screen.tracks[0], streams: [screen] });
    expect(useHuddle.getState()).toMatchObject({ windowOpen: true, expanded: true });
    expect(useHuddle.getState().screens.U2).toBe(screen);

    // muted / ended tracks hide the video, unmute shows it again
    screen.tracks[0].onmute!();
    expect(useHuddle.getState().screens.U2).toBeUndefined();
    screen.tracks[0].onunmute!();
    expect(useHuddle.getState().screens.U2).toBe(screen);

    // streams that are no longer announced were turned off
    await huddleSignal({ from: 'U2', channelId: 'C1', data: { streams: {} } });
    expect(useHuddle.getState().cameras.U2).toBeUndefined();
    expect(useHuddle.getState().screens.U2).toBeUndefined();
  });

  it('ignores ended tracks of unknown streams and wraps stream-less tracks', () => {
    const track = new FakeTrack('video');
    lastPc().ontrack!({ track, streams: [] });
    expect(() => track.onended!()).not.toThrow();
  });

  it('answers offers', async () => {
    const pc = lastPc();
    await huddleSignal({ from: 'U2', channelId: 'C1', data: { description: { type: 'offer', sdp: 'remote' } } });
    expect(pc.setRemoteDescription).toHaveBeenCalledWith({ type: 'offer', sdp: 'remote' });
    expect(signals()).toContainEqual({ to: 'U2', channelId: 'C1', data: { description: { type: 'answer', sdp: 'local' } } });
  });

  it('applies answers without replying', async () => {
    const pc = lastPc();
    await pc.onnegotiationneeded!();
    vi.mocked(sock.emit).mockClear();
    await huddleSignal({ from: 'U2', channelId: 'C1', data: { description: { type: 'answer', sdp: 'r' } } });
    expect(pc.setRemoteDescription).toHaveBeenCalled();
    expect(signals()).toEqual([]);
  });

  it('the impolite peer ignores colliding offers', async () => {
    // "U5" > "U2" → I am polite towards U2; create an impolite pair with a higher id
    huddleStateChanged(state(['U5', 'U9']));
    const pc = lastPc();
    pc.signalingState = 'have-local-offer';
    await huddleSignal({ from: 'U9', channelId: 'C1', data: { description: { type: 'offer', sdp: 'x' } } });
    expect(pc.setRemoteDescription).not.toHaveBeenCalled();
    // candidates for the ignored offer may fail silently
    pc.addIceCandidate.mockRejectedValueOnce(new Error('no remote description'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await huddleSignal({ from: 'U9', channelId: 'C1', data: { candidate: { candidate: 'c' } } });
    expect(warn).not.toHaveBeenCalled();
  });

  it('the polite peer accepts colliding offers', async () => {
    const pc = lastPc(); // U5 vs U2 → polite
    pc.signalingState = 'have-local-offer';
    await huddleSignal({ from: 'U2', channelId: 'C1', data: { description: { type: 'offer', sdp: 'x' } } });
    expect(pc.setRemoteDescription).toHaveBeenCalled();
  });

  it('adds ICE candidates and logs real failures', async () => {
    const pc = lastPc();
    await huddleSignal({ from: 'U2', channelId: 'C1', data: { candidate: { candidate: 'c' } } });
    expect(pc.addIceCandidate).toHaveBeenCalledWith({ candidate: 'c' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    pc.addIceCandidate.mockRejectedValueOnce(new Error('boom'));
    await huddleSignal({ from: 'U2', channelId: 'C1', data: { candidate: { candidate: 'c' } } });
    expect(warn).toHaveBeenCalledWith('signal error', expect.any(Error));
  });

  it('ignores signals for other huddles and empty payloads', async () => {
    const before = FakePC.all.length;
    await huddleSignal({ from: 'U8', channelId: 'OTHER', data: { candidate: {} } });
    expect(FakePC.all).toHaveLength(before);
    await huddleSignal({ from: 'U2', channelId: 'C1', data: null });
    expect(lastPc().addIceCandidate).not.toHaveBeenCalled();
  });

  it('creates a peer for signals from unknown participants', async () => {
    await huddleSignal({ from: 'U3', channelId: 'C1', data: { candidate: { candidate: 'c' } } });
    expect(FakePC.all).toHaveLength(2);
  });
});

describe('media controls', () => {
  beforeEach(async () => {
    await joined();
    huddleStateChanged(state(['U5', 'U2']));
    vi.mocked(sock.emit).mockClear();
  });

  it('toggleMute disables the mic and reports it', () => {
    toggleMute();
    expect(mic.tracks[0].enabled).toBe(false);
    expect(useHuddle.getState().muted).toBe(true);
    expect(sock.emit).toHaveBeenCalledWith('huddle:media', { channelId: 'C1', muted: true, sharing: false, video: false });
    toggleMute();
    expect(mic.tracks[0].enabled).toBe(true);
  });

  it('toggleCamera adds and removes the camera track for every peer', async () => {
    await toggleCamera();
    expect(getUserMedia).toHaveBeenLastCalledWith({ video: { width: 640, height: 360, deviceId: { ideal: 'cam-1' } }, audio: false });
    const cam = useHuddle.getState().localCamera as unknown as FakeStream;
    expect(useHuddle.getState()).toMatchObject({ camera: true, windowOpen: true });
    expect(lastPc().addTrack).toHaveBeenCalledWith(cam.tracks[0], cam);
    expect(signals()).toContainEqual({ to: 'U2', channelId: 'C1', data: { streams: { [cam.id]: 'camera' } } });
    expect(sock.emit).toHaveBeenCalledWith('huddle:media', { channelId: 'C1', muted: false, sharing: false, video: true });

    // new peers get the camera right away
    huddleStateChanged(state(['U5', 'U2', 'U3']));
    expect(lastPc().addTrack).toHaveBeenCalledWith(cam.tracks[0], cam);

    lastPc().removeTrack.mockImplementationOnce(() => {
      throw new Error('closed');
    });
    await toggleCamera();
    expect(FakePC.all[0].removeTrack).toHaveBeenCalled();
    expect(cam.tracks[0].stop).toHaveBeenCalled();
    expect(useHuddle.getState()).toMatchObject({ camera: false, localCamera: null });
  });

  it('toggleCamera shows an error without camera access', async () => {
    getUserMedia.mockRejectedValueOnce(new Error('denied'));
    await toggleCamera();
    expect(useHuddle.getState().camera).toBe(false);
    expect(S().toasts.at(-1)?.text).toBe('Camera access is needed to turn on video.');
  });

  it('toggleScreenShare starts and stops sharing', async () => {
    await toggleScreenShare();
    const scr = useHuddle.getState().localScreen as unknown as FakeStream;
    expect(getDisplayMedia).toHaveBeenCalledWith({ video: { frameRate: 15 }, audio: false });
    expect(useHuddle.getState().sharing).toBe(true);
    expect(lastPc().addTrack).toHaveBeenCalledWith(scr.tracks[0], scr);

    huddleStateChanged(state(['U5', 'U2', 'U3']));
    expect(lastPc().addTrack).toHaveBeenCalledWith(scr.tracks[0], scr);

    FakePC.all[0].removeTrack.mockImplementationOnce(() => {
      throw new Error('closed');
    });
    await toggleScreenShare();
    expect(scr.tracks[0].stop).toHaveBeenCalled();
    expect(useHuddle.getState()).toMatchObject({ sharing: false, localScreen: null });
  });

  it('stops sharing when the browser ends the capture', async () => {
    await toggleScreenShare();
    const scr = useHuddle.getState().localScreen as unknown as FakeStream;
    scr.tracks[0].onended!();
    expect(useHuddle.getState().sharing).toBe(false);
  });

  it('does nothing when the screen picker is cancelled', async () => {
    getDisplayMedia.mockRejectedValueOnce(new Error('cancelled'));
    await toggleScreenShare();
    expect(useHuddle.getState().sharing).toBe(false);
  });

  it('does not report media outside a huddle', () => {
    leaveHuddle();
    vi.mocked(sock.emit).mockClear();
    toggleMute();
    expect(sock.emit).not.toHaveBeenCalled();
  });
});

describe('speaking indicator', () => {
  it('measures audio levels every 200ms and never shows me speaking while muted', async () => {
    vi.useFakeTimers();
    let loud = true;
    vi.spyOn(AudioContext.prototype as any, 'createAnalyser').mockImplementation(() => ({
      fftSize: 0,
      getByteTimeDomainData: (buf: Uint8Array) => buf.forEach((_, i) => (buf[i] = loud ? (i % 2 ? 255 : 0) : 128)),
    }));
    await joined();
    vi.advanceTimersByTime(200);
    expect(useHuddle.getState().speaking).toEqual({ U5: true });
    loud = false;
    vi.advanceTimersByTime(200);
    expect(useHuddle.getState().speaking).toEqual({ U5: false });
    loud = true;
    toggleMute();
    vi.advanceTimersByTime(200);
    expect(useHuddle.getState().speaking).toEqual({ U5: false });
  });

  it('survives audio analysis being unavailable', async () => {
    vi.spyOn(AudioContext.prototype as any, 'createMediaStreamSource').mockImplementation(() => {
      throw new Error('unsupported');
    });
    await expect(joined()).resolves.toBeUndefined();
  });
});

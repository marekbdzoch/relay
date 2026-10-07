import { create } from 'zustand';
import type { HuddleState } from '../../../shared/types.ts';
import { S, toast } from '../store.ts';
import { socket } from '../socket.ts';
import { t } from '../i18n.ts';
import { playKnock } from './notify.ts';

/**
 * Huddles: audio/video calls with screen sharing (Slack's huddles).
 * Small groups use a WebRTC mesh; the server only relays signalling messages.
 * Uses the "perfect negotiation" pattern so either side may (re)negotiate.
 * Camera and screen are sent as separate MediaStreams; peers tell each other which stream id is which.
 */

interface Peer {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  audio: HTMLAudioElement;
  screenSender?: RTCRtpSender;
  cameraSender?: RTCRtpSender;
  streamKinds: Record<string, 'camera' | 'screen'>;
  pendingStreams: Record<string, MediaStream>;
}

interface HuddleUI {
  channelId: string | null;
  muted: boolean;
  sharing: boolean;
  camera: boolean;
  connecting: boolean;
  speaking: Record<string, boolean>;
  screens: Record<string, MediaStream>; // remote screen shares by user
  cameras: Record<string, MediaStream>; // remote cameras by user
  localScreen: MediaStream | null;
  localCamera: MediaStream | null;
  windowOpen: boolean;
  expanded: boolean;
}

export const useHuddle = create<HuddleUI>(() => ({
  channelId: null,
  muted: false,
  sharing: false,
  camera: false,
  connecting: false,
  speaking: {},
  screens: {},
  cameras: {},
  localScreen: null,
  localCamera: null,
  windowOpen: false,
  expanded: false,
}));

const peers = new Map<string, Peer>();
let localStream: MediaStream | null = null;
let screenStream: MediaStream | null = null;
let cameraStream: MediaStream | null = null;
let audioCtx: AudioContext | null = null;
const analysers = new Map<string, AnalyserNode>();
let meterTimer: ReturnType<typeof setInterval> | null = null;

const myId = () => S().me?.id ?? '';

function signal(to: string, data: unknown) {
  const channelId = useHuddle.getState().channelId;
  if (channelId) socket?.emit('huddle:signal', { to, channelId, data });
}

function announceStreams(to?: string) {
  const kinds: Record<string, 'camera' | 'screen'> = {};
  if (cameraStream) kinds[cameraStream.id] = 'camera';
  if (screenStream) kinds[screenStream.id] = 'screen';
  for (const id of to ? [to] : [...peers.keys()]) signal(id, { streams: kinds });
}

function watchLevel(userId: string, stream: MediaStream) {
  try {
    audioCtx ??= new AudioContext();
    const src = audioCtx.createMediaStreamSource(stream);
    const an = audioCtx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    analysers.set(userId, an);
  } catch {
    /* ignore */
  }
  if (!meterTimer) {
    const buf = new Uint8Array(256);
    meterTimer = setInterval(() => {
      const speaking: Record<string, boolean> = {};
      for (const [uid, an] of analysers) {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += (v - 128) ** 2;
        speaking[uid] = Math.sqrt(sum / buf.length) > 6;
      }
      if (useHuddle.getState().muted) speaking[myId()] = false;
      useHuddle.setState({ speaking });
    }, 200);
  }
}

function setRemoteVideo(remoteId: string, kind: 'camera' | 'screen', stream: MediaStream | null) {
  useHuddle.setState((s) => {
    const key = kind === 'camera' ? 'cameras' : 'screens';
    const next = { ...s[key] };
    if (stream) next[remoteId] = stream;
    else delete next[remoteId];
    return kind === 'camera' ? { cameras: next } : { screens: next, ...(stream ? { windowOpen: true, expanded: true } : {}) };
  });
}

function createPeer(remoteId: string): Peer {
  const existing = peers.get(remoteId);
  if (existing) return existing;
  const pc = new RTCPeerConnection({ iceServers: (S().workspace?.iceServers ?? []) as RTCIceServer[] });
  const audio = new Audio();
  audio.autoplay = true;
  const peer: Peer = { pc, polite: myId() > remoteId, makingOffer: false, ignoreOffer: false, audio, streamKinds: {}, pendingStreams: {} };
  peers.set(remoteId, peer);

  localStream?.getTracks().forEach((tr) => pc.addTrack(tr, localStream!));
  const cam = cameraStream?.getVideoTracks()[0];
  if (cam) peer.cameraSender = pc.addTrack(cam, cameraStream!);
  const scr = screenStream?.getVideoTracks()[0];
  if (scr) peer.screenSender = pc.addTrack(scr, screenStream!);
  announceStreams(remoteId);

  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      signal(remoteId, { description: pc.localDescription });
    } catch (e) {
      console.warn('negotiation failed', e);
    } finally {
      peer.makingOffer = false;
    }
  };
  pc.onicecandidate = ({ candidate }) => candidate && signal(remoteId, { candidate });
  pc.ontrack = ({ track, streams }) => {
    const stream = streams[0] ?? new MediaStream([track]);
    if (track.kind === 'audio') {
      audio.srcObject = stream;
      void audio.play().catch(() => {});
      watchLevel(remoteId, stream);
      return;
    }
    const place = () => {
      const kind = peer.streamKinds[stream.id];
      if (!kind) {
        peer.pendingStreams[stream.id] = stream; // wait until the peer tells us what it is
        return;
      }
      setRemoteVideo(remoteId, kind, stream);
    };
    place();
    track.onended = track.onmute = () => {
      const kind = peer.streamKinds[stream.id];
      if (kind) setRemoteVideo(remoteId, kind, null);
    };
    track.onunmute = place;
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') pc.restartIce();
  };
  return peer;
}

function closePeer(remoteId: string) {
  const p = peers.get(remoteId);
  if (!p) return;
  p.pc.close();
  p.audio.srcObject = null;
  peers.delete(remoteId);
  analysers.delete(remoteId);
  setRemoteVideo(remoteId, 'camera', null);
  setRemoteVideo(remoteId, 'screen', null);
}

export async function huddleSignal(p: { from: string; channelId: string; data: any }) {
  if (p.channelId !== useHuddle.getState().channelId) return;
  const peer = createPeer(p.from);
  const { pc } = peer;
  const { description, candidate, streams } = p.data ?? {};
  try {
    if (streams) {
      peer.streamKinds = streams;
      for (const [id, stream] of Object.entries(peer.pendingStreams)) {
        const kind = streams[id];
        if (kind) {
          setRemoteVideo(p.from, kind, stream);
          delete peer.pendingStreams[id];
        }
      }
      // streams that are no longer announced were turned off
      const st = useHuddle.getState();
      if (st.cameras[p.from] && !streams[st.cameras[p.from].id]) setRemoteVideo(p.from, 'camera', null);
      if (st.screens[p.from] && !streams[st.screens[p.from].id]) setRemoteVideo(p.from, 'screen', null);
    } else if (description) {
      const collision = description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
      peer.ignoreOffer = !peer.polite && collision;
      if (peer.ignoreOffer) return;
      await pc.setRemoteDescription(description);
      if (description.type === 'offer') {
        await pc.setLocalDescription();
        signal(p.from, { description: pc.localDescription });
      }
    } else if (candidate) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (e) {
        if (!peer.ignoreOffer) throw e;
      }
    }
  } catch (e) {
    console.warn('signal error', e);
  }
}

export function huddleStateChanged(h: HuddleState) {
  const ui = useHuddle.getState();
  const me = myId();
  if (ui.channelId !== h.channelId) {
    // somebody started a huddle in a DM -> knock
    const ch = S().channels[h.channelId];
    if (h.participants.length === 1 && h.participants[0].userId !== me && (ch?.kind === 'dm' || ch?.kind === 'group') && S().me?.prefs.notifyHuddles !== false) playKnock();
    return;
  }
  const ids = new Set(h.participants.map((p) => p.userId));
  if (!ids.has(me)) return;
  for (const p of h.participants) if (p.userId !== me) createPeer(p.userId);
  for (const id of [...peers.keys()]) if (!ids.has(id)) closePeer(id);
}

export function huddleEnded(channelId: string) {
  if (useHuddle.getState().channelId === channelId) cleanup();
}

export async function joinHuddle(channelId: string, withVideo = false) {
  const ui = useHuddle.getState();
  if (ui.channelId === channelId) return void useHuddle.setState({ windowOpen: true });
  if (ui.channelId) leaveHuddle();
  useHuddle.setState({ connecting: true });
  const prefs = S().me?.prefs;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, deviceId: prefs?.audioInput ? { ideal: prefs.audioInput } : undefined },
      video: false,
    });
  } catch {
    useHuddle.setState({ connecting: false });
    toast(t('Microphone access is needed to join a huddle.'), 'error');
    return;
  }
  watchLevel(myId(), localStream);
  useHuddle.setState({ channelId, muted: false, sharing: false, camera: false, connecting: false, windowOpen: true });
  socket?.emit('huddle:join', { channelId }, (r) => {
    if (!r?.ok) {
      toast(t('Could not join the huddle.'), 'error');
      cleanup();
    } else if (withVideo) void toggleCamera();
  });
}

function cleanup() {
  for (const id of [...peers.keys()]) closePeer(id);
  for (const s of [localStream, screenStream, cameraStream]) s?.getTracks().forEach((tr) => tr.stop());
  localStream = null;
  screenStream = null;
  cameraStream = null;
  analysers.clear();
  if (meterTimer) clearInterval(meterTimer);
  meterTimer = null;
  useHuddle.setState({
    channelId: null,
    muted: false,
    sharing: false,
    camera: false,
    speaking: {},
    screens: {},
    cameras: {},
    localScreen: null,
    localCamera: null,
    windowOpen: false,
    expanded: false,
    connecting: false,
  });
}

/**
 * After the socket reconnects (network blip, server restart) the server no longer knows we are in the call.
 * Rejoin with fresh peer connections so voice rooms survive a flaky connection, like Discord.
 */
export function rejoinHuddle() {
  const { channelId } = useHuddle.getState();
  if (!channelId || !localStream) return;
  for (const id of [...peers.keys()]) closePeer(id);
  socket?.emit('huddle:leave', { channelId });
  socket?.emit('huddle:join', { channelId }, (r) => {
    if (!r?.ok) {
      toast(t('Could not join the huddle.'), 'error');
      cleanup();
    } else reportMedia();
  });
}

export function leaveHuddle() {
  const channelId = useHuddle.getState().channelId;
  if (channelId) socket?.emit('huddle:leave', { channelId });
  cleanup();
}

function reportMedia() {
  const { channelId, muted, sharing, camera } = useHuddle.getState();
  if (channelId) socket?.emit('huddle:media', { channelId, muted, sharing, video: camera });
}

export function toggleMute() {
  const muted = !useHuddle.getState().muted;
  localStream?.getAudioTracks().forEach((tr) => (tr.enabled = !muted));
  useHuddle.setState({ muted });
  reportMedia();
}

export async function toggleCamera() {
  if (useHuddle.getState().camera) {
    for (const peer of peers.values()) {
      if (peer.cameraSender) {
        try {
          peer.pc.removeTrack(peer.cameraSender);
        } catch {
          /* ignore */
        }
        peer.cameraSender = undefined;
      }
    }
    cameraStream?.getTracks().forEach((tr) => tr.stop());
    cameraStream = null;
    useHuddle.setState({ camera: false, localCamera: null });
    announceStreams();
    reportMedia();
    return;
  }
  const pref = S().me?.prefs.videoInput;
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 360, deviceId: pref ? { ideal: pref } : undefined }, audio: false });
  } catch {
    toast(t('Camera access is needed to turn on video.'), 'error');
    return;
  }
  const track = cameraStream.getVideoTracks()[0];
  announceStreams();
  for (const peer of peers.values()) peer.cameraSender = peer.pc.addTrack(track, cameraStream);
  useHuddle.setState({ camera: true, localCamera: cameraStream, windowOpen: true });
  reportMedia();
}

export async function toggleScreenShare() {
  if (useHuddle.getState().sharing) return stopScreenShare();
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
  } catch {
    return;
  }
  const track = screenStream.getVideoTracks()[0];
  track.onended = () => stopScreenShare();
  announceStreams();
  for (const peer of peers.values()) peer.screenSender = peer.pc.addTrack(track, screenStream);
  useHuddle.setState({ sharing: true, localScreen: screenStream });
  reportMedia();
}

function stopScreenShare() {
  for (const peer of peers.values()) {
    if (peer.screenSender) {
      try {
        peer.pc.removeTrack(peer.screenSender);
      } catch {
        /* ignore */
      }
      peer.screenSender = undefined;
    }
  }
  screenStream?.getTracks().forEach((tr) => tr.stop());
  screenStream = null;
  useHuddle.setState({ sharing: false, localScreen: null });
  announceStreams();
  reportMedia();
}

window.addEventListener('beforeunload', () => {
  if (useHuddle.getState().channelId) leaveHuddle();
});

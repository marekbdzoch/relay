import { useEffect, useRef } from 'react';
import type { Channel } from '../../../shared/types.ts';
import { ChevronDown, Headphones, Maximize2, Mic, MicOff, Minimize2, MonitorUp, PhoneOff, PictureInPicture2, Video, VideoOff, Volume2 } from './icons.tsx';
import { channelTitle, isDmKind, useStore, userName } from '../store.ts';
import { t } from '../i18n.ts';
import { joinHuddle, leaveHuddle, toggleCamera, toggleMute, toggleScreenShare, useHuddle } from '../lib/huddle.ts';
import { Avatar, Menu, MenuItem, Popover, Tip, usePopover } from './ui.tsx';

/** Channels have a permanent, Discord-style voice room; DMs keep ad-hoc huddle calls. */
export function isVoiceRoom(channel: Channel | undefined) {
  return !!channel && !isDmKind(channel);
}

function callTitle(channel: Channel | undefined) {
  if (!channel) return '';
  return isDmKind(channel) ? channelTitle(channel) : `${t('Voice room')} · #${channel.name}`;
}

function Controls({ compact }: { compact?: boolean }) {
  const callId = useHuddle((s) => s.channelId);
  const room = useStore((s) => isVoiceRoom(callId ? s.channels[callId] : undefined));
  const muted = useHuddle((s) => s.muted);
  const sharing = useHuddle((s) => s.sharing);
  const camera = useHuddle((s) => s.camera);
  return (
    <div className="huddle-controls">
      <button className={`huddle-btn${muted ? ' off' : ''}`} onClick={toggleMute} title={muted ? t('Unmute') : t('Mute')}>
        {muted ? <MicOff size={16} /> : <Mic size={16} />}
      </button>
      <button className={`huddle-btn${camera ? ' on' : ''}`} onClick={() => void toggleCamera()} title={camera ? t('Turn off video') : t('Turn on video')}>
        {camera ? <Video size={16} /> : <VideoOff size={16} />}
      </button>
      <button className={`huddle-btn${sharing ? ' on' : ''}`} onClick={() => void toggleScreenShare()} title={sharing ? t('Stop sharing') : t('Share screen')}>
        <MonitorUp size={16} />
      </button>
      {compact && (
        <button className="huddle-btn" onClick={() => useHuddle.setState({ windowOpen: true })} title={t('Open huddle window')}>
          <PictureInPicture2 size={16} />
        </button>
      )}
      <button className="huddle-btn leave" onClick={leaveHuddle} title={room ? t('Disconnect') : t('Leave')}>
        <PhoneOff size={16} />
        {!compact && <span>{room ? t('Disconnect') : t('Leave')}</span>}
      </button>
    </div>
  );
}

export function HuddleBar() {
  const channelId = useHuddle((s) => s.channelId);
  const speaking = useHuddle((s) => s.speaking);
  const huddle = useStore((s) => (channelId ? s.huddles[channelId] : undefined));
  const channel = useStore((s) => (channelId ? s.channels[channelId] : undefined));
  if (!channelId) return null;
  const participants = huddle?.participants ?? [];
  return (
    <div className="huddle-bar">
      <div className="huddle-bar-head">
        {isVoiceRoom(channel) ? <Volume2 size={14} /> : <Headphones size={14} />}
        <span className="huddle-bar-title">{callTitle(channel)}</span>
        <span className="huddle-bar-count">{participants.length}</span>
      </div>
      <div className="huddle-people">
        {participants.map((p) => (
          <Tip key={p.userId} label={userName(p.userId) + (p.muted ? ` (${t('muted')})` : '')}>
            <span className={`huddle-person${speaking[p.userId] ? ' speaking' : ''}`}>
              <Avatar userId={p.userId} size={28} />
              {p.muted && (
                <span className="huddle-muted">
                  <MicOff size={10} />
                </span>
              )}
            </span>
          </Tip>
        ))}
      </div>
      <Controls compact />
    </div>
  );
}

function Video_({ stream, muted, mirror }: { stream: MediaStream; muted?: boolean; mirror?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} autoPlay playsInline muted={muted} className={mirror ? 'mirror' : ''} />;
}

/** Floating huddle window: participant tiles (camera or avatar), screen shares, controls. */
export function HuddleScreens() {
  const channelId = useHuddle((s) => s.channelId);
  const open = useHuddle((s) => s.windowOpen);
  const expanded = useHuddle((s) => s.expanded);
  const screens = useHuddle((s) => s.screens);
  const cameras = useHuddle((s) => s.cameras);
  const localScreen = useHuddle((s) => s.localScreen);
  const localCamera = useHuddle((s) => s.localCamera);
  const speaking = useHuddle((s) => s.speaking);
  const meId = useStore((s) => s.me?.id);
  const huddle = useStore((s) => (channelId ? s.huddles[channelId] : undefined));
  const channel = useStore((s) => (channelId ? s.channels[channelId] : undefined));
  if (!channelId || !open) return null;
  const participants = huddle?.participants ?? (meId ? [{ userId: meId, muted: false, sharing: false, video: false }] : []);
  const screenEntries = Object.entries(screens);
  const mainScreen = screenEntries[0]?.[1] ?? localScreen;
  return (
    <div className={`huddle-window${expanded ? ' expanded' : ''}`}>
      <div className="huddle-window-head">
        {isVoiceRoom(channel) ? <Volume2 size={15} /> : <Headphones size={15} />}
        <span className="huddle-window-title">{callTitle(channel)}</span>
        <button className="icon-btn" onClick={() => useHuddle.setState({ expanded: !expanded })} title={expanded ? t('Minimize') : t('Expand')}>
          {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
        <button className="icon-btn" onClick={() => useHuddle.setState({ windowOpen: false })} title={t('Hide')}>
          <ChevronDown size={16} />
        </button>
      </div>
      {mainScreen && (
        <div className="huddle-stage">
          <Video_ stream={mainScreen} muted />
          <span className="huddle-stage-label">{screenEntries.length ? t('{name} is sharing their screen', { name: userName(screenEntries[0][0]) }) : t('You are sharing your screen')}</span>
        </div>
      )}
      <div className={`huddle-tiles n${Math.min(participants.length, 4)}`}>
        {participants.map((p) => {
          const cam = p.userId === meId ? localCamera : cameras[p.userId];
          return (
            <div key={p.userId} className={`huddle-tile${speaking[p.userId] ? ' speaking' : ''}`}>
              {cam ? <Video_ stream={cam} muted mirror={p.userId === meId} /> : <Avatar userId={p.userId} size={64} />}
              <span className="huddle-tile-name">
                {p.muted && <MicOff size={11} />} {p.userId === meId ? t('You') : userName(p.userId)}
              </span>
            </div>
          );
        })}
      </div>
      <Controls />
    </div>
  );
}

/** Button in the channel header: the channel's voice room, or a huddle call in DMs (with an audio/video choice). */
export function HuddleButton({ channelId }: { channelId: string }) {
  const active = useStore((s) => s.huddles[channelId]);
  const room = useStore((s) => isVoiceRoom(s.channels[channelId]));
  const mine = useHuddle((s) => s.channelId === channelId);
  const connecting = useHuddle((s) => s.connecting);
  const menu = usePopover<HTMLButtonElement>();
  const people = active?.participants ?? [];
  if (mine) {
    return (
      <button className="huddle-header-btn in" onClick={leaveHuddle}>
        <PhoneOff size={16} />
        <span>{room ? t('Disconnect') : t('Leave')}</span>
      </button>
    );
  }
  if (!room && people.length > 0) {
    return (
      <button className="huddle-header-btn live" onClick={() => void joinHuddle(channelId)} disabled={connecting} title={t('Join huddle')}>
        <Headphones size={16} />
        <span>{t('Join')}</span>
        <Faces people={people} />
      </button>
    );
  }
  const live = people.length > 0;
  return (
    <span className="huddle-split">
      <button
        className={`huddle-header-btn split-main${live ? ' live' : ''}`}
        onClick={() => void joinHuddle(channelId)}
        disabled={connecting}
        title={room ? t('Join voice room') : t('Start a huddle')}
      >
        {room ? <Volume2 size={16} /> : <Headphones size={16} />}
        {room && <span>{live ? t('Join') : t('Voice room')}</span>}
        {live && <Faces people={people} />}
      </button>
      <button className={`huddle-header-btn split-more${live ? ' live' : ''}`} ref={menu.ref} onClick={menu.toggle} aria-label={room ? t('Voice room options') : t('Huddle options')}>
        <ChevronDown size={13} />
      </button>
      {menu.open && (
        <Popover anchor={menu.ref.current} onClose={menu.close} placement="bottom-end">
          <Menu>
            <MenuItem icon={<Headphones size={15} />} onClick={() => (menu.close(), void joinHuddle(channelId))}>
              {room ? t('Join voice room') : t('Start audio huddle')}
            </MenuItem>
            <MenuItem icon={<Video size={15} />} onClick={() => (menu.close(), void joinHuddle(channelId, true))}>
              {room ? t('Join with video') : t('Start video huddle')}
            </MenuItem>
          </Menu>
        </Popover>
      )}
    </span>
  );
}

function Faces({ people }: { people: { userId: string }[] }) {
  return (
    <span className="huddle-header-faces">
      {people.slice(0, 3).map((p) => (
        <Avatar key={p.userId} userId={p.userId} size={18} />
      ))}
      {people.length > 3 && <span className="huddle-header-more">+{people.length - 3}</span>}
    </span>
  );
}

/** Discord-style list of who is in a channel's voice room, shown under the channel in the sidebar. */
export function VoiceRoomMembers({ channelId }: { channelId: string }) {
  const people = useStore((s) => s.huddles[channelId]?.participants);
  const mine = useHuddle((s) => s.channelId === channelId);
  const speaking = useHuddle((s) => s.speaking);
  if (!people?.length) return null;
  return (
    <div className="sb-voice" role="list" aria-label={t('Voice room')}>
      {people.map((p) => (
        <div key={p.userId} role="listitem" className={`sb-voice-person${mine && speaking[p.userId] ? ' speaking' : ''}`}>
          <Avatar userId={p.userId} size={20} />
          <span className="sb-voice-name">{userName(p.userId)}</span>
          {p.video && <Video size={12} />}
          {p.sharing && <MonitorUp size={12} />}
          {p.muted && <MicOff size={12} className="sb-voice-muted" />}
        </div>
      ))}
    </div>
  );
}

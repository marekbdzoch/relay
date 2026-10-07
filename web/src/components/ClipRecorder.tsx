import { useEffect, useRef, useState } from 'react';
import { Circle, Square, Trash2, Send } from './icons.tsx';
import { t } from '../i18n.ts';
import { toast } from '../store.ts';
import { Popover } from './ui.tsx';

/** Records an audio or video clip (Slack "clips") and hands it back as a File. */
export function ClipRecorder({ kind, anchor, onClose, onDone }: { kind: 'audio' | 'video'; anchor: HTMLElement | null; onClose: () => void; onDone: (f: File) => void }) {
  const [state, setState] = useState<'starting' | 'recording' | 'done'>('starting');
  const [seconds, setSeconds] = useState(0);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const file = useRef<File | null>(null);
  const live = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia(kind === 'video' ? { audio: true, video: { width: 1280, height: 720 } } : { audio: true });
        if (cancelled) return s.getTracks().forEach((tr) => tr.stop());
        stream.current = s;
        if (live.current) live.current.srcObject = s;
        const mime = kind === 'video' ? (MediaRecorder.isTypeSupported('video/webm') ? 'video/webm' : 'video/mp4') : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4';
        const rec = new MediaRecorder(s, { mimeType: mime });
        recorder.current = rec;
        rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
        rec.onstop = () => {
          const blob = new Blob(chunks.current, { type: mime });
          const ext = mime.includes('webm') ? 'webm' : 'mp4';
          const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-');
          file.current = new File([blob], `${kind === 'video' ? t('Video clip') : t('Audio clip')} ${stamp}.${ext}`, { type: mime });
          setBlobUrl(URL.createObjectURL(blob));
          setState('done');
          s.getTracks().forEach((tr) => tr.stop());
        };
        rec.start(250);
        setState('recording');
      } catch {
        toast(kind === 'video' ? t('Camera access is needed to record a clip.') : t('Microphone access is needed to record a clip.'), 'error');
        onClose();
      }
    })();
    return () => {
      cancelled = true;
      if (recorder.current?.state === 'recording') recorder.current.stop();
      stream.current?.getTracks().forEach((tr) => tr.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (state !== 'recording') return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [state]);

  useEffect(() => () => void (blobUrl && URL.revokeObjectURL(blobUrl)), [blobUrl]);

  const mmss = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

  return (
    <Popover anchor={anchor} onClose={onClose} placement="top-start" className="clip-popover">
      <div className="clip">
        <div className="clip-title">{kind === 'video' ? t('Record video clip') : t('Record audio clip')}</div>
        {kind === 'video' && state !== 'done' && <video ref={live} className="clip-video" autoPlay muted playsInline />}
        {state === 'done' && blobUrl && (kind === 'video' ? <video className="clip-video" src={blobUrl} controls /> : <audio src={blobUrl} controls className="clip-audio" />)}
        {state === 'recording' && kind === 'audio' && (
          <div className="clip-wave">
            <span className="clip-dot" /> {t('Recording…')}
          </div>
        )}
        <div className="clip-controls">
          <span className="clip-time">{state === 'recording' && <Circle size={10} className="clip-rec" />} {mmss}</span>
          {state === 'recording' && (
            <button className="btn small" onClick={() => recorder.current?.stop()}>
              <Square size={12} /> {t('Stop')}
            </button>
          )}
          {state === 'done' && (
            <>
              <button className="btn small" onClick={onClose}>
                <Trash2 size={12} /> {t('Discard')}
              </button>
              <button
                className="btn small primary"
                onClick={() => {
                  if (file.current) onDone(file.current);
                  onClose();
                }}
              >
                <Send size={12} /> {t('Attach')}
              </button>
            </>
          )}
        </div>
      </div>
    </Popover>
  );
}

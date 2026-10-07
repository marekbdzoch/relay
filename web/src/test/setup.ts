import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// ---- jsdom gaps -------------------------------------------------------------

if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
class IntersectionObserverStub {
  root = null;
  rootMargin = '';
  thresholds = [];
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
(globalThis as any).ResizeObserver ??= ResizeObserverStub;
(globalThis as any).IntersectionObserver ??= IntersectionObserverStub;

class AudioParamStub {
  value = 0;
  setValueAtTime() {}
  exponentialRampToValueAtTime() {}
}
class AudioNodeStub {
  frequency = new AudioParamStub();
  gain = new AudioParamStub();
  type = 'sine';
  fftSize = 0;
  connect(n: unknown) {
    return n;
  }
  start() {}
  stop() {}
  getByteTimeDomainData(buf: Uint8Array) {
    buf.fill(128);
  }
}
class AudioContextStub {
  currentTime = 0;
  destination = {};
  createOscillator() {
    return new AudioNodeStub();
  }
  createGain() {
    return new AudioNodeStub();
  }
  createAnalyser() {
    return new AudioNodeStub();
  }
  createMediaStreamSource() {
    return new AudioNodeStub();
  }
}
(globalThis as any).AudioContext ??= AudioContextStub;

class NotificationStub {
  static permission: NotificationPermission = 'default';
  static requestPermission = async () => NotificationStub.permission;
  onclick: (() => void) | null = null;
  constructor(
    public title: string,
    public options?: NotificationOptions,
  ) {}
  close() {}
}
(globalThis as any).Notification ??= NotificationStub;

window.scrollTo = (() => {}) as typeof window.scrollTo;
Element.prototype.scrollIntoView ??= function () {};
Element.prototype.scrollTo ??= function () {} as any;
if (!document.hasFocus) document.hasFocus = () => true;
(globalThis as any).requestAnimationFrame ??= (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0);
(globalThis as any).cancelAnimationFrame ??= (id: number) => clearTimeout(id);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// Navigation bridge so non-component code (store actions, renderers) can change routes.
type NavigateFn = (to: string, opts?: { replace?: boolean }) => void;

let navigateFn: NavigateFn = (to) => {
  window.history.pushState(null, '', to);
};

export function setNavigate(fn: NavigateFn) {
  navigateFn = fn;
}

export function navigate(to: string, opts?: { replace?: boolean }) {
  navigateFn(to, opts);
}

export const channelPath = (channelId: string, messageId?: number) => `/c/${channelId}${messageId ? `/${messageId}` : ''}`;

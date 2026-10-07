# Desktop and mobile apps

Relay has no separate desktop or mobile code base. The web client is responsive and designed to be wrapped in a thin native shell, the same way
Slack's desktop app wraps its web client. This page describes the hooks the client provides and the recommended setups.

There are two ways to build a shell:

| Approach                                       | How it talks to the server             | Use it for                                                               |
| ---------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| **Load the server URL** (recommended)          | Same origin as the server, cookie auth | Electron and other desktop shells, simple mobile WebViews                |
| **Bundle the client and point it at a server** | Cross-origin, bearer token             | Capacitor apps with bundled assets, apps that let the user pick a server |

Native clients (Swift, Kotlin, Flutter, …) can also talk to the REST and Socket.IO API directly. See [api.md](api.md).

## Desktop (Electron)

The simplest and most robust shell loads the deployed server in a `BrowserWindow`. Cookie authentication, notifications, link previews and updates
of the web client work without changes, because the page is served from the server's own origin.

```js
// main.js
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');

const SERVER = process.env.RELAY_URL ?? 'https://chat.example.com';

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.loadURL(SERVER);

  // open external links in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(SERVER)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
}

ipcMain.on('relay:badge', (_event, value) => {
  if (process.platform === 'darwin') app.dock.setBadge(String(value ?? ''));
  else app.setBadgeCount(typeof value === 'number' ? value : value ? 1 : 0);
});

app.whenReady().then(createWindow);
```

### Badge: `window.relayDesktop.setBadge`

The client looks for an optional `window.relayDesktop` object. Whenever unread state changes it calls:

```ts
window.relayDesktop?.setBadge?.(value);
// value: number of mentions, '•' when there are unread messages without mentions, or '' when everything is read
```

Expose it from a preload script with `contextBridge`:

```js
// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('relayDesktop', {
  setBadge: (value) => ipcRenderer.send('relay:badge', value),
});
```

The browser tab title shows the same badge, so the shell can ignore it if it has no dock or taskbar.

### Notifications

The client uses the standard [Web Notifications API](https://developer.mozilla.org/docs/Web/API/Notifications_API). Electron maps it to native
notifications on macOS, Windows and Linux, so no extra code is needed. On Windows, call `app.setAppUserModelId('com.example.relay')` so notifications
show the app name. Clicking a notification focuses the window and opens the conversation. The permission request is triggered when the user
enables desktop notifications in their preferences.

Huddles need camera, microphone and screen capture permissions. Electron grants camera and microphone to the page by default (use
`session.setPermissionRequestHandler` to restrict them). For screen sharing, set a handler with `session.setDisplayMediaRequestHandler` so
`getDisplayMedia()` works. On macOS the app also needs the usual `NSCameraUsageDescription` and `NSMicrophoneUsageDescription` entries.

## Mobile

Below 768 px the client switches to a mobile layout with bottom tabs and list-to-conversation navigation. The
client also ships a web app manifest, so users can "Add to Home Screen" from the mobile browser without any native app.

### Capacitor or WebView shell

Option A, load the server (same as Electron). In `capacitor.config.ts`:

```ts
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.example.relay',
  appName: 'Relay',
  webDir: 'web/dist',
  server: { url: 'https://chat.example.com', cleartext: false },
};
export default config;
```

Option B, bundle the built client (`npm run build`, `webDir: 'web/dist'`) and point it at a server. The app then runs on a different origin
(`capacitor://localhost` or `https://localhost`), so:

1. Tell the client where the server is, either at build time or at runtime:
   - build with `VITE_SERVER_URL=https://chat.example.com npm run build`, or
   - set `localStorage['relay.server'] = 'https://chat.example.com'` before the client loads (for example in a server picker screen), then reload.
     The runtime value takes precedence over the build-time value.
2. Allow the app's origin on the server: `CORS_ORIGINS=capacitor://localhost,https://localhost` (comma-separated).

When the configured server differs from the page's origin, the client switches to **bearer-token mode**: it stores the session token returned by
login in `localStorage['relay.token']`, sends `Authorization: Bearer <token>` on every request and passes the token in the Socket.IO handshake
(`auth: { token }`). Cookies are not used.

Push notifications are not built in yet. A native shell can show local notifications while the app is running. Background push would require a
push gateway, which is a welcome contribution.

### Native clients

A fully native client uses the same API as the web client:

1. `POST /api/auth/login` with `{ email, password }` and keep the returned `token` in secure storage (Keychain or Keystore).
2. Send `Authorization: Bearer <token>` on every request.
3. Load the initial state with `GET /api/bootstrap`.
4. Connect to Socket.IO at the server origin with `auth: { token }` and apply the events listed in [api.md](api.md#realtime-events-socketio).
5. Use `shared/types.ts` as the contract for all payloads.

For huddles, use a WebRTC library (for example the Google WebRTC SDK) and implement the signalling described in
[architecture.md](architecture.md#huddles-calls). ICE servers are in `workspace.iceServers` of the bootstrap response.

## Development tips

- Run `npm run dev` and point the shell at `http://localhost:5173` (Vite) to get hot reload inside Electron.
- For a bundled client during development, set `CORS_ORIGINS=http://localhost:5173` (or the shell's origin) on the server.
- Use `GET /api/health` to check that a user-entered server URL points at a Relay server before saving it.

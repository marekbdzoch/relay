import { Suspense, useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { useStore } from './store.ts';
import { boot } from './actions.ts';
import { setUnauthorizedHandler } from './api.ts';
import { t } from './i18n.ts';
import { lazyNamed } from './lib/lazy.ts';

import { Spinner } from './components/ui.tsx';
import { set } from './store.ts';

// start downloading the app shell right away, in parallel with the bootstrap request
const loadClient = () => import('./Client.tsx');
const clientPromise = loadClient();
const Client = lazyNamed(() => clientPromise, 'Client');
const LoginPage = lazyNamed(() => import('./views/AuthPages.tsx'), 'LoginPage');
const SetupPage = lazyNamed(() => import('./views/AuthPages.tsx'), 'SetupPage');
const SignupPage = lazyNamed(() => import('./views/AuthPages.tsx'), 'SignupPage');

function Splash() {
  return (
    <div className="splash">
      <img src="/favicon.svg" alt="" width={64} height={64} />
      <Spinner size={24} />
    </div>
  );
}

function ErrorScreen() {
  return (
    <div className="splash">
      <h2>{t('Can’t reach the server')}</h2>
      <p>{t('Check your connection and try again.')}</p>
      <button className="btn primary" onClick={() => location.reload()}>
        {t('Try again')}
      </button>
    </div>
  );
}

export function App() {
  const status = useStore((s) => s.status);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (useStore.getState().status === 'ready') set((s) => void (s.status = 'unauth'));
    });
    void boot();
  }, []);

  return (
    <BrowserRouter>
      <Suspense fallback={<Splash />}>
        <Routes>
        <Route path="/invite/:code" element={status === 'ready' ? <Navigate to="/" replace /> : <SignupPage />} />
        <Route path="/login" element={status === 'ready' ? <Navigate to="/" replace /> : status === 'setup' ? <Navigate to="/setup" replace /> : <LoginPage />} />
        <Route path="/setup" element={status === 'setup' ? <SetupPage /> : <Navigate to="/" replace />} />
        <Route
          path="*"
          element={
            status === 'loading' ? (
              <Splash />
            ) : status === 'setup' ? (
              <Navigate to="/setup" replace />
            ) : status === 'unauth' ? (
              <Navigate to="/login" replace />
            ) : status === 'error' ? (
              <ErrorScreen />
            ) : (
              <Client />
            )
          }
        />
      </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { GET, POST, assetUrl } from '../api.ts';
import { t } from '../i18n.ts';
import { errorMessage, loginSuccess } from '../actions.ts';
import type { Me } from '../../../shared/types.ts';

function Logo() {
  return (
    <div className="auth-logo">
      <img src="/favicon.svg" alt="" width={36} height={36} />
      <span>Relay</span>
    </div>
  );
}

function AuthShell({ children, footer }: { children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="auth-page">
      <Logo />
      <div className="auth-card">{children}</div>
      {footer && <div className="auth-footer">{footer}</div>}
    </div>
  );
}

const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ws, setWs] = useState<{ name: string; iconUrl: string | null } | null>(null);
  const [demo, setDemo] = useState<{ resetHours: number } | null>(null);
  const [showForm, setShowForm] = useState(false);
  useEffect(() => {
    GET<{ workspace: { name: string; iconUrl: string | null } | null; demo?: { resetHours: number } }>('/api/setup/status')
      .then((r) => {
        setWs(r.workspace);
        setDemo(r.demo ?? null);
      })
      .catch(() => {});
  }, []);
  const tryDemo = async () => {
    setBusy(true);
    setError('');
    try {
      loginSuccess(await POST<{ token: string; me: Me }>('/api/demo/login', {}));
      history.replaceState(null, '', '/');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      loginSuccess(await POST<{ token: string; me: Me }>('/api/auth/login', { email, password }));
      history.replaceState(null, '', '/');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  if (demo && !showForm) {
    return (
      <AuthShell>
        <h1>{t('Try Relay')}</h1>
        <p className="auth-sub">{t('Open-source team chat you can host yourself. Explore a sample company with channels, threads, voice rooms and AI teammates – no sign-up needed.')}</p>
        {error && <div className="auth-error">{error}</div>}
        <button className="btn primary big" onClick={() => void tryDemo()} disabled={busy}>
          {t('Try the demo')}
        </button>
        <p className="auth-note">{t('You get a temporary account. Everything resets every {n} hours.', { n: demo.resetHours })}</p>
        <p className="auth-note">
          <a href="https://github.com/marekbdzoch/relay" target="_blank" rel="noreferrer">
            {t('Get Relay for your team')}
          </a>{' '}
          ·{' '}
          <button className="link-btn" onClick={() => setShowForm(true)}>
            {t('Sign in with an account')}
          </button>
        </p>
      </AuthShell>
    );
  }
  return (
    <AuthShell>
      {ws?.iconUrl && <img className="auth-ws-icon" src={assetUrl(ws.iconUrl)} alt="" />}
      <h1>{ws ? t('Sign in to {name}', { name: ws.name }) : t('Sign in')}</h1>
      <p className="auth-sub">{t('We suggest using the email address you use at work.')}</p>
      <form onSubmit={submit}>
        <input type="text" autoFocus autoComplete="username" placeholder={t('name@work-email.com')} value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input type="password" autoComplete="current-password" placeholder={t('Password')} value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <div className="auth-error">{error}</div>}
        <button className="btn primary big" disabled={busy}>
          {t('Sign in')}
        </button>
      </form>
      <p className="auth-note">{t('Don’t have an account? Ask a workspace admin for an invite link.')}</p>
    </AuthShell>
  );
}

export function SignupPage() {
  const { code } = useParams();
  const [info, setInfo] = useState<{ workspace: { name: string; iconUrl: string | null }; email: string | null } | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!code) return;
    GET<{ workspace: { name: string; iconUrl: string | null }; email: string | null }>(`/api/invites/${code}`)
      .then((r) => {
        setInfo(r);
        if (r.email) setEmail(r.email);
      })
      .catch(() => setInvalid(true));
  }, [code]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      loginSuccess(await POST<{ token: string; me: Me }>('/api/auth/signup', { inviteCode: code, fullName, email, password, timezone: tz() }));
      history.replaceState(null, '', '/');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  if (invalid)
    return (
      <AuthShell footer={<Link to="/login">{t('Sign in')}</Link>}>
        <h1>{t('Invitation expired')}</h1>
        <p className="auth-sub">{t('This invite link is invalid or has expired.')}</p>
      </AuthShell>
    );
  return (
    <AuthShell footer={<Link to="/login">{t('Already have an account? Sign in')}</Link>}>
      {info?.workspace.iconUrl && <img className="auth-ws-icon" src={assetUrl(info.workspace.iconUrl)} alt="" />}
      <h1>{info ? t('Join {name}', { name: info.workspace.name }) : t('Create your account')}</h1>
      <p className="auth-sub">{t('Set up your account to start talking with your team.')}</p>
      <form onSubmit={submit}>
        <input autoFocus placeholder={t('Full name')} value={fullName} onChange={(e) => setFullName(e.target.value)} required maxLength={80} />
        <input type="email" placeholder={t('name@work-email.com')} value={email} onChange={(e) => setEmail(e.target.value)} required readOnly={!!info?.email} autoComplete="email" />
        <input type="password" placeholder={t('Password (min. 8 characters)')} value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete="new-password" />
        {error && <div className="auth-error">{error}</div>}
        <button className="btn primary big" disabled={busy}>
          {t('Create account')}
        </button>
      </form>
    </AuthShell>
  );
}

export function SetupPage() {
  const [setupCode, setSetupCode] = useState(() => new URLSearchParams(location.search).get('code') ?? '');
  const [codeRequired, setCodeRequired] = useState(false);
  useEffect(() => {
    GET<{ setupCodeRequired?: boolean }>('/api/setup/status')
      .then((r) => setCodeRequired(!!r.setupCodeRequired))
      .catch(() => {});
  }, []);
  const [workspaceName, setWorkspaceName] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      loginSuccess(await POST<{ token: string; me: Me }>('/api/setup', { workspaceName, fullName, email, password, timezone: tz(), setupCode: setupCode || undefined }));
      history.replaceState(null, '', '/');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthShell>
      <h1>{t('Set up your workspace')}</h1>
      <p className="auth-sub">{t('Welcome! Create the workspace for your team and your administrator account.')}</p>
      <form onSubmit={submit}>
        {codeRequired && (
          <>
            <label className="auth-label">{t('Setup code')}</label>
            <input value={setupCode} onChange={(e) => setSetupCode(e.target.value)} placeholder={t('e.g. k7m2x9…')} required autoComplete="off" spellCheck={false} />
            <p className="auth-hint">{t('This keeps strangers from taking over your new server. Find the code in the server logs (on Railway: your service → Deployments → View logs) or in the SETUP_TOKEN variable.')}</p>
          </>
        )}
        <label className="auth-label">{t('Company or team name')}</label>
        <input autoFocus placeholder={t('e.g. Acme Inc.')} value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} required maxLength={80} />
        <label className="auth-label">{t('Your account')}</label>
        <input placeholder={t('Full name')} value={fullName} onChange={(e) => setFullName(e.target.value)} required maxLength={80} />
        <input type="email" placeholder={t('name@work-email.com')} value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        <input type="password" placeholder={t('Password (min. 8 characters)')} value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete="new-password" />
        {error && <div className="auth-error">{error}</div>}
        <button className="btn primary big" disabled={busy}>
          {t('Create workspace')}
        </button>
      </form>
    </AuthShell>
  );
}

import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import './styles/base.css';
import './styles/layout.css';
import './styles/messages.css';
import './styles/composer.css';
import './styles/components.css';
import './styles/views.css';
import './styles/parity.css';
import './styles/nav.css';
import './styles/mobile.css';
import { applyTheme } from './lib/theme.ts';
import { App } from './App.tsx';

applyTheme();
createRoot(document.getElementById('root')!).render(<App />);

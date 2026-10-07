import { useStore, isAdmin } from '../store.ts';
import { t } from '../i18n.ts';
import { logout, openModal } from '../actions.ts';
import { Menu, MenuItem, MenuSep, Popover, type Placement } from './ui.tsx';
import { WorkspaceIcon } from './AppNav.tsx';
import { openOnboarding } from '../lib/onboarding.ts';

export function WorkspaceMenu({ anchor, onClose, placement = 'bottom-start' }: { anchor: HTMLElement | null; onClose: () => void; placement?: Placement }) {
  const ws = useStore((s) => s.workspace);
  const admin = useStore((s) => isAdmin(s.me));
  const close = (fn: () => void) => () => {
    onClose();
    fn();
  };
  return (
    <Popover anchor={anchor} onClose={onClose} placement={placement}>
      <Menu className="ws-menu">
        <div className="ws-menu-head">
          <WorkspaceIcon size={36} />
          <div>
            <div className="ws-menu-name">{ws?.name}</div>
            <div className="ws-menu-url">{location.host}</div>
          </div>
        </div>
        <MenuSep />
        <MenuItem onClick={close(() => openModal({ type: 'invite' }))}>{t('Invite people to {name}', { name: ws?.name ?? '' })}</MenuItem>
        <MenuItem onClick={close(() => openModal({ type: 'createChannel' }))}>{t('Create a channel')}</MenuItem>
        <MenuSep />
        <MenuItem onClick={close(() => openModal({ type: 'preferences' }))}>{t('Preferences')}</MenuItem>
        <MenuItem onClick={close(() => openModal({ type: 'admin', tab: 'emoji' }))}>{t('Customize emoji')}</MenuItem>
        {admin && (
          <>
            <MenuSep />
            <MenuItem onClick={close(openOnboarding)}>{t('Setup guide')}</MenuItem>
            <MenuItem onClick={close(() => openModal({ type: 'admin', tab: 'general' }))}>{t('Workspace settings')}</MenuItem>
            <MenuItem onClick={close(() => openModal({ type: 'admin', tab: 'members' }))}>{t('Manage members')}</MenuItem>
            <MenuItem onClick={close(() => openModal({ type: 'admin', tab: 'agents' }))}>{t('AI agents')}</MenuItem>
            <MenuItem onClick={close(() => openModal({ type: 'admin', tab: 'integrations' }))}>{t('Integrations & webhooks')}</MenuItem>
          </>
        )}
        <MenuSep />
        <MenuItem onClick={close(() => openModal({ type: 'shortcuts' }))}>{t('Keyboard shortcuts')}</MenuItem>
        <MenuItem onClick={close(() => void logout())}>{t('Sign out of {name}', { name: ws?.name ?? '' })}</MenuItem>
      </Menu>
    </Popover>
  );
}

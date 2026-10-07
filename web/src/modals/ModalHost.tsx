import { Suspense } from 'react';
import { useStore } from '../store.ts';
import { openModal } from '../actions.ts';
import { lazyNamed } from '../lib/lazy.ts';

// every dialog lives in its own chunk – the app shell stays small
const AddMembersModal = lazyNamed(() => import('./ChannelModals.tsx'), 'AddMembersModal');
const ChannelDetailsModal = lazyNamed(() => import('./ChannelModals.tsx'), 'ChannelDetailsModal');
const CreateChannelModal = lazyNamed(() => import('./ChannelModals.tsx'), 'CreateChannelModal');
const NewMessageModal = lazyNamed(() => import('./ChannelModals.tsx'), 'NewMessageModal');
const EditProfileModal = lazyNamed(() => import('./UserModals.tsx'), 'EditProfileModal');
const PreferencesModal = lazyNamed(() => import('./UserModals.tsx'), 'PreferencesModal');
const SetStatusModal = lazyNamed(() => import('./UserModals.tsx'), 'SetStatusModal');
const AdminModal = lazyNamed(() => import('./AdminModals.tsx'), 'AdminModal');
const InviteModal = lazyNamed(() => import('./AdminModals.tsx'), 'InviteModal');
const ConfirmModal = lazyNamed(() => import('./MiscModals.tsx'), 'ConfirmModal');
const ForwardModal = lazyNamed(() => import('./MiscModals.tsx'), 'ForwardModal');
const ImageModal = lazyNamed(() => import('./MiscModals.tsx'), 'ImageModal');
const QuickSwitcher = lazyNamed(() => import('./MiscModals.tsx'), 'QuickSwitcher');
const RemindModal = lazyNamed(() => import('./MiscModals.tsx'), 'RemindModal');
const ScheduleModal = lazyNamed(() => import('./MiscModals.tsx'), 'ScheduleModal');
const SectionModal = lazyNamed(() => import('./MiscModals.tsx'), 'SectionModal');
const ShortcutsModal = lazyNamed(() => import('./MiscModals.tsx'), 'ShortcutsModal');
const AgentModal = lazyNamed(() => import('./AgentModal.tsx'), 'AgentModal');

function ModalSwitch() {
  const modal = useStore((s) => s.modal);
  if (!modal) return null;
  const close = () => openModal(null);
  switch (modal.type) {
    case 'createChannel':
      return <CreateChannelModal initialName={modal.name} onClose={close} />;
    case 'channelDetails':
      return <ChannelDetailsModal key={`${modal.channelId}-${modal.tab}`} channelId={modal.channelId} tab={modal.tab} onClose={close} />;
    case 'addMembers':
      return <AddMembersModal channelId={modal.channelId} onClose={close} />;
    case 'newMessage':
      return <NewMessageModal onClose={close} />;
    case 'preferences':
      return <PreferencesModal tab={modal.tab} onClose={close} />;
    case 'editProfile':
      return <EditProfileModal onClose={close} />;
    case 'setStatus':
      return <SetStatusModal onClose={close} />;
    case 'invite':
      return <InviteModal onClose={close} />;
    case 'admin':
      return <AdminModal tab={modal.tab} onClose={close} />;
    case 'quickSwitcher':
      return <QuickSwitcher onClose={close} />;
    case 'image':
      return <ImageModal fileId={modal.fileId} messageId={modal.messageId} onClose={close} />;
    case 'shortcuts':
      return <ShortcutsModal onClose={close} />;
    case 'schedule':
      return <ScheduleModal channelId={modal.channelId} threadRootId={modal.threadRootId} text={modal.text} onDone={modal.onDone} onClose={close} />;
    case 'forward':
      return <ForwardModal messageId={modal.messageId} onClose={close} />;
    case 'confirm':
      return <ConfirmModal {...modal} onClose={close} />;
    case 'agent':
      return <AgentModal userId={modal.userId} template={modal.template} onClose={close} />;
    case 'remind':
      return <RemindModal messageId={modal.messageId} onClose={close} />;
    case 'section':
      return <SectionModal sectionId={modal.sectionId} channelId={modal.channelId} onClose={close} />;
    default:
      return null;
  }
}

export function ModalHost() {
  return (
    <Suspense fallback={null}>
      <ModalSwitch />
    </Suspense>
  );
}

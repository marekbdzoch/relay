// Shared API contract between the server and all clients (web, desktop, mobile).
// Type-only module: safe to import from anywhere with `import type`.

export type Role = 'owner' | 'admin' | 'member' | 'guest';
export type ChannelKind = 'public' | 'private' | 'dm' | 'group';
export type NotifyLevel = 'default' | 'all' | 'mentions' | 'none';
export type Presence = 'active' | 'away';

export interface User {
  id: string;
  username: string;
  fullName: string;
  displayName: string;
  title: string;
  phone: string;
  timezone: string;
  avatarUrl: string | null;
  avatarColor: string;
  role: Role;
  statusEmoji: string;
  statusText: string;
  statusExpiresAt: number | null;
  dndUntil: number | null;
  deactivated: boolean;
  isBot: boolean;
  /** set for people mirrored from another system, e.g. 'slack' */
  external: string | null;
  createdAt: number;
  email?: string; // only exposed to self and admins
  /** placeholder account created by a workspace import (e.g. Slack); claimed by signing up with the same e-mail */
  imported?: boolean;
}

export interface UserPrefs {
  theme?: string;
  colorMode?: 'light' | 'dark' | 'system';
  language?: string;
  notifyLevel?: 'all' | 'mentions' | 'none';
  notifySound?: boolean;
  enterToSend?: boolean;
  showMessagePreviews?: boolean;
  compact?: boolean;
  timeFormat24?: boolean;
  sidebarCollapsed?: Record<string, boolean>;
  recentEmoji?: string[];
  /** custom sidebar sections (like Slack's "Create a new section") */
  sidebarSections?: SidebarSection[];
  sectionSort?: Record<string, 'alpha' | 'recent'>;
  sectionFilter?: Record<string, 'all' | 'unreads'>;
  /** words that notify like a mention */
  keywords?: string;
  notifyThreads?: boolean;
  notifyHuddles?: boolean;
  workingHours?: { enabled: boolean; days: 'every' | 'weekdays'; from: string; to: string };
  audioInput?: string;
  videoInput?: string;
  quickReactions?: boolean;
  /** order and visibility of the section icons at the top of the left column */
  navTabs?: { id: NavSection; visible: boolean }[];
}

export type NavSection = 'home' | 'dms' | 'activity' | 'files' | 'later' | 'agents';

export interface SidebarSection {
  id: string;
  name: string;
  emoji: string;
  channelIds: string[];
}

export interface AgentInfo {
  userId: string;
  role: string;
  department: string;
  instructions: string;
  model: string;
  webSearch: boolean;
  avatarEmoji: string;
  /** 'mentions': in channels only when @mentioned (or in its threads); 'all': every message in its channels */
  replyMode: 'mentions' | 'all';
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export type AIProviderId = 'anthropic' | 'openai' | 'gemini' | 'openrouter' | 'mistral' | 'ollama' | 'custom';

export interface AIProviderInfo {
  id: AIProviderId;
  name: string;
  description: string;
  /** where to create an API key */
  keyUrl?: string;
  needsKey: boolean;
  needsBaseUrl: boolean;
  defaultBaseUrl?: string;
  supportsWebSearch: boolean;
  /** a key is stored or comes from the environment (the key itself is never sent to the client) */
  keySet: boolean;
}

export interface AgentSettings {
  /** agents can reply: the active provider has a key (when it needs one) and a model */
  configured: boolean;
  /** the active provider's API key comes from an environment variable */
  fromEnv: boolean;
  /** models of the active provider: the built-in Claude models for Anthropic, otherwise the list cached from the provider's /models endpoint */
  models: { id: string; name: string; description: string }[];
  provider: AIProviderId;
  providers: AIProviderInfo[];
  /** effective base URL of the active provider ('' for Anthropic; only sent to admins) */
  baseUrl: string;
  /** workspace default model; agents without their own model use it */
  defaultModel: string;
  /** the provider is fixed by the AI_PROVIDER environment variable */
  providerFromEnv?: boolean;
}

export type AIConnectionTest = { ok: true; models: { id: string; name: string }[] } | { ok: false; error: string };

export interface HuddleSession {
  id: number;
  channelId: string;
  startedBy: string | null;
  startedAt: number;
  endedAt: number | null;
  participantIds: string[];
}

export interface UnreadGroup {
  channelId: string;
  messages: Message[];
  total: number;
}

export interface LinkItem {
  url: string;
  title: string | null;
  messageId: number;
  userId: string | null;
  createdAt: number;
}

export interface Me extends User {
  email: string;
  prefs: UserPrefs;
  awayManual: boolean;
}

export interface Workspace {
  name: string;
  iconUrl: string | null;
  allowedDomains: string;
  createdAt: number;
  iceServers: RTCIceServerLike[];
  /** the first-run setup wizard hasn't been finished yet (shown to admins) */
  onboardingPending?: boolean;
  /** set on public demo instances (DEMO_MODE) */
  demo?: { resetHours: number; nextResetAt: number };
}

export interface RTCIceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface Channel {
  id: string;
  kind: ChannelKind;
  name: string; // for dm/group: empty, clients compute from members
  topic: string;
  description: string;
  createdBy: string | null;
  createdAt: number;
  archived: boolean;
  isDefault: boolean;
  memberCount: number;
  memberIds?: string[]; // always present for dm/group
  lastMessageAt: number | null;
  /** external bridge, e.g. { kind: 'slack', name: 'general' } */
  bridge: { kind: 'slack'; name: string } | null;
}

export interface Membership {
  channelId: string;
  lastRead: number;
  starred: boolean;
  muted: boolean;
  notify: NotifyLevel;
  hidden: boolean;
  unread: number;
  mentions: number;
  joinedAt: number;
}

export interface Reaction {
  emoji: string;
  userIds: string[];
}

export interface FileInfo {
  id: string;
  name: string;
  mime: string;
  size: number;
  url: string;
  width: number | null;
  height: number | null;
  userId: string;
  channelId: string | null;
  messageId: number | null;
  createdAt: number;
}

export interface Unfurl {
  url: string;
  title?: string;
  description?: string;
  siteName?: string;
  image?: string;
}

export type MessageSubtype = 'join' | 'leave' | 'topic' | 'description' | 'rename' | 'archive' | 'unarchive' | 'bot' | 'huddle' | 'bridge';

export interface Message {
  id: number;
  channelId: string;
  userId: string | null;
  text: string;
  subtype: MessageSubtype | null;
  threadRootId: number | null;
  replyCount: number;
  lastReplyAt: number | null;
  replyUserIds: string[];
  alsoInChannel: boolean;
  createdAt: number;
  editedAt: number | null;
  deleted: boolean;
  reactions: Reaction[];
  files: FileInfo[];
  unfurls: Unfurl[];
  pinnedBy: string | null;
  botName?: string;
  clientId?: string;
  // client-only flags for optimistic messages
  pending?: boolean;
  failed?: boolean;
}

export interface ActivityItem {
  id: number;
  kind: 'mention' | 'reaction' | 'thread_reply' | 'channel_invite' | 'reminder' | 'dm';
  actorId: string | null;
  channelId: string;
  emoji: string | null;
  read: boolean;
  createdAt: number;
  message: Message | null;
}

export interface ThreadSummary {
  root: Message;
  replies: Message[]; // latest few
  lastRead: number;
  unread: number;
}

export interface Draft {
  channelId: string;
  threadRootId: number | null;
  text: string;
  updatedAt: number;
}

export interface ScheduledMessage {
  id: string;
  channelId: string;
  threadRootId: number | null;
  text: string;
  sendAt: number;
  createdAt: number;
}

export type SavedState = 'progress' | 'completed' | 'archived';

export interface SavedItem {
  message: Message;
  savedAt: number;
  state: SavedState;
  remindAt: number | null;
}

export interface Invite {
  code: string;
  email: string | null;
  role: Role;
  maxUses: number | null;
  uses: number;
  expiresAt: number | null;
  createdAt: number;
  createdBy: string;
}

export interface CustomEmoji {
  name: string;
  url: string;
  createdBy: string;
}

export interface Webhook {
  id: string;
  name: string;
  channelId: string;
  url: string;
  createdBy: string;
  createdAt: number;
}

export interface HuddleState {
  channelId: string;
  participants: { userId: string; muted: boolean; sharing: boolean; video: boolean }[];
  startedAt: number;
}

export interface BootstrapResponse {
  me: Me;
  workspace: Workspace;
  users: User[];
  channels: Channel[];
  memberships: Membership[];
  presence: Record<string, Presence>;
  savedIds: number[];
  agents: AgentInfo[];
  drafts: Draft[];
  customEmoji: CustomEmoji[];
  huddles: HuddleState[];
  activityUnread: number;
  threadsUnread: number;
  version: string;
}

export interface MessagesPage {
  messages: Message[]; // ascending by id
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

/** Background job importing a Slack workspace export (POST /api/admin/import/slack). */
export interface SlackImportJob {
  id: string;
  state: 'queued' | 'running' | 'done' | 'error';
  /** 'queued' | 'reading' | 'users' | 'channels' | 'messages' | 'files' | 'finishing' | 'done' */
  phase: string;
  /** 0..1 */
  progress: number;
  counts: { users: number; channels: number; messages: number; files: number; reactions: number };
  warnings: string[];
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface SearchResults {
  messages: Message[];
  files: FileInfo[];
  channels: Channel[];
  users: User[];
  total: number;
}

// ---- realtime events (server -> client) ----
export interface ServerEvents {
  'message:new': (m: Message) => void;
  'message:updated': (m: Message) => void;
  'message:deleted': (p: { id: number; channelId: string; threadRootId: number | null }) => void;
  'channel:upsert': (c: Channel) => void;
  'channel:removed': (p: { channelId: string }) => void; // you lost access
  'membership:upsert': (m: Membership) => void;
  'user:upsert': (u: User) => void;
  'me:updated': (m: Me) => void;
  presence: (p: { userId: string; presence: Presence }) => void;
  typing: (p: { channelId: string; threadRootId: number | null; userId: string }) => void;
  'saved:changed': (p: { messageId: number; saved: boolean }) => void;
  'draft:changed': (d: Draft & { deleted?: boolean }) => void;
  'activity:new': (a: ActivityItem) => void;
  'thread:read': (p: { rootId: number; lastRead: number }) => void;
  'emoji:changed': (list: CustomEmoji[]) => void;
  'workspace:updated': (w: Workspace) => void;
  'huddle:state': (h: HuddleState) => void;
  'huddle:ended': (p: { channelId: string }) => void;
  'huddle:signal': (p: { from: string; channelId: string; data: unknown }) => void;
  'agent:upsert': (a: AgentInfo) => void;
  'agent:removed': (p: { userId: string }) => void;
  'session:revoked': () => void;
  /** progress of a workspace import, sent to the admin who started it */
  'import:progress': (job: SlackImportJob) => void;
  /** a workspace import finished: clients should reload their data */
  'import:done': (p: { jobId: string }) => void;
}

// ---- realtime events (client -> server) ----
export interface ClientEvents {
  typing: (p: { channelId: string; threadRootId: number | null }) => void;
  'huddle:join': (p: { channelId: string }, ack?: (r: { ok: boolean; error?: string }) => void) => void;
  'huddle:leave': (p: { channelId: string }) => void;
  'huddle:signal': (p: { to: string; channelId: string; data: unknown }) => void;
  'huddle:media': (p: { channelId: string; muted: boolean; sharing: boolean; video?: boolean }) => void;
  'presence:active': () => void;
}

/**
 * AI agents: workspace members backed by an AI model – Claude by default, or any OpenAI-compatible provider.
 *
 * An agent is a regular (bot) user, so people can DM it, invite it to channels and mention it.
 * Whenever a message reaches an agent (DM, @mention, a thread it takes part in, or any message in
 * its channels when reply mode is "all") we build the conversation context and run a tool-use
 * loop on the model's API. The agent can answer, post to other channels/DMs (to delegate work
 * to colleagues or other agents), read channels, search, react and – with Claude, optionally – search the web.
 *
 * Context building and tool execution are shared; two adapters run the model loop: runAnthropic (official SDK, beta
 * Messages API) and runOpenAI (OpenAI-compatible Chat Completions via fetch, see openai.ts).
 */
import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import type { AIProviderId, Message } from '../../../shared/types.ts';
import { all, get, getSetting, placeholders, run } from '../db.ts';
import { absPath } from '../lib/files.ts';
import { json, newId, now } from '../lib/util.ts';
import {
  channelMemberIds,
  getChannelRow,
  getMessage,
  getUserRow,
  hydrateMessages,
  isMember,
  type ChannelRow,
  type MessageMeta,
  type MessageRow,
  type UserRow,
} from '../model.ts';
import { addMembers, bus, emitMessageUpdated, postMessage } from '../services.ts';
import { toChannel } from '../realtime.ts';
import { agentModel, anthropicKey, getAgentRow, isActiveAgent, workspaceDefaultModel, type AgentRow } from './store.ts';
import { activeProvider, keyFromEnv, limits, providerBaseUrl, providerDef, providerKey, storedKey } from './providers.ts';
import { ProviderError, chatCompletion, contentText } from './openai.ts';

const MAX_DEPTH = 4; // agent -> agent hops before we stop (prevents endless loops)
const MAX_TOOL_ROUNDS = 8;
const HISTORY = 40;

let client: Anthropic | null = null;
let clientKey = '';
function getClient() {
  const key = anthropicKey();
  if (!key) return null;
  if (!client || key !== clientKey) {
    client = new Anthropic({ apiKey: key, maxRetries: 2 });
    clientKey = key;
  }
  return client;
}

// ---------------------------------------------------------------------------
// formatting helpers

const nameOf = (u: UserRow | undefined) => (u ? u.display_name || u.full_name : 'Unknown');

function userLabel(id: string | null, botName?: string) {
  if (!id) return `${botName ?? 'App'} (app)`;
  const u = getUserRow(id);
  if (!u) return 'Unknown';
  const agent = getAgentRow(id);
  return `${nameOf(u)} (@${u.username}${agent ? `, AI agent – ${agent.role || 'assistant'}` : u.title ? `, ${u.title}` : ''})`;
}

function decodeTokens(text: string) {
  return text
    .replace(/<@([A-Z0-9]+)>/g, (_, id) => {
      const u = getUserRow(id);
      return u ? `@${u.username}` : '@someone';
    })
    .replace(/<#([A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id) => {
      const c = getChannelRow(id);
      return c ? `#${c.name}` : '#channel';
    })
    .replace(/<!(here|channel|everyone)>/g, '@$1')
    .replace(/<(https?:\/\/[^>|]+)\|([^>]+)>/g, '[$2]($1)')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1');
}

/** "@username" / "#channel" written by the model -> stable tokens. Broadcast mentions are not allowed for agents. */
function encodeTokens(text: string) {
  return text
    .split(/(```[\s\S]*?```|`[^`\n]+`)/g)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part
        .replace(/(^|[\s(>"'])@([\p{L}\p{N}._-]+)/gu, (m, pre, name: string) => {
          let n = name.toLowerCase();
          let tail = '';
          while (n && /[._-]$/.test(n) && !get('SELECT 1 FROM users WHERE username = ?', n)) {
            tail = n.slice(-1) + tail;
            n = n.slice(0, -1);
          }
          if (['here', 'channel', 'everyone'].includes(n)) return m;
          const u = get<{ id: string }>('SELECT id FROM users WHERE username = ? AND deactivated = 0', n);
          return u ? `${pre}<@${u.id}>${tail}` : m;
        })
        .replace(/(^|[\s(>"'])#([\p{L}\p{N}_-]+)/gu, (m, pre, name: string) => {
          const c = get<{ id: string }>("SELECT id FROM channels WHERE name = ? AND kind IN ('public','private')", name.toLowerCase());
          return c ? `${pre}<#${c.id}>` : m;
        });
    })
    .join('');
}

function formatTime(ts: number) {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function transcriptLine(m: Message) {
  const files = m.files.length ? ` [files: ${m.files.map((f) => f.name).join(', ')}]` : '';
  const reactions = m.reactions.length ? ` [reactions: ${m.reactions.map((r) => `:${r.emoji}: ×${r.userIds.length}`).join(' ')}]` : '';
  const thread = m.replyCount ? ` [${m.replyCount} replies in thread]` : '';
  if (m.subtype && m.subtype !== 'bot') return `[${formatTime(m.createdAt)}] ${userLabel(m.userId)} – (${m.subtype} event) ${decodeTokens(m.text)}`;
  return `[${formatTime(m.createdAt)}] ${userLabel(m.userId, m.botName)}: ${decodeTokens(m.text)}${files}${reactions}${thread}`;
}

function conversationName(ch: ChannelRow, agentId: string) {
  if (ch.kind === 'dm' || ch.kind === 'group') {
    const others = channelMemberIds(ch.id).filter((id) => id !== agentId);
    return `${ch.kind === 'dm' ? 'direct message' : 'group direct message'} with ${others.map((id) => userLabel(id)).join(', ')}`;
  }
  return `${ch.kind === 'private' ? 'private ' : ''}channel #${ch.name}${ch.topic ? ` (topic: ${ch.topic})` : ''}${ch.description ? ` – ${ch.description}` : ''}`;
}

function directory() {
  const people = all<UserRow>(
    'SELECT * FROM users WHERE deactivated = 0 AND (is_bot = 0 OR id IN (SELECT user_id FROM agents)) ORDER BY full_name COLLATE NOCASE LIMIT 200',
  );
  return people
    .map((u) => {
      const a = getAgentRow(u.id);
      if (a) return `- ${nameOf(u)} @${u.username} – AI agent${a.department ? `, ${a.department}` : ''}: ${a.role || 'assistant'}`;
      return `- ${nameOf(u)} @${u.username}${u.title ? ` – ${u.title}` : ''}${u.external === 'slack' ? ' (writes from Slack)' : ''}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// system prompt (stable per agent, so it caches well)

function systemPrompt(agent: AgentRow, me: UserRow) {
  const workspace = get<{ name: string }>('SELECT name FROM workspace WHERE id = 1')?.name ?? 'the workspace';
  return `You are ${nameOf(me)} (@${me.username}), an AI agent working as a team member in "${workspace}", a Slack-like team chat.
Role: ${agent.role || 'Assistant'}${agent.department ? `\nTeam / department: ${agent.department}` : ''}

Your responsibilities and instructions from the team:
${agent.instructions || '(none given – be a helpful, proactive colleague)'}

How to work:
- You talk to people like a colleague in a chat: concise, friendly, concrete. No essays unless asked.
- Reply in the language of the message you are answering.
- When someone gives you a task, do it now with the tools you have and report the result. If you can't fully do it, say what you did and what is missing.
- To involve someone, mention them as @username. To refer to a channel use #channel-name. Never use @here, @channel or @everyone.
- Use the send_message tool to post in another channel or to DM a colleague (people or other AI agents) – e.g. to delegate part of a task to the right specialist. Your final answer is posted automatically to the conversation you were called from, so don't send it again with send_message.
- Only claim things you actually know or found out. If unsure, ask.
- Formatting (chat markdown): *bold*, _italic_, ~strike~, \`code\`, \`\`\`code blocks\`\`\`, "> " quotes, "- " bullet lists, [text](url) links. Do not use # headings or tables.`;
}

// ---------------------------------------------------------------------------
// tools

type ToolCtx = { agentId: string; trigger: Message; depth: number };

/** Provider-neutral tool definitions (JSON schema parameters). */
interface ToolDef {
  name: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };
  strict?: boolean;
}

const TOOL_DEFS: ToolDef[] = [
  {
    name: 'send_message',
    description:
      'Post a message to a channel you are a member of ("#channel-name") or send a direct message to a person or AI agent ("@username"). Use it to delegate, ask colleagues or share results elsewhere. Do not use it to answer the current conversation – your final reply is posted there automatically.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '"#channel-name" or "@username"' },
        text: { type: 'string', description: 'Message text (chat markdown). Mention people as @username.' },
      },
      required: ['to', 'text'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'read_channel',
    description: 'Read the latest messages of a channel you are a member of ("#channel-name") or of your direct messages with someone ("@username").',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: '"#channel-name" or "@username"' },
        limit: { type: 'integer', description: 'How many messages (1-100), default 30' },
      },
      required: ['channel'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_messages',
    description: 'Full-text search of messages in the channels you are a member of. Returns matching messages with their channel and author.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Words to search for' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_channels',
    description: 'List the channels you are a member of and the public channels you could be added to.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'add_reaction',
    description: 'React with an emoji to the message you were called for (e.g. "white_check_mark", "eyes", "+1", "tada").',
    parameters: {
      type: 'object',
      properties: { emoji: { type: 'string', description: 'Emoji short name without colons' } },
      required: ['emoji'],
      additionalProperties: false,
    },
  },
];

const ANTHROPIC_TOOLS: Anthropic.Beta.BetaTool[] = TOOL_DEFS.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.parameters,
  ...(t.strict ? { strict: true } : {}),
}));

const OPENAI_TOOLS = TOOL_DEFS.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));

function resolveTarget(agentId: string, target: string): { channelId?: string; error?: string } {
  const t = target.trim();
  if (t.startsWith('#')) {
    const c = get<{ id: string }>("SELECT id FROM channels WHERE name = ? AND kind IN ('public','private') AND archived = 0", t.slice(1).toLowerCase());
    if (!c) return { error: `Channel ${t} does not exist.` };
    if (!isMember(agentId, c.id)) return { error: `You are not a member of ${t}. Ask someone to add you.` };
    return { channelId: c.id };
  }
  const username = t.replace(/^@/, '').toLowerCase();
  const u = get<{ id: string }>('SELECT id FROM users WHERE username = ? AND deactivated = 0', username);
  if (!u) return { error: `Nobody with username @${username}.` };
  if (u.id === agentId) return { error: 'That is you.' };
  // find or create the DM
  const key = [agentId, u.id].sort().join(',');
  let ch = get<{ id: string }>('SELECT id FROM channels WHERE dm_key = ?', key);
  if (!ch) {
    // lazily import to avoid a cycle with routes
    return { error: `__create_dm__:${u.id}` };
  }
  return { channelId: ch.id };
}

async function ensureDm(agentId: string, userId: string) {
  const key = [agentId, userId].sort().join(',');
  const existing = get<{ id: string }>('SELECT id FROM channels WHERE dm_key = ?', key);
  if (existing) return existing.id;
  const id = newId('D');
  run("INSERT INTO channels (id, kind, created_by, created_at, dm_key) VALUES (?, 'dm', ?, ?, ?)", id, agentId, now(), key);
  addMembers(id, [agentId, userId], agentId, false);
  return id;
}

async function runTool(name: string, input: any, ctx: ToolCtx): Promise<string> {
  switch (name) {
    case 'send_message': {
      if (typeof input?.to !== 'string' || typeof input?.text !== 'string' || !input.text.trim()) return 'Error: "to" and "text" are required.';
      let r = resolveTarget(ctx.agentId, input.to);
      if (r.error?.startsWith('__create_dm__:')) r = { channelId: await ensureDm(ctx.agentId, r.error.split(':')[1]) };
      if (r.error) return `Error: ${r.error}`;
      if (r.channelId === ctx.trigger.channelId && !ctx.trigger.threadRootId)
        return 'Error: that is the current conversation – just write your reply as your final answer.';
      postMessage({ channelId: r.channelId!, userId: ctx.agentId, text: encodeTokens(input.text), source: 'agent', agentDepth: ctx.depth + 1 });
      return `Sent to ${input.to}.`;
    }
    case 'read_channel': {
      if (typeof input?.channel !== 'string') return 'Error: "channel" is required.';
      let r = resolveTarget(ctx.agentId, input.channel);
      if (r.error?.startsWith('__create_dm__:')) return 'No messages yet.';
      if (r.error) return `Error: ${r.error}`;
      const limit = Math.min(100, Math.max(1, Number(input.limit) || 30));
      const rows = all<MessageRow>(
        'SELECT * FROM messages WHERE channel_id = ? AND deleted_at IS NULL AND (thread_root_id IS NULL OR also_in_channel = 1) ORDER BY id DESC LIMIT ?',
        r.channelId!,
        limit,
      ).reverse();
      return rows.length ? hydrateMessages(rows).map(transcriptLine).join('\n') : 'No messages yet.';
    }
    case 'search_messages': {
      const words = String(input?.query ?? '')
        .split(/\s+/)
        .map((w) => w.replace(/["*^():]/g, ''))
        .filter(Boolean);
      if (!words.length) return 'Error: empty query.';
      const chans = all<{ channel_id: string }>('SELECT channel_id FROM channel_members WHERE user_id = ?', ctx.agentId).map((r) => r.channel_id);
      if (!chans.length) return 'No results.';
      const rows = all<MessageRow>(
        `SELECT m.* FROM messages m JOIN messages_fts f ON f.rowid = m.id WHERE messages_fts MATCH ? AND m.deleted_at IS NULL AND m.channel_id IN (${placeholders(chans.length)})
         ORDER BY bm25(messages_fts) LIMIT 20`,
        words.map((w) => `"${w}"*`).join(' '),
        ...chans,
      );
      if (!rows.length) return 'No results.';
      return hydrateMessages(rows)
        .map((m) => {
          const c = getChannelRow(m.channelId)!;
          return `${c.kind === 'dm' || c.kind === 'group' ? '(DM)' : `#${c.name}`} ${transcriptLine(m)}`;
        })
        .join('\n');
    }
    case 'list_channels': {
      const rows = all<ChannelRow & { member: number }>(
        `SELECT c.*, EXISTS(SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?) AS member
         FROM channels c WHERE c.archived = 0 AND (c.kind = 'public' OR (c.kind = 'private' AND c.id IN (SELECT channel_id FROM channel_members WHERE user_id = ?))) ORDER BY c.name`,
        ctx.agentId,
        ctx.agentId,
      );
      return rows.map((c) => `#${c.name}${c.member ? ' (member)' : ''}${c.description ? ` – ${c.description}` : ''}`).join('\n') || 'No channels.';
    }
    case 'add_reaction': {
      const emoji = String(input?.emoji ?? '')
        .replace(/:/g, '')
        .trim();
      if (!emoji || ctx.trigger.id <= 0) return 'Error: no emoji.';
      run('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)', ctx.trigger.id, ctx.agentId, emoji, now());
      emitMessageUpdated(ctx.trigger.id);
      bus.emit('reaction', { messageId: ctx.trigger.id, userId: ctx.agentId, emoji, added: true });
      return 'Reaction added.';
    }
    default:
      return `Error: unknown tool ${name}`;
  }
}

// ---------------------------------------------------------------------------
// triggering

function mentions(text: string, userId: string) {
  return text.includes(`<@${userId}>`);
}

function shouldRespond(agentId: string, agent: AgentRow, msg: Message, ch: ChannelRow): boolean {
  const fromAgent = msg.userId ? !!getAgentRow(msg.userId) : false;
  const mentioned = mentions(msg.text, agentId);
  if (ch.kind === 'dm') return true;
  if (fromAgent) return mentioned; // agents only pull each other in explicitly
  if (mentioned) return true;
  if (msg.threadRootId) {
    const root = getMessage(msg.threadRootId);
    const inThread = root && (root.userId === agentId || root.replyUserIds.includes(agentId));
    // someone else is addressed explicitly -> stay quiet
    const addressesOthers = /<@[A-Z0-9]+>/.test(msg.text) && !mentioned;
    if (inThread && !addressesOthers) return true;
  }
  if (ch.kind === 'group') return agent.reply_mode === 'all';
  return agent.reply_mode === 'all' && !msg.threadRootId && !/<@[A-Z0-9]+>/.test(msg.text);
}

const running = new Map<string, { pending: Message | null }>();

function schedule(agentId: string, msg: Message) {
  const key = `${agentId}:${msg.channelId}:${msg.threadRootId ?? 0}`;
  const job = running.get(key);
  if (job) {
    job.pending = msg; // coalesce: answer the latest message once the current run finishes
    return;
  }
  const state = { pending: null as Message | null };
  running.set(key, state);
  void (async () => {
    let current: Message | null = msg;
    while (current) {
      try {
        await respond(agentId, current);
      } catch (e) {
        console.error('[agents] run failed', e);
      }
      current = state.pending;
      state.pending = null;
    }
    running.delete(key);
  })();
}

function onPosted(msg: Message) {
  if (msg.deleted || (msg.subtype && msg.subtype !== 'bot')) return;
  const ch = getChannelRow(msg.channelId);
  if (!ch || ch.archived) return;
  const meta = json<MessageMeta>(getMessageMeta(msg.id), {});
  const depth = meta.agentDepth ?? 0;
  if (depth >= MAX_DEPTH) return;
  const agentIds = all<{ user_id: string }>(
    `SELECT a.user_id FROM agents a JOIN channel_members cm ON cm.user_id = a.user_id JOIN users u ON u.id = a.user_id
     WHERE cm.channel_id = ? AND u.deactivated = 0`,
    msg.channelId,
  ).map((r) => r.user_id);
  for (const agentId of agentIds) {
    if (agentId === msg.userId) continue;
    const agent = getAgentRow(agentId);
    if (agent && shouldRespond(agentId, agent, msg, ch)) schedule(agentId, msg);
  }
}

function getMessageMeta(id: number) {
  return get<{ meta: string }>('SELECT meta FROM messages WHERE id = ?', id)?.meta;
}

// ---------------------------------------------------------------------------
// the agent loop

interface ImageData {
  mime: string;
  data: string; // base64
}

/** Images attached to the trigger message (at most 4, PNG/JPEG/GIF/WebP up to 4.5 MB). */
function loadImages(m: Message): ImageData[] {
  const out: ImageData[] = [];
  for (const f of m.files) {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(f.mime) || f.size > 4.5 * 1024 * 1024) continue;
    const row = get<{ path: string }>('SELECT path FROM files WHERE id = ?', f.id);
    if (!row) continue;
    try {
      out.push({ mime: f.mime, data: fs.readFileSync(absPath(row.path)).toString('base64') });
    } catch {
      /* skip */
    }
  }
  return out.slice(0, 4);
}

function buildContext(agentId: string, trigger: Message, ch: ChannelRow) {
  let history: Message[];
  if (trigger.threadRootId) {
    const root = getMessage(trigger.threadRootId);
    const replies = all<MessageRow>(
      'SELECT * FROM messages WHERE thread_root_id = ? AND deleted_at IS NULL AND id <= ? ORDER BY id DESC LIMIT ?',
      trigger.threadRootId,
      trigger.id,
      HISTORY,
    ).reverse();
    history = [...(root ? [root] : []), ...hydrateMessages(replies)];
  } else {
    const rows = all<MessageRow>(
      'SELECT * FROM messages WHERE channel_id = ? AND deleted_at IS NULL AND (thread_root_id IS NULL OR also_in_channel = 1) AND id <= ? ORDER BY id DESC LIMIT ?',
      ch.id,
      trigger.id,
      HISTORY,
    ).reverse();
    history = hydrateMessages(rows);
  }
  const earlier = history.filter((m) => m.id !== trigger.id);
  return `Current time: ${formatTime(now())}
You are in: ${conversationName(ch, agentId)}${trigger.threadRootId ? ' – inside a thread' : ''}

People in the workspace:
${directory()}

Conversation so far:
${earlier.length ? earlier.map(transcriptLine).join('\n') : '(no earlier messages)'}

New message you are responding to:
${transcriptLine(trigger)}`;
}

/** Everything an adapter needs for one response. */
interface RunInput {
  agent: AgentRow;
  model: string;
  system: string;
  context: string;
  images: ImageData[];
  ctx: ToolCtx;
  /** called after each tool round (refreshes the typing indicator) */
  onRound: () => void;
}

/** Runs one tool call for any adapter; failures become an "Error: …" result for the model. */
async function executeTool(name: string, input: unknown, ctx: ToolCtx): Promise<{ content: string; isError: boolean }> {
  let content: string;
  try {
    content = await runTool(name, input, ctx);
  } catch (e) {
    content = `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
  return { content, isError: content.startsWith('Error:') };
}

// --- Anthropic (Claude) ------------------------------------------------------

async function runAnthropic(api: Anthropic, input: RunInput): Promise<string> {
  const { model, agent } = input;
  const isHaiku = model.startsWith('claude-haiku');
  const tools: Anthropic.Beta.BetaToolUnion[] = [...ANTHROPIC_TOOLS];
  if (agent.web_search) {
    tools.push(isHaiku ? { type: 'web_search_20250305', name: 'web_search', max_uses: 5 } : { type: 'web_search_20260209', name: 'web_search', max_uses: 5 });
  }
  const userContent: Anthropic.Beta.BetaContentBlockParam[] = [
    ...input.images.map((img): Anthropic.Beta.BetaImageBlockParam => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mime as 'image/png', data: img.data },
    })),
    { type: 'text', text: input.context },
  ];
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: userContent }];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await api.beta.messages.create({
      model,
      max_tokens: 16000,
      system: [{ type: 'text', text: input.system, cache_control: { type: 'ephemeral' } }],
      messages,
      tools,
      ...(isHaiku
        ? {}
        : {
            output_config: { effort: 'medium' as const },
            // on a policy decline, the API re-runs the request on a fallback model
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default' as const,
          }),
    });

    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    if (response.stop_reason === 'refusal') return text || 'Sorry, I can’t help with that.';
    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }
    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || !toolUses.length) return text;
    messages.push({ role: 'assistant', content: response.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const r = await executeTool(tu.name, tu.input, input.ctx);
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: r.content, is_error: r.isError || undefined });
    }
    messages.push({ role: 'user', content: results });
    input.onRound();
  }
  return '';
}

function anthropicErrorReason(e: unknown) {
  if (e instanceof Anthropic.AuthenticationError) return 'the Anthropic API key is invalid';
  if (e instanceof Anthropic.PermissionDeniedError) return 'the API key has no access to this model';
  if (e instanceof Anthropic.RateLimitError) return 'the AI service is rate limited right now – try again in a minute';
  if (e instanceof Anthropic.BadRequestError) return `the request was rejected (${e.message.slice(0, 160)})`;
  if (e instanceof Anthropic.APIError) return `the AI service returned an error (${e.status ?? 'network'})`;
  return 'something went wrong';
}

// --- OpenAI-compatible (OpenAI, Gemini, OpenRouter, Mistral, Ollama, custom) ---

interface OpenAIConn {
  provider: AIProviderId;
  baseUrl: string;
  key: string;
}

async function runOpenAI(conn: OpenAIConn, input: RunInput): Promise<string> {
  const textOnly = { role: 'user', content: input.context };
  const messages: Record<string, unknown>[] = [
    { role: 'system', content: input.system },
    input.images.length
      ? {
          role: 'user',
          content: [
            ...input.images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}` } })),
            { type: 'text', text: input.context },
          ],
        }
      : textOnly,
  ];
  const call = () => chatCompletion(conn.provider, conn.baseUrl, conn.key, { model: input.model, messages, tools: OPENAI_TOOLS }, limits.requestTimeoutMs);

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let res: any;
    try {
      res = await call();
    } catch (e) {
      // models without vision reject image parts: try once more without the images
      if (round > 0 || messages[1] === textOnly || !(e instanceof ProviderError) || e.status !== 400) throw e;
      messages[1] = textOnly;
      res = await call();
    }
    const choice = res?.choices?.[0];
    const msg = choice?.message;
    if (!msg || typeof msg !== 'object') throw new ProviderError('invalid', null, 'The response contains no message');
    const text = contentText(msg.content).trim();
    const calls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] = (Array.isArray(msg.tool_calls) ? msg.tool_calls : [])
      .filter((c: any) => typeof c?.function?.name === 'string')
      .map((c: any, i: number) => ({
        id: typeof c.id === 'string' && c.id ? c.id : `call_${round}_${i}`,
        type: 'function',
        function: {
          name: c.function.name,
          arguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments ?? {}),
        },
      }));
    if (!calls.length) return text || (choice.finish_reason === 'content_filter' ? 'Sorry, I can’t help with that.' : '');
    messages.push({ role: 'assistant', content: typeof msg.content === 'string' ? msg.content : null, tool_calls: calls });
    for (const c of calls) {
      let args: unknown;
      try {
        args = c.function.arguments.trim() ? JSON.parse(c.function.arguments) : {};
      } catch {
        messages.push({ role: 'tool', tool_call_id: c.id, content: 'Error: the tool arguments are not valid JSON.' });
        continue;
      }
      const r = await executeTool(c.function.name, args, input.ctx);
      messages.push({ role: 'tool', tool_call_id: c.id, content: r.content });
    }
    input.onRound();
  }
  return '';
}

function openAIErrorReason(e: unknown, conn: OpenAIConn, model: string) {
  if (!(e instanceof ProviderError)) return 'something went wrong';
  const name = providerDef(conn.provider).name;
  if (e.kind === 'timeout') return 'the AI service took too long to answer';
  if (e.kind === 'network') return `the AI service (${name}) can’t be reached`;
  if (e.kind === 'invalid') return 'the AI service sent a response I couldn’t read';
  switch (e.status) {
    case 401:
      return `the ${name} API key is invalid`;
    case 402:
      return 'the AI account has run out of credit';
    case 403:
      return 'the API key has no access to this model';
    case 404:
      return `the model “${model}” was not found`;
    case 429:
      return 'the AI service is rate limited right now – try again in a minute';
    case 400:
    case 422:
      return `the request was rejected (${e.status} ${e.message.slice(0, 160)})`;
    default:
      return `the AI service returned an error (${e.status})`;
  }
}

// --- one response ---------------------------------------------------------------

async function respond(agentId: string, trigger: Message) {
  const agent = getAgentRow(agentId);
  const me = getUserRow(agentId);
  const ch = getChannelRow(trigger.channelId);
  if (!agent || !me || me.deactivated || !ch) return;
  const depth = json<MessageMeta>(getMessageMeta(trigger.id), {}).agentDepth ?? 0;
  const replyThread = trigger.threadRootId ?? null;
  const post = (text: string) =>
    postMessage({ channelId: ch.id, userId: agentId, text: encodeTokens(text), threadRootId: replyThread, source: 'agent', agentDepth: depth + 1 });

  const provider = activeProvider();
  let run: (input: RunInput) => Promise<string>;
  let errorReason: (e: unknown) => string;
  const model = agentModel(agent.model) || workspaceDefaultModel();
  if (provider === 'anthropic') {
    const api = getClient();
    if (!api) {
      post('⚠️ I’m not connected to an AI model yet. A workspace admin needs to add an Anthropic API key in *Workspace settings → AI agents*.');
      return;
    }
    run = (input) => runAnthropic(api, input);
    errorReason = anthropicErrorReason;
  } else {
    const def = providerDef(provider);
    const conn: OpenAIConn = { provider, baseUrl: providerBaseUrl(provider), key: providerKey(provider) };
    if ((def.needsKey && !conn.key) || !conn.baseUrl || !model) {
      post(
        `⚠️ I’m not connected to an AI model yet. A workspace admin needs to finish the ${def.name} setup (API key and model) in *Workspace settings → AI agents*.`,
      );
      return;
    }
    run = (input) => runOpenAI(conn, input);
    errorReason = (e) => openAIErrorReason(e, conn, model);
  }

  // typing indicator while we work
  const typing = () => toChannel(ch.id).emit('typing', { channelId: ch.id, threadRootId: replyThread, userId: agentId });
  typing();
  const typingTimer = setInterval(typing, 3000);

  try {
    const finalText = await run({
      agent,
      model,
      system: systemPrompt(agent, me),
      context: buildContext(agentId, trigger, ch),
      images: loadImages(trigger),
      ctx: { agentId, trigger, depth },
      onRound: typing,
    });
    if (finalText) post(finalText);
  } catch (e) {
    console.error(`[agents] ${provider} API error`, e);
    post(`⚠️ Sorry, I couldn’t answer: ${errorReason(e)}.`);
  } finally {
    clearInterval(typingTimer);
  }
}

/** Agents can reply: the active provider has what it needs (key, base URL, model). */
export function agentApiConfigured() {
  const provider = activeProvider();
  if (provider === 'anthropic') return !!anthropicKey();
  const def = providerDef(provider);
  return (!def.needsKey || !!providerKey(provider)) && !!providerBaseUrl(provider) && !!workspaceDefaultModel();
}

/** The active provider's key comes from the environment. */
export function agentKeyFromEnv() {
  return keyFromEnv(activeProvider());
}

export function storedKeyPresent() {
  return !!storedKey(activeProvider());
}

let started = false;
export function initAgents() {
  if (started) return;
  started = true;
  bus.on('posted', (msg: Message) => {
    try {
      onPosted(msg);
    } catch (e) {
      console.error('[agents] trigger failed', e);
    }
  });
}

export { isActiveAgent };

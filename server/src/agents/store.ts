import type { AgentInfo } from '../../../shared/types.ts';
import { all, get } from '../db.ts';
import { activeProvider, providerKey, storedDefaultModel } from './providers.ts';

export interface AgentRow {
  user_id: string;
  role: string;
  department: string;
  instructions: string;
  model: string;
  web_search: number;
  avatar_emoji: string;
  reply_mode: string;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export const AGENT_MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', description: 'Most capable – best for complex, multi-step work (default)' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', description: 'Fast and capable – great for everyday tasks' },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', description: 'Fastest and cheapest – simple questions and triage' },
];
export const DEFAULT_MODEL = 'claude-opus-5-5';

const isClaudeModel = (id: string | undefined) => !!id && AGENT_MODELS.some((m) => m.id === id);

/** Workspace default model of the active provider ('' when none is chosen yet for a non-Anthropic provider). */
export function workspaceDefaultModel() {
  const m = storedDefaultModel();
  if (activeProvider() === 'anthropic') return isClaudeModel(m) ? m : DEFAULT_MODEL;
  return m;
}

/**
 * The model an agent uses, as shown to clients. With Anthropic it is always one of AGENT_MODELS; with any other provider
 * it is the agent's own model id, or '' for "the workspace default" (Claude ids left over from Anthropic count as '').
 */
export function agentModel(model: string) {
  if (activeProvider() === 'anthropic') return isClaudeModel(model) ? model : workspaceDefaultModel();
  return isClaudeModel(model) ? '' : model;
}

/** Model from an API request, ready to store. Anthropic only accepts AGENT_MODELS; other providers accept any id (free text). */
export function sanitizeAgentModel(model: string | undefined) {
  if (activeProvider() === 'anthropic') return isClaudeModel(model) ? model! : workspaceDefaultModel();
  return (model ?? '').trim().slice(0, 200);
}

export function serializeAgent(r: AgentRow): AgentInfo {
  return {
    userId: r.user_id,
    role: r.role,
    department: r.department,
    instructions: r.instructions,
    model: agentModel(r.model),
    webSearch: !!r.web_search,
    avatarEmoji: r.avatar_emoji,
    replyMode: r.reply_mode === 'all' ? 'all' : 'mentions',
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getAgentRow(userId: string) {
  return get<AgentRow>('SELECT * FROM agents WHERE user_id = ?', userId);
}

export function listAgents(): AgentInfo[] {
  return all<AgentRow>('SELECT a.* FROM agents a JOIN users u ON u.id = a.user_id ORDER BY a.created_at').map(serializeAgent);
}

export function isActiveAgent(userId: string) {
  return !!get('SELECT 1 FROM agents a JOIN users u ON u.id = a.user_id WHERE a.user_id = ? AND u.deactivated = 0', userId);
}

export function anthropicKey() {
  return providerKey('anthropic');
}

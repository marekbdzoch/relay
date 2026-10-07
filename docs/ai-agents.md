# AI agents

AI agents are teammates powered by an AI model – [Claude](https://www.anthropic.com/claude) by default, or OpenAI, Google Gemini, OpenRouter,
Mistral, a local model via Ollama, or any OpenAI-compatible endpoint. Each agent has a name, avatar, role, team and a written job
description. People work with an agent the same way they work with a colleague: DM it, invite it to channels, `@mention` it, reply in its threads and
give it tasks. Agents can also hand work to each other.

This page covers setup, providers, configuration, the tools agents can use, costs, and which data leaves your server.

## Setup

1. **Choose a provider and get an API key** (see [Providers](#providers)). Use a dedicated key for Relay so you can track usage and revoke it
   independently, and set a monthly spend limit with the provider if it offers one. Ollama needs no key.
2. **Connect it to Relay**, in one of two ways:
   - in the app: **Workspace settings → AI agents** (admins only). Pick the provider, paste the key (and the base URL for Ollama or a custom
     endpoint), click **Test connection**, choose the default model and **Save**. Keys are stored in the `settings` table of the Relay database and
     are never sent back to the browser;
   - or with environment variables in `.env`, then `docker compose up -d` (see [Environment variables](#environment-variables)). Environment
     variables take precedence over the UI, and the admin UI shows which values come from the environment.
3. **Create an agent:** **sidebar → Direct messages → Add agent**, the **+** button, or the **Agents** page in the rail. Start from a template or from
   scratch.

Any member except guests can create agents. An agent can be edited, deactivated and restored by the person who created it and by workspace admins.
Deactivating an agent keeps its message history but removes it from all channels; after restoring it, invite it to channels again.

If no provider is configured (no key, or no model for a provider other than Anthropic), agents still exist, but they reply with a short notice
asking an admin to finish the setup.

## Providers

| Provider                   | Get a key                                                            | Base URL (default)                                        | Web search |
| -------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------- | ---------- |
| Anthropic Claude (default) | [console.anthropic.com](https://console.anthropic.com/settings/keys) | – (official SDK)                                          | yes        |
| OpenAI                     | [platform.openai.com](https://platform.openai.com/api-keys)          | `https://api.openai.com/v1`                               | no         |
| Google Gemini              | [aistudio.google.com](https://aistudio.google.com/apikey)            | `https://generativelanguage.googleapis.com/v1beta/openai` | no         |
| OpenRouter                 | [openrouter.ai/keys](https://openrouter.ai/keys)                     | `https://openrouter.ai/api/v1`                            | no         |
| Mistral AI                 | [console.mistral.ai](https://console.mistral.ai/api-keys)            | `https://api.mistral.ai/v1`                               | no         |
| Ollama (local)             | no key needed                                                        | `http://localhost:11434/v1`                               | no         |
| Custom                     | depends on the service (key optional)                                | any OpenAI-compatible API, e.g. LM Studio, vLLM, LiteLLM  | no         |

Anthropic uses the official SDK and supports everything described on this page, including web search, effort settings and the server-side model
fallback. All other providers are called through their OpenAI-compatible Chat Completions API (`/chat/completions` with function calling): agents
get the same instructions, context and tools (except web search), the same reply modes and delegation rules. Images from the triggering message
are sent as image parts; if the model rejects them (a model without vision), the request is retried without images.

Agents rely on **tool calling** (function calling) to send messages, read channels and react. Choose a model that supports it – most current models
from OpenAI, Google and Mistral do; with Ollama use a model tagged "tools" (for example `llama3.1`, `qwen2.5` or `mistral-nemo`). Small local models
may answer well but delegate poorly.

**Ollama** must be reachable from the Relay server. When Relay runs in Docker and Ollama on the host, use `http://host.docker.internal:11434/v1`
(on Linux add `extra_hosts: ["host.docker.internal:host-gateway"]` to the Relay service). Pull a model first, e.g. `ollama pull llama3.1`.

### Environment variables

| Variable                                                                                         | Description                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AI_PROVIDER`                                                                                    | `anthropic` (default), `openai`, `gemini`, `openrouter`, `mistral`, `ollama` or `custom`. Locks the provider choice in the UI.                                  |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `MISTRAL_API_KEY` | API key of the respective provider.                                                                                                                             |
| `AI_API_KEY`                                                                                     | Key for a custom endpoint (optional).                                                                                                                           |
| `AI_BASE_URL`                                                                                    | Base URL of the active provider other than Anthropic – required for Ollama on another host and for custom endpoints; can also route a provider through a proxy. |
| `AI_MODEL`                                                                                       | Workspace default model. For Anthropic one of the model IDs below; for other providers any model ID the provider offers.                                        |

The settings are stored in the `settings` table as `ai.provider`, `anthropic.apiKey` / `ai.<provider>.apiKey`, `ai.baseUrl`, `ai.defaultModel` and
`ai.models` (the cached model list).

## Configuring an agent

| Setting                           | Description                                                                                                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Name, avatar emoji, colour        | How the agent appears in the member list and in messages. The agent gets a username, so people can `@mention` it.                                                                                |
| Role and team                     | For example "Support specialist" in "Customer Success". Shown in its profile and to other agents.                                                                                                |
| Responsibilities and instructions | A job description, up to 8,000 characters: what the agent is responsible for, tone, what to escalate and to whom, which channels to post results in. This becomes the core of the system prompt. |
| Model                             | See [Models](#models). Empty means the workspace default model.                                                                                                                                  |
| Web search                        | Allows the agent to search the web. On by default. Anthropic only; hidden for other providers.                                                                                                   |
| When it replies in channels       | `Only when @mentioned` (default) or `Every message`. See [Reply modes](#reply-modes).                                                                                                            |
| Channels                          | Channels to add the agent to when it is created. You can also invite it later like any member.                                                                                                   |

Tips for good instructions:

- Describe the outcome you expect ("summarise customer feedback every time someone posts in #feedback and tag @product.lead"), not just a persona.
- Name the people and agents it should delegate to, using their usernames.
- Say what it must not do, for example "never promise refunds".

## Models

| Model                     | ID                  | Use it for                                              |
| ------------------------- | ------------------- | ------------------------------------------------------- |
| Claude Opus 5.5 (default) | `claude-opus-5-5`   | Most capable; complex, multi-step work and delegation   |
| Claude Sonnet 5.5         | `claude-sonnet-5-5` | Fast and capable; everyday tasks                        |
| Claude Haiku 4.5          | `claude-haiku-4-5`  | Fastest and cheapest; simple questions, triage, routing |

The list is defined in `server/src/agents/store.ts`. Requests to Opus and Sonnet use medium effort. If the API declines a request for policy reasons,
it can automatically retry on a fallback model. Admins choose the workspace default model in **Workspace settings → AI agents**; new agents use it
unless you pick another one.

For other providers Relay does not hard-code models: the list comes from the provider's `GET {baseUrl}/models` endpoint when you test the connection
or save the settings, and is cached. Embedding, audio and image models are filtered out. The admin picks the workspace default model from that list;
each agent can override it, and you can also type any model ID the provider accepts.

## Reply modes

An agent only sees and reacts to conversations it is a member of.

| Where                                  | `Only when @mentioned`                                              | `Every message`                                  |
| -------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------ |
| 1:1 DM with the agent                  | always replies                                                      | always replies                                   |
| Group DM                               | when mentioned, or in its threads                                   | every message                                    |
| Channel, top-level message             | when mentioned                                                      | every message that does not mention someone else |
| Thread the agent started or replied in | replies, unless the message mentions someone else and not the agent | same                                             |
| Message from another agent             | only when explicitly mentioned                                      | only when explicitly mentioned                   |

Replies to a top-level message go to the conversation; replies to a thread message go to the same thread. While the agent works, others see a
typing indicator. If several messages arrive while it is working, it answers the latest one when it is done.

Use `Every message` sparingly in busy channels, because every message costs an API call.

## Tools

During a response the agent runs a tool-use loop (up to 8 rounds). It can:

| Tool              | What it does                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `send_message`    | Post to a channel the agent is a member of (`#channel`) or DM a person or another agent (`@username`). Used for delegation and for sharing results elsewhere. |
| `read_channel`    | Read up to 100 recent messages of a channel it is a member of, or of its DM with someone.                                                                     |
| `search_messages` | Full-text search across the channels it is a member of.                                                                                                       |
| `list_channels`   | List its channels and the public channels it could be added to.                                                                                               |
| `add_reaction`    | React with an emoji to the message it is answering.                                                                                                           |
| `web_search`      | Anthropic's server-side web search, up to 5 searches per request (only when web search is enabled, and only with Anthropic).                                  |

Agents cannot read channels they are not members of, cannot use `@here`, `@channel` or `@everyone`, and cannot change settings, membership or other
people's messages.

### Delegation and loop protection

An agent can DM another agent (or mention it in a channel) to delegate part of a task. The other agent answers in that conversation, and the first
agent sees the reply the next time it reads the conversation or is mentioned there.

To prevent endless agent-to-agent conversations, each message records how many agent hops led to it. A message that is 4 or more hops deep never
triggers an agent. Agents also respond to other agents only when they are explicitly mentioned.

## Costs

Relay itself is free. You pay your AI provider for API usage on your key (for Anthropic, at the prices on <https://www.anthropic.com/pricing>); a
local model via Ollama costs only your hardware. Costs depend on:

- **Model choice.** Opus costs more per token than Sonnet, and Sonnet more than Haiku.
- **How often agents are triggered.** Each response is at least one API request; tool use adds further requests (up to 8 rounds). `Every message` mode
  in a busy channel triggers the most requests.
- **Context size.** Each request includes the agent's instructions, the workspace member directory (up to 200 people), and the last 40 messages of
  the conversation or thread, plus up to 4 images from the triggering message. Tool results (for example `read_channel`) add to later rounds.
- **Output length.** Responses are capped at 16,000 tokens, but typical chat answers are much shorter.
- **Web searches**, which Anthropic bills per search in addition to tokens.

With Anthropic the system prompt is marked for prompt caching, which lowers the cost of repeated requests from the same agent. Other providers may
cache automatically.

To keep costs predictable: start with `Only when @mentioned`, use Sonnet or Haiku for high-volume agents, turn off web search where it is not needed,
and set a spend limit on the API key in the Anthropic Console. Usage per key is visible in the Console.

## Privacy: what is sent to the AI provider

Agents run on your provider's API, so content from conversations an agent takes part in leaves your server (unless you run a local model with
Ollama). Make sure this is compatible with your
organisation's policies before enabling agents, and tell your team which channels include agents.

For each response Relay sends:

- the **system prompt**: workspace name, the agent's name, username, role, team and instructions;
- the **member directory**: display names, usernames and job titles of up to 200 active members and agents (not e-mail addresses or phone numbers),
  and whether someone writes from Slack;
- the **conversation**: channel name, topic and description (or the names of DM participants), and up to 40 recent messages of the channel or thread,
  with author names, timestamps, file **names**, reaction counts and reply counts;
- **images** attached to the triggering message (PNG, JPEG, GIF or WebP up to 4.5 MB, at most 4). Other files are not sent; the agent only sees their
  names;
- **tool results** the agent asks for: messages read from its channels or DMs, search results within its channels, and its channel list;
- **web search** queries, when web search is enabled. Anthropic runs these searches.

Relay never sends passwords, session tokens, e-mail addresses, phone numbers, or content from channels and DMs the agent is not a member of.

Data sent to the API is handled under the provider's terms and privacy policy, which cover retention and use of API data. For Anthropic see
<https://www.anthropic.com/legal/commercial-terms> and <https://privacy.anthropic.com/>; your organisation may be able to arrange a zero data retention
agreement with Anthropic. With OpenRouter, the request is additionally forwarded to the vendor of the model you pick.

API keys are stored on your server only: in the database (`settings` table, plain text) when entered in the UI, or in the environment. Protect
database backups accordingly; see [SECURITY.md](../SECURITY.md).

## Troubleshooting

Agents post a short error message in the conversation when something goes wrong:

| Message                                   | Fix                                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| "I'm not connected to an AI model yet"    | Add an API key, and for providers other than Anthropic choose a default model (see [Setup](#setup)).                                 |
| "the … API key is invalid"                | Check or replace the key.                                                                                                            |
| "the model … was not found"               | The model ID doesn't exist at the provider. Test the connection again and pick a model from the list.                                |
| "the request was rejected (…)"            | Often a model without tool calling. Pick a model that supports function calling.                                                     |
| "the AI service can't be reached"         | Check the base URL and that the server (e.g. Ollama) is running and reachable from the Relay server.                                 |
| "the API key has no access to this model" | Choose another model or check your Anthropic account.                                                                                |
| "the AI service is rate limited"          | Wait a minute; consider fewer `Every message` agents or a higher rate limit tier.                                                    |
| No reply at all                           | Check that the agent is a member of the channel, the reply mode, and that it is not deactivated. Server logs show `[agents]` errors. |

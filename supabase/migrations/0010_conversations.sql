-- Persisted agent-run email threads (the "chat conversations" layer).
--
-- Each conversation maps to an AgentMail thread. Dawn sends and receives on it;
-- every message (inbound or outbound) is stored, with `parsed` holding the
-- intent Dawn extracted from an inbound reply (did they opt in? did they
-- propose times?). This is what lets the agent pick a conversation back up
-- statefully when a reply arrives via the AgentMail webhook.
create table if not exists conversations (
  id               uuid primary key default gen_random_uuid(),
  introduction_id  uuid references introductions(id) on delete cascade,
  inbox_id         text,               -- AgentMail inbox id
  thread_id        text,               -- AgentMail thread id (set once the first message is sent/received)
  subject          text,
  participants     jsonb not null default '[]'::jsonb,  -- [{person_id, email, role}]
  purpose          text not null default 'opt_in',      -- opt_in | scheduling | onboarding
  state            text not null default 'open',        -- open | closed
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint conversations_purpose_check check (purpose in ('opt_in','scheduling','onboarding')),
  constraint conversations_state_check check (state in ('open','closed'))
);

create index if not exists conversations_thread_idx on conversations(thread_id);
create index if not exists conversations_introduction_idx on conversations(introduction_id);

create table if not exists messages (
  id                    uuid primary key default gen_random_uuid(),
  conversation_id       uuid not null references conversations(id) on delete cascade,
  agentmail_message_id  text,
  direction             text not null,   -- inbound | outbound
  from_email            text,
  to_emails             text[] not null default '{}',
  subject               text,
  body                  text,
  parsed                jsonb not null default '{}'::jsonb,  -- LLM-extracted intent for inbound replies
  created_at            timestamptz not null default now(),
  constraint messages_direction_check check (direction in ('inbound','outbound'))
);

create index if not exists messages_conversation_time_idx on messages(conversation_id, created_at);
create index if not exists messages_agentmail_idx on messages(agentmail_message_id);

-- RLS intentionally left disabled for this prototype, consistent with the rest.

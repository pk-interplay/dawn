-- Chat threads: persistence for the member ↔ Dawn conversation at /chat.
--
-- Named chat_threads / chat_messages because `conversations` and `messages` (0010) are
-- the AgentMail email layer and mean something else entirely.
--
-- RLS stays ENABLED with no policies, unlike the email tables in 0012_disable_rls.sql.
-- That is deliberate: chat content is the most private thing in the product, and every
-- access path goes through the service-role client with the entity check done in the
-- handler. Deny-by-default for the publishable key means a slip in a client query
-- cannot leak someone else's conversation.

create table if not exists chat_threads (
  -- Client-generated so the browser knows the id before the first turn streams and can
  -- put it in the request body. No round trip to learn what thread you are in.
  id uuid primary key,
  entity_id uuid not null references entities(id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists chat_threads_entity_updated
  on chat_threads (entity_id, updated_at desc);

create table if not exists chat_messages (
  -- Also client/SDK-generated: the AI SDK gives every UIMessage a stable id, and reusing
  -- it makes the "persist the user turn" insert idempotent across retries.
  id text primary key,
  thread_id uuid not null references chat_threads(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  -- The UIMessage.parts array stored verbatim: text, tool calls and all. Rendering the
  -- history is then the same code path as rendering a live stream.
  parts jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_thread_created
  on chat_messages (thread_id, created_at);

alter table chat_threads enable row level security;
alter table chat_messages enable row level security;

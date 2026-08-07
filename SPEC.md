# Interplay Nexus — Technical Specification v0.2

**Status:** Draft for engineering review
**Supersedes:** Technical Specification v0.1 (2026-08-04)
**Companion to:** Project Dawn PRD v0.2 (June 2, 2026)
**Date:** August 4, 2026

---

## 0. What changed from v0.1, and why

v0.1 is architecturally right and phased wrong. It describes the full product across four sequential phases, which means the loop that makes the product interesting — ingest → graph → match → intro → reply → graph — does not close until the third phase. Everything learned before that point is learned about half a system.

v0.2 specifies **the same product as one thin vertical slice**: every layer present, each one minimal. It is not a subset of v0.1's scope with the back half deleted. Three of v0.1's structures are heavier than the claims model requires, and removing that weight is where the speed comes from:

| v0.1 | v0.2 | Why it is faster *and* no worse |
|---|---|---|
| Five entity types (Person, Organization, Investor Profile, Founder Profile, Service Provider) each with typed attributes (§4) | **One `entities` table with a `kind`, and everything else is a claim** | An investor's thesis is `attribute='thesis'`. Check size is `attribute='check_size'`. Typed profile tables re-introduce exactly the in-place-update problem `claims` exists to solve. This is *more* faithful to §3.1, not less. |
| Multi-step campaigns with `steps jsonb`, `step_index`, `next_action_at`, and a state machine over `pgmq` (§6) | **Single-step asks.** One email, wait for a reply, done. | Sequencing is where the workflow complexity lives — invisible queue messages, halting on reply, deploy-safe replay. None of it is needed to ask an investor what they're deploying into. Add follow-ups when there is evidence a follow-up lifts reply rate. |
| Six independently-versioned LLM functions (§7) | **Four.** `extract_claims` absorbs `interpret_reply`; `adjudicate_conflict` is deferred. | Both absorbed functions are the same shape — text in, claims out with confidence. `contested` is already a boolean; a human resolving it in the review queue is better than a model adjudicating, and cheaper. |
| `pgmq` + Edge Function workers + `pg_cron` (§2.1, §5) | **`pg_cron` → Next.js route handlers**, as `dawn-v0` already does | With no multi-day sequences there is no long-running work to survive a deploy. `pgmq` is the right answer at volume; it is not the right answer for the first version, and it is additive later. |

Retained from v0.1 without change, because each is expensive or impossible to retrofit: append-only claims with provenance (§2), `observed_at` on every claim, consent and suppression as a hard gate on the send path (§6.3), send idempotency (§6.2), and sender-identity separation (§6.1).

**What is dropped outright**, with the trigger that should bring it back:

| Dropped | Bring it back when |
|---|---|
| Licensed data connectors (PitchBook, Crunchbase, Clearbit) | The mailbox-derived graph is queried often enough that coverage gaps are the top complaint. This is also the largest unpriced line item in the project. |
| Digests, text or voice | Someone asks twice. |
| Multi-tenant | Interplay is using it daily and wants a second org. Note this is also the Google-verification cliff — see §3.3. |
| iMessage | Never, absent a sanctioned API. Use SMS/RCS or WhatsApp Business if a second channel is genuinely wanted. |
| Conflict adjudication as an LLM function | The review queue's contested list is long enough to be annoying. |
| Trained ranking ("self-learning") | Never, at this data volume. See §8. |

---

## 1. Architectural principle (unchanged from v0.1)

The durable asset is the claim store. The model calls are a thin, replaceable layer above it.

| Layer | Component | Ownership |
|---|---|---|
| 4 | Agent surface — MCP tools consumed by Hermes; review queue | Thin, swappable |
| 3 | Typed LLM functions — extract, rank, draft, summarize | Thin, swappable |
| 2 | Scheduler + send gateway | Build and own |
| 1 | Claim store — append-only, provenance per claim | Build and own |

If replacing the model or the agent framework requires touching the schema, the boundary has leaked.

---

## 2. Data model

### 2.1 Claims, not fields

```sql
create table entities (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  kind         text not null check (kind in ('person','organization')),
  -- Denormalised for display and search only. Never written by hand — always
  -- projected from claims, so it can be rebuilt and can never disagree.
  display_name text,
  summary      text,
  embedding    vector(1536),
  created_at   timestamptz not null default now()
);

create table claims (
  id            bigserial primary key,
  workspace_id  uuid not null,
  subject_id    uuid not null references entities(id) on delete cascade,
  attribute     text not null,          -- 'role' | 'thesis' | 'check_size' | 'wants' | …
  value         jsonb not null,
  source        text not null,          -- 'gmail:<msg_id>' | 'reply:<thread_id>' | 'form' | 'manual'
  method        text not null check (method in ('self_reported','enriched','inferred','manual')),
  confidence    numeric(3,2) not null check (confidence between 0 and 1),
  observed_at   timestamptz not null,   -- when the fact was true, not when we wrote it
  evidence      text,                   -- the sentence it came from, for the review queue
  superseded_by bigint references claims(id),
  created_at    timestamptz not null default now()
);

create index on claims (subject_id, attribute) where superseded_by is null;
create index on claims (workspace_id, attribute, observed_at) where superseded_by is null;
```

Writes are inserts. Never updates. Two live claims on one `(subject_id, attribute)` with different values *is* the conflict flag — no separate table.

**`embedding` is 1536, not v0.1's 1024.** `dawn-v0`'s existing pgvector indexes and the `embed()` helper are 1536 (OpenAI `text-embedding-3-small`). Matching that means the embedding pipeline is reused rather than rebuilt.

**`evidence` is new.** A claim a human has to approve is only reviewable if they can see the sentence it came from. Without it the review queue asks people to rubber-stamp assertions with no basis, which is how a review queue becomes a formality.

### 2.2 The resolved view

```sql
create view resolved_attributes as
select distinct on (subject_id, attribute)
  subject_id, attribute, value, source, method, confidence, observed_at, evidence,
  count(*) over (partition by subject_id, attribute) > 1 as contested,
  now() - observed_at > interval '90 days' as stale
from claims
where superseded_by is null
order by subject_id, attribute,
  (method = 'self_reported') desc,   -- PRD §4: self-reported wins for subjective fields
  confidence desc,
  observed_at desc;
```

`contested` powers the review queue. `stale` powers the freshness loop *and* PRD §2's "≥80% verified within 90 days" target — both become one-line queries rather than features.

### 2.3 Edges

```sql
create table edges (
  id           bigserial primary key,
  workspace_id uuid not null,
  from_id      uuid not null references entities(id) on delete cascade,
  to_id        uuid not null references entities(id) on delete cascade,
  kind         text not null,      -- knows | invested | served | introduced | invited
  strength     numeric(3,2),
  source       text not null,
  observed_at  timestamptz not null,
  unique (from_id, to_id, kind, source)
);
```

Stay in Postgres. Queries are one or two hops; recursive CTEs handle that at this volume. Reuse `recompute_relationship_strength` from `dawn-v0` migration `0008` for time decay — it already exists and works.

### 2.4 Entity resolution — never hard-merge

```sql
create table entity_links (
  id         bigserial primary key,
  left_id    uuid not null references entities(id) on delete cascade,
  right_id   uuid not null references entities(id) on delete cascade,
  confidence numeric(3,2) not null,
  basis      text not null,     -- what matched: 'email' | 'name+org' | 'thread'
  status     text not null default 'candidate',  -- candidate | confirmed | rejected
  unique (left_id, right_id)
);
```

Two investors named Chen at different funds, and one person changing firms, are the common cases. A bad merge is invisible until it produces a wrong intro, so nothing merges automatically. Reuse the cross-check pattern from `validateMatches` (`src/lib/rerank.ts`): never trust a model-supplied entity reference unless a second field agrees.

### 2.5 Tenancy

`workspace_id` on every table with RLS enabled and policies written, even shipping single-tenant. **No `disable row level security` statement appears anywhere in the chain** — `dawn-v0` migrations `0012` and `0013` did that, and `0013`'s own header records the cost: RLS on with zero policies silently rejected every `intros` insert, so the rate limiter it backed read zero forever and *"existed in code but was a no-op in production."*

---

## 3. Email layer

> **Status: not built, and the `dawn-v0` implementation it draws on has been removed.**
>
> The AgentMail two-way inbox, the inbound webhook, `triage.ts`, and the inbox/exchange
> UI are all deleted; `src/lib/agentmail.ts` remains only as a typed no-op so the intro
> state machine still compiles, and a CI guard fails the build if any email send path
> reappears. `dawn-v0`'s double opt-in machinery (`intro-flow.ts`, `introductions`, the
> opt-in states) is kept in the repo, dark, to be rewired to a channel later.
>
> This section is therefore the **design for build step 5**, not a description of
> running code. It is kept in full because the five behaviours in §3.2 each cost a real
> incident to learn, and that is the most expensive knowledge in this document — but the
> file:line references below point at code that no longer exists in that form. Read them
> as "this is the behaviour and this is why", not as a map of the tree. Recover the exact
> shapes from git history at commit `3171c91` if step 5 needs them.

Two jobs. Conflating them is the failure that takes the product down.

### 3.1 Routing rule

| Message | Sender | Why |
|---|---|---|
| Warm intro between two people the user knows | User's mailbox (Arcade) | Best deliverability, clearest consent |
| Enrichment ask to a known contact | User's mailbox (Arcade) | Recipient recognises the sender |
| Enrichment to a stranger | Nexus inbox (AgentMail) | Isolates reputation risk from the user's domain |
| Anything product-owned | Nexus inbox (AgentMail) | Expected mail |

**Cold volume never touches a user's domain reputation.** Reverse this and one bad campaign poisons the channel the product depends on.

### 3.2 Send gateway

One function. Every send. No exceptions. Order matters:

1. **Suppression** — global opt-out, hard fail
2. **Consent** — a `not null` FK, not a lookup someone remembers to do
3. **Rate limit** — per recipient domain, per sending identity, per rolling window
4. **Idempotency** — insert the `sends` row *before* the provider call, and fail closed if that insert fails
5. **Approval** — if the ask requires it, write a draft and stop

```sql
create table sends (
  id                  bigserial primary key,
  workspace_id        uuid not null,
  ask_id              bigint not null references asks(id),
  identity            text not null,          -- 'user:<id>' | 'nexus'
  provider_message_id text,
  thread_id           text,
  body_sent           text not null,          -- the exact string, not the draft
  status              text not null,          -- draft|queued|sent|bounced|replied|suppressed
  created_at          timestamptz not null default now(),
  unique (ask_id)                             -- single-step: one send per ask
);
```

Five behaviours port from `dawn-v0`, each of which cost a real incident to find:

| Behaviour | Where it lives now |
|---|---|
| Ledger row inserted before the provider call, and **throws** if that insert fails | `intro-flow.ts:703`. Failing closed costs one window; failing open re-emails everyone every run — which is what happened while RLS silently rejected the insert. |
| Delivery helper never throws; returns `delivered` plus a typed `failure` | `agentmail.ts:93`. Collapsing "chose not to send" and "delivery failed" into one boolean is how a broken send masquerades as deliberate silence. |
| One bad send must not abort the batch | `intro-flow.ts:730` — contains the throw, marks that item terminal, continues. |
| Persist the exact string sent, not the draft | The unsubscribe footer is composed once and *that* string is stored. It is the part you most need to be able to prove. |
| Approval gate | `client.inboxes.drafts.create()` → review queue → `drafts.send()`. Verified present in `agentmail@0.5.17`. |

### 3.3 Gmail scopes — a launch dependency, not a compliance footnote

Verified against Google's live scope list, 2026-08-04:

- **`gmail.modify` is a *restricted* scope**, not sensitive. So are `readonly`, `compose`, `insert`, `metadata`. The line is *reading message content*, not deletion. Only `gmail.send` is sensitive; `gmail.labels` is non-sensitive.
- **CASA (third-party security assessment) triggers on *storing or transmitting* restricted-scope data.** Nexus stores claims derived from content, so it is in scope.
- **Internal-use apps are exempt from verification and CASA**, with no 100-user cap: *"The app is only used by people in your Google Workspace or Cloud Identity organization."*

| v1 shape | Verification | CASA |
|---|---|---|
| Internal-only to Interplay's Workspace | Not required | Not required |
| Any external user at another domain | Required | Required |

**Ship internal-only.** This is not a preference — it is the only configuration that does not put a third-party security assessment on the critical path. Re-verify before submitting anything; Google changes these classifications.

### 3.4 Inbound

Reuse `src/lib/triage.ts` essentially as-is. It is the gate in front of the model, ordered cheapest-first so the one paid call is last:

1. Replay guard on provider message id — the provider retries, and without this a retry re-runs everything
2. Self-send loop guard
3. Sender resolution, including the plus-address thread alias
4. **Trust:** unauthenticated mail (no SPF/DKIM) may act *only* inside a thread Nexus started with that same person. Rejecting it outright locks out every contact whose domain lacks DKIM — and "contact replies yes, Nexus never answers" is the worst failure available
5. Per-entity hourly ceiling

Invariant: **every inbound message writes exactly one audit row, including refusals.** That row is simultaneously the replay guard, the rate counter, and the audit trail. A silently dropped message is indistinguishable from one that never arrived.

---

## 4. Asks — replacing campaigns

A single-step outreach. No sequencing, no step index, no queue.

```sql
create table asks (
  id                bigserial primary key,
  workspace_id      uuid not null,
  entity_id         uuid not null references entities(id) on delete cascade,
  kind              text not null,   -- enrichment | intro_invite | onboarding
  attribute         text,            -- the field this ask is trying to refresh
  identity          text not null,   -- routing, per §3.1
  requires_approval boolean not null default true,
  state             text not null default 'pending',
                                     -- pending|awaiting_approval|sent|replied|bounced|halted
  due_at            timestamptz not null default now(),
  created_at        timestamptz not null default now()
);

create index on asks (due_at) where state = 'pending';
```

`pg_cron` selects due rows and POSTs a Next.js route, exactly as `dawn-v0`'s `dawn-run-matches` does today. One state transition per invocation. A reply flips `state` to `replied`, which is retractable — unlike a delayed queue message, which cannot be inspected or cancelled.

**Freshness loop** — one cron job, and the whole differentiator:

```sql
-- Everything stale, not yet asked about, not suppressed → an ask.
insert into asks (workspace_id, entity_id, kind, attribute, identity)
select r.workspace_id, r.subject_id, 'enrichment', r.attribute, 'nexus'
from resolved_attributes r
where r.stale
  and not exists (select 1 from asks a
                  where a.entity_id = r.subject_id and a.attribute = r.attribute
                    and a.created_at > now() - interval '90 days')
  and not exists (select 1 from suppressions s where s.entity_id = r.subject_id);
```

Suppression and consent are checked at **enrolment**, not only at send. An ask that should never have existed is worse than one that fails to send.

---

## 5. LLM layer

Four typed functions. Schema-in, schema-out. Independently versioned and evaluated. **None is an agent loop** — sequencing is a table, confidence routing is a threshold, and nothing needs a model to decide what to do next.

| # | Function | Model | Notes |
|---|---|---|---|
| 1 | `extract_claims` — text → candidate claims + confidence + evidence | `claude-haiku-4-5-20251001` | Absorbs v0.1's `interpret_reply`. Both were text-in/claims-out; one function, one prompt, one eval set. |
| 2 | `rank_matches` — candidates + brief → ranked, reasoned | `claude-opus-5` | **Already built.** `src/lib/rerank.ts` + `validateMatches`. Port the query underneath it, keep the function. |
| 3 | `draft_outreach` — context → subject + body | `claude-sonnet-5` | Reuse `draftEmail`'s deterministic fallback pattern: a model failure must not dead-end a transition. |
| 4 | `summarize_entity` — claims → prose for embedding | `claude-haiku-4-5-20251001` | Mechanical. |

### 5.1 Implementation rules

- **Structured output via `output_config: { format: { type: "json_schema", schema } }`.** Not forced tool use — that is the pre-structured-outputs workaround. `rerank.ts` and `parseReplyIntent` already do this correctly; `draftEmail` and `join/profile` still use `tool_choice` and should move.
- **The API does not enforce recursive schemas or numeric/string constraints** (`minimum`, `maxLength`). `confidence` must be clamped in the claim writer, not only by the Postgres check.
- **Caching is model-dependent and not monotonic.** Minimum cacheable prefix: Opus 5 **512**, Sonnet 5 **1024**, Haiku 4.5 **4096**. Both Haiku functions are the highest-volume calls and a narrow prompt plus small schema lands well under 4096, where caching silently does nothing — no error, `cache_creation_input_tokens: 0`. Verify with `npm run probe:cache`. If under, use the **Batch API** (50% off, and these are sweeps); do not pad a prompt to reach the minimum, because the padding costs more than the cache saves on every call.
- **`max_tokens` must cover thinking.** Opus 5 thinks by default when `thinking` is omitted, and `max_tokens` caps thinking *and* output together. Stream anything above ~16k.
- **Confidence is returned, not inferred.** Below the per-attribute threshold a claim is written `method='inferred'` and routed to review rather than resolved.
- **One interface:** `callFunction(name, input) → output`, model ID as configuration. Changing a model is a config change.

### 5.2 Reply path

```
webhook → triage (§3.4) → extract_claims
  → confidence ≥ threshold → claim written, resolved
  → confidence < threshold → claim written as 'inferred' + review queue item
  → always                 → ask.state = 'replied'
  → if sender is a user    → also claim against their own entity (PRD §5.1)
```

### 5.3 Evaluation

Built with the first function, not after. PRD §10 names reply-interpretation accuracy as a top risk, and it is only measurable if extraction is an isolated function.

- Every review-queue correction writes `(input, model_output, corrected_output)`
- Seed set: `dawn-v0`'s `matches` rows with `status in ('accepted','rejected')` — real human judgments on real rationales, and **the only labeled data the project has ever produced.** Export before dropping the schema; `npm run export:eval-fixtures`.
- CI fails on regression. Runner and workflow now exist (`vitest`, `.github/workflows/ci.yml`); the repo previously had neither.

Be precise about what that seed data is: one pair a human accepted or declined. It supports **pairwise preference** and a **regression floor**, not "did the model return the right top five" — nothing recorded which candidates lost.

---

## 6. Surfaces

- **Review queue** — contested attributes, low-confidence claims, candidate entity links, drafts awaiting approval. Each row shows `evidence` (§2.1), or approving is rubber-stamping.
- **Entity view** — every attribute with source, method, confidence, `observed_at`, and whether it is contested or stale.
- **MCP tools over the graph**, consumed by Hermes. This is the *operator* conversational surface, and it needs no Next.js UI of its own.
- **Dawn chat** (`/chat`) — the *member-facing* conversational surface, added after this spec was written. Amends the original line here, which read "No chat UI in Next.js; the conversational surface already exists."

  That line was right about Hermes and wrong as a general rule, and the landing page proved it: its only CTA said "Chat With Your Personal Super-Connector" and had nowhere to go. The two surfaces are not the same product. Hermes/MCP is an operator tool over the whole graph with no scope boundary and no session. Dawn chat is a signed-in member asking about *their* network, with a scope toggle between their own synced contacts and every teammate's — which is the warm-path question, and the reason the shared graph is worth building. It runs on its own tool set (`src/lib/network-tools.ts`) reading `entities`/`edges`/`resolved_attributes`, and it deliberately exposes `contested` and `stale` in conversation, which is the review queue's value delivered without a second UI.

Reuse `/admin/monitor`'s tab shell, `requireAdmin`, and `adminFetch` for the operator surfaces above. The constellation view (`/admin/graph`) is a deliberate exception: it reads the claims model where monitor's tabs read legacy `people`/`matches`, and one tab strip over two live data models would assert they are the same dataset.

---

## 7. Build order

Not phases. One loop, closed, then widened. Each step is shippable and the system runs after every one.

| # | Step | Closes |
|---|---|---|
| 1 | `entities`, `claims`, `edges`, `entity_links`, `resolved_attributes`, RLS. Claim writer as the only path in. | — |
| 2 | Arcade Gmail ingest, **metadata only** → `edges` + `display_name`. `ListThreads`/`SearchThreads` return metadata-only rows by default, so this is the default path, not a workaround. | A real graph exists |
| 3 | `summarize_entity` + embeddings. Port `fetchCandidates` and `rank_matches` onto `resolved_attributes`. | **Query works** |
| 4 | Bodies via `include_body` → `extract_claims` → claims. Review queue with `evidence`. | Graph gets richer, humans can correct it |
| 5 | Send gateway + consent + suppression + `asks`. `draft_outreach`. Intro invite as an ask, approval-gated. | **Loop closes: query → intro → reply → claim** |
| 6 | Freshness cron (§4). | **Differentiator lands: the graph updates itself** |

Step 3 is the first genuinely useful moment: Interplay can query their own collective network. Step 5 is the first complete loop. Step 6 is the thing v0.1 took three phases to reach.

**Before step 1:** freeze the `dawn-v0` pilot (`select unschedule_dawn_jobs();`, then `npm run personas -- --reset`, then tell the teammates), and export the eval fixtures. The fixtures are unrecoverable once the schema drops.

---

## 8. Two things to say out loud

**"Continually self-learning" is not in this architecture, or in v0.1's.** At the PRD's target of 100 accepted intros per month the feedback loop produces ~1,200 labeled examples a year — far short of training a ranker. Match quality here comes from good retrieval over current records plus model reasoning. The eval harness (§5.3) is the honest version of the claim: it makes quality measurable and improvable through prompt and retrieval iteration. The phrase carries significant weight in the pitch (PRD §1, §5.2) and very little in the build, and that gap should be closed in the pitch rather than papered over in the spec.

**The LLM bill is not the constraint.** At this scale it is tens of dollars a month. Licensed data sources will exceed it by one to two orders of magnitude, which is why they are dropped from v0.2 rather than deferred — the mailbox-derived graph is useful on its own, and buying coverage before anyone has queried the graph is spending ahead of evidence.

---

## 9. Decisions required before step 1

1. **Single-tenant, internal to Interplay's Workspace.** Recommended, and §3.3 makes it close to obligatory — it is the only shape that keeps CASA off the critical path. `workspace_id` everywhere preserves the option to change.
2. **Per-attribute freshness thresholds.** §2.2 defaults to 90 days for everything, which is wrong for most fields. Thesis, role, check size, and contact details each need a number.
3. **Confidence threshold for auto-resolve vs review.** Start at 0.8 and tune against §5.3.
4. **Arcade's TypeScript path.** The documented SDK is Python; TS is REST or MCP. One-day spike — it is the only unverified external dependency in this spec.

---

## 10. Open risks

| Risk | Handling |
|---|---|
| Arcade has no first-class TS path | One-day spike (§9.4). Fallbacks: REST, or an MCP client from a route handler. |
| Bad entity merge produces a wrong intro | Never auto-merge (§2.4). Candidates go to review. |
| Extraction fills the graph with junk attributes | A controlled attribute vocabulary, and `dawn-v0`'s hard-won distinction: **a reason is not a claim.** "Already knows them" is a decline reason, useless as a stored preference. |
| Deliverability degradation | Identity separation (§3.1) is the structural defence. Add per-identity, per-domain reply and bounce rates, with a threshold that flips asks to `halted`. |
| Caching assumption wrong on Haiku | Measured, not assumed (`npm run probe:cache`). Batch API is the fallback. |
| Cron silently failing | `pg_net` is asynchronous, so `cron.job_run_details` reports `succeeded` for a call that returned 401. Reuse `dawn_job_health()`, which reads `net._http_response` directly. Never join run details to `cron.job` on `jobid` — rescheduling drops the history. |

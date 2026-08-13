# Roadmap

Where the build actually is against SPEC §7's build order, what just landed, and what
the next decision is.

SPEC §7 is the plan; this file is the status. Where they disagree, this file is
describing the repository and SPEC is describing the intent — that gap is the useful
part, so it is written down rather than reconciled by editing the spec.

**Last updated:** 2026-08-12, after the send gateway + agentic cadence work.

---

## The one-line version

Steps 1–3 are built, step 4 is partial, **step 5 is half-landed and switched off**, step
6 hasn't started. The blocker is not code: it is that the system now has **two live data
models**, and the half of step 5 that just shipped was built on the older one.

---

## Status by build step

| # | Step | State | Notes |
|---|---|---|---|
| 1 | `entities`, `claims`, `edges`, `entity_links`, `resolved_attributes`, RLS. Claim writer as the only path in. | **Done** | 0026. CI enforces `claims.ts` as the only writer. |
| 2 | Gmail ingest, metadata only → `edges` + `display_name` | **Done** | `gmail-ingest.ts`, `network-ingest.ts`. 128 entities in the linked project. |
| 3 | `summarize_entity` + embeddings. Port `fetchCandidates` / `rank_matches` onto `resolved_attributes`. | **Built, not signed off** | `summarize-entity.ts`, `candidates-entities.ts`, `match_entities` (0027). See *The retrieval question* below. |
| 4 | Bodies → `extract_claims` → claims. Review queue with `evidence`. | **Partial** | `profile-claims.ts` extracts from onboarding. `/admin/graph` shows entities with provenance; there is no dedicated contested / low-confidence queue. |
| 5 | Send gateway + consent + suppression + `asks`. `draft_outreach`. Intro invite as an ask, approval-gated. | **Half done, delivery off** | See below. |
| 6 | Freshness cron (§4) | **Not started** | The five `/api/cron/*` jobs are all legacy-path. Nothing re-checks a stale claim. |

---

## What just landed (step 5, first half)

Complete and verified:

- **The send gateway** (`src/lib/send-gateway.ts`) — one function, every send, ordered
  suppression → consent → rate limit → idempotency → delivery → transmit. Consent is a
  discriminated union in TypeScript *and* a CHECK constraint in Postgres, so outreach
  with no authorising row is unwriteable and un-insertable. The ledger row is written
  before the provider call and a broken write throws.
- **`suppressions`** — global opt-out keyed by address, so it works for someone with no
  `people` row. This closed a real hole: a non-member replying "unsubscribe" previously
  resolved no person id and nothing was recorded, while every email footer promised
  otherwise.
- **`agent_notes`** — cross-run memory for the matchmaker, append-only with supersede.
- **The agentic cadence** (`src/lib/matchmaker-agent.ts`) — the hourly run is a bounded
  tool loop that reads its notes, weighs candidates, checks whether a pair already talk,
  and can decline the run. Every hard invariant stayed in the route.
- **Inbound** — `/api/agent/inbound` + `triage.ts` restored.
- **Outbox** — `/admin/monitor` → Outbox, showing the exact stored body of every message.
- **CI guards** — one transport, one caller, no alternative provider, and the kill switch
  cannot be refactored into defaulting on. All four verified to trip on planted
  violations.

**Delivery is off.** `DAWN_DELIVERY_ENABLED` defaults to off; every message is composed,
footered, stored, and held as a `draft`. `npm run verify:gateway` proves the gates refuse
what they claim to refuse (17 checks, forces delivery off, safe any time).

### What step 5 still owes

- **`draft_outreach`** — SPEC's step 5 composes outreach *for an ask*. What exists is the
  older opt-in drafting in `intro-flow.ts`, written against `people`.
- **Intro invite as an ask, approval-gated.** Drafts are reviewable, but there is no
  approve-and-send action: the gate is currently "a human reads Outbox and then flips an
  environment variable", which is right for a first cut and wrong as the permanent shape.
- **`asks` is not in the loop.** The table exists (0038) and `asks.ts` writes it from
  onboarding, but matching does not read it — `candidates-entities.ts` references it and
  is not the path the cron drives.

---

## The thing to decide next

**`people` is empty. `entities` has 128 rows.**

The matchmaker was built on the legacy `people` → `candidates.ts` → `rerank.ts` path,
because that is what the hourly cron actually drives and what the eval fixtures cover. In
the linked project that path now has **zero rows**, so the agent runs and correctly finds
nobody. Nothing is broken; there is simply nobody in the table it reads.

Everything path-agnostic — the gateway, `suppressions`, `agent_notes`, the Outbox, the CI
guards, inbound triage — works regardless and does not need revisiting. What is coupled
to `people` is the matchmaker's tools and `intro-flow.ts`.

Two ways forward, and they are genuinely different bets:

**A. Seed `people` and exercise the loop as built.**
Onboard members, `npm run personas`, read the drafts, tune the agent's judgment against
real output, then switch delivery on. Fastest path to "has anyone read a Dawn
introduction and found it good?", which is the only question that matters yet. Cost: it
invests in a data model the rest of the system is migrating away from.

**B. Cut the matchmaker over to the entity graph.**
Move the agent's tools onto `entities` / `resolved_attributes` / `asks`, and `intro-flow`
onto entity ids. Resolves the two-data-models tension and lines step 5 up with how SPEC
describes it. Cost: it blocks reading a single real introduction behind a migration, and
it requires resolving the retrieval question below first.

**Recommendation: A, briefly, then B.** The drafts are unread. Judgment quality is the
biggest open risk in the product and the cheapest thing to test, and testing it does not
require the final data model — a weak rationale reads as weak whichever table it came
from. But timebox it: every week spent adding to the `people` path is a week of work to
migrate.

### The retrieval question (blocks B)

Migration 0027 flags this explicitly and it is still unresolved: `match_entities`
collapses to **one embedding per entity**, losing the directional
`a_offers_b_wants` / `b_offers_a_wants` split that the two legacy RPCs provide at the
vector-search stage. `rerank.ts` still sees the offering/wants text and can reason about
direction, but *recall changes* — the candidate never surfaces to be reasoned about.

Directionality is the substance of a match ("both work in fintech" is a topic overlap;
"she has exactly what he is looking for" is a reason to meet), so this needs sign-off,
not silent adoption. Either restore two embeddings per entity, or measure the recall loss
against the `rank-matches` eval fixtures and accept it on evidence.

---

## Smaller open items

- **Freshness cron (step 6)** — nothing re-checks a stale claim. `resolved_attributes`
  flags `stale` at 90 days for every attribute; SPEC §9 decision 2 says thesis, role,
  check size, and contact details each need their own number, and that is still open.
- **`dawn-decay-proximity` and `dawn-expire-intros` are unscheduled** (0031) because they
  were no-ops while nothing could be delivered. Both are live paths again — schedule them
  when delivery goes on.
- **Draft-era introductions must be cleared before go-live.** They sit at `a_invited`
  with `next_action_at` armed, so the first nudge sweep would chase people about
  introductions they were never told about. SQL is in RUNBOOK step 10.
- **Review queue (step 4)** — contested and low-confidence claims are visible per-entity
  in `/admin/graph` but there is no queue to work through.
- **`/admin/monitor` reads `people`, `/admin/graph` reads the claims model.** Deliberate
  (SPEC §6: one tab strip over two live data models would assert they are the same
  dataset), and it resolves itself when B lands.

---

## Not on the roadmap, deliberately

- **Managed Agents / Anthropic memory stores.** Evaluated for the agentic cadence and
  declined for now: the memory-store primitive only exists inside Managed Agents, which
  would mean replacing `pg_cron` + `schedule_dawn_jobs()` wholesale, and a
  filesystem-backed store cannot be joined against `people` or `entities` — which is the
  actual requirement, since the matcher queries its memory during candidate selection.
  Revisit if the cadence ever needs multi-hour autonomous sessions; all agent capability
  is behind a tool interface, so the door is open.
- **Licensed data sources.** SPEC §8 — dropped rather than deferred. Buying coverage
  before anyone has queried the graph is spending ahead of evidence.
- **A trained ranker.** SPEC §8 — the feedback loop produces ~1,200 labeled examples a
  year, far short of what training needs. Quality comes from retrieval plus reasoning,
  measured by the eval harness.

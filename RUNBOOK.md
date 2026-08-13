# Pilot runbook — 5 teammates, 3 days of introductions

> ## ⚠️ The pipeline is complete; delivery is switched off.
>
> The email layer is back and wired end to end — AgentMail inbox, SPEC §3.2's send
> gateway, the inbound webhook, and the double opt-in state machine. `run-matches` is now
> an agent (`src/lib/matchmaker-agent.ts`) that opens real introductions rather than a
> pipeline that stops at a `matches` row.
>
> **Nothing is delivered.** `DAWN_DELIVERY_ENABLED` defaults to off, so every message is
> composed, given its unsubscribe footer, written to the `sends` ledger with the exact
> body, and held as a `draft`. Read them at `/admin/monitor` → **Outbox**. Flipping that
> one variable is the only remaining step to go live — see step 10.
>
> So every step below **does** execute, with one caveat: steps 6–8 advance the state
> machine and produce drafts rather than mail, and no reply can arrive until delivery is
> on. Play-the-other-side (step 8) needs step 10 first.
>
> Migration 0031 unschedules `dawn-decay-proximity` and `dawn-expire-intros`. Both are
> live paths again now that introductions are really opened, so consider scheduling them
> when you switch delivery on.
>
> **This file still needs a rewrite** once the Gmail onboarding flow and `/chat` land, at
> which point the operator story is: sign in with Google → ingest → confirm profile →
> query the graph. Kept because the environment, cron, and troubleshooting sections are
> accurate, and because the pilot's hard-won failure modes are worth preserving.

The test: a handful of real colleagues onboard at `/join`, and over the following days
Dawn emails each of them a few warm introductions. Every counterpart is fictional and
delivers to one inbox you control, so you play the other side of the network over real
email while your teammates' experience — the matching, the asking, the replying — is
entirely real.

What this exercises end to end: onboarding → embedding-based matching → double opt-in
→ inbound reply parsing → the warm introduction. What it deliberately doesn't: a
meeting actually happening — Dawn hands the thread over and stops, so whether the two
of them meet is not something the pilot can observe.

Order matters in one place. **Personas are generated from what your teammates
actually asked for**, so onboarding has to finish before you create them, and the cron
has to stay unscheduled until then. The rest is ordinary setup.

---

## 1. Deploy first

`pg_cron` calls the app over HTTPS to run matching, so that part needs a public URL.
(The other half of this — AgentMail's webhook delivering replies — no longer exists.)

```sh
vercel deploy --prod        # or your host of choice
```

## 2. Environment

Set these on the deployment (see `.env.example` for the full annotated list):

| Variable | Value for the pilot |
|---|---|
| `APP_URL` | the deployed HTTPS URL — **not** localhost |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_*` | as usual |
| `OPENAI_API_KEY` | **required** — no embeddings means no member is ever matched |
| `ANTHROPIC_API_KEY` | required by `run-matches` |
| `CRON_SECRET` | long random string; gates `/api/cron/*` |
| `ADMIN_EMAILS` / `ADMIN_EMAIL_DOMAINS` | your address / your domain, for `/admin/monitor` |
| `RESEND_API_KEY`, `AUTH_SENDER_EMAIL` | required for password reset — see step 2b |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `AUTH_SECRET` | Gmail ingest sign-in (`src/auth.ts`) |

### Email variables

| Variable | Value | Default if unset |
|---|---|---|
| `DAWN_DELIVERY_ENABLED` | `"true"` to actually deliver. **Anything else means off.** | **off** |
| `AGENTMAIL_API_KEY` | required once delivery is on; without it a live deploy fails every send loudly rather than silently pretending | — |
| `AGENTMAIL_INBOX_ID` | the inbox Dawn sends from and receives on | `dawnagent@agentmail.to` |
| `MAIL_REDIRECT_TO` | send everything here instead of the real recipient (personas have undeliverable `@example.com` addresses) | off |
| `INBOUND_AUTOREPLY` | `"true"` to let Dawn answer non-members and out-of-scope asks | off |
| `INTRO_TEST_SINGLE_SIDED` | `"true"` auto-opts-in person B so one real inbox can reach scheduling | off |

`DAWN_DELIVERY_ENABLED` is read in exactly one place — `src/lib/send-gateway.ts` — as
`=== "true"`. Unset, empty, `"TRUE"`, `"1"`, and typos all mean **off**, and CI fails the
build if anyone rewrites it as `!== "false"`. Absence must mean off; the inverted form
has already cost this project once (see `isSingleSided`).

The scripts (`npm run personas`) additionally need `SUPABASE_SERVICE_ROLE_KEY` in your
local `.env`.

Plus-addressing matters again once delivery is on: personas need one deliverable address
each so an operator can reply as them over real email. `people.email` is unique, so
`you+persona1@gmail.com` style addressing is the way to give twenty fixtures twenty
addresses that all land in one inbox. Until then they are matching fixtures only and
nothing is sent to them.

## 2b. Auth email (password reset)

> **Being removed.** Email+password auth is replaced by Google sign-in, which takes
> `/forgot-password` and this whole SMTP setup with it. Two things must happen in the
> Supabase dashboard to make "no email can be sent" actually true — clear the project's
> custom SMTP settings and disable the email auth provider — because that mailer runs on
> the platform, not in this repo, and no code change can switch it off. Do that BEFORE
> deleting `src/scripts/configure-auth.ts`; it is the tool you would use to inspect or
> revert the setting.

Auth email — the password-reset link behind `/forgot-password` — goes out through
Supabase, which needs its own SMTP. Resend provides it:

```sh
vercel integration add resend/resend-email   # accept the marketplace terms in the browser once
vercel env pull                              # brings RESEND_API_KEY into .env.local
# In Resend: Domains → add your sending domain and set the DNS records.
# Then set AUTH_SENDER_EMAIL to an address on it, and SUPABASE_ACCESS_TOKEN locally.
npm run auth:config                          # prints the current Supabase auth config
npm run auth:config -- --apply               # writes SMTP + the redirect allow list
```

Two things go wrong quietly here:

- **An unverified sending domain.** Resend refuses the message and Supabase reports
  only "error sending recovery email". Verify the domain before testing.
- **A missing redirect URL.** `<APP_URL>/reset-password` must be in the allow list, or
  Supabase drops the tokens and every reset reads as an invalid link. The script writes
  both the deployed and localhost variants; add `AUTH_PREVIEW_URL_PATTERN` if you test
  on preview deployments.

Leaving `RESEND_API_KEY` unset is not neutral: Supabase falls back to its built-in
mailer, which is capped around 2 emails/hour project-wide and can refuse anyone who
isn't a project member — so the third teammate to forget their password gets nothing.

## 3. Migrations

Apply everything through `0039`:

```sh
supabase db push        # or apply the outstanding files via the dashboard
```

`0018` adds the demo-persona marker. `0019` redefines `schedule_dawn_jobs()` for a
three-hourly cadence and adds `unschedule_dawn_jobs()` — **neither is called at
migration time**, deliberately. You call them in step 7.

`0039` adds the three tables the send gateway and the matchmaker need:

- **`sends`** — the outbound ledger. A row is written *before* the provider call and the
  gateway throws if that write fails, which is what makes a duplicate send a database
  error rather than a second email. While delivery is off, every row here is a `draft`
  holding the exact body.
- **`suppressions`** — global opt-out, keyed by address rather than by person so it still
  works for someone who has no `people` row. Checked first, hard fail.
- **`agent_notes`** — what the matchmaker learned, append-only with supersede. Not
  `claims`: a claim is a fact about a person that the ranker reads as ground truth, and a
  matchmaker's working hypotheses are not that.

## 4. Inbound email

`/api/agent/inbound` and `src/lib/triage.ts` are back. The route is the dispatcher, all
the judgement is in `triage.ts`, and the invariant is that **every inbound message writes
exactly one `inbound_events` row, including the ones Dawn refuses** — that row is
simultaneously the replay guard, the rate-limit counter, and the audit trail.

Register the `agentmail-webhook` Edge Function to POST at
`${APP_URL}/api/agent/inbound` with `Authorization: Bearer $CRON_SECRET`. Nothing will
arrive until delivery is on and someone replies, but the route is safe to enable now.

To forward replies by hand while `APP_URL` points somewhere you can't reach:

```bash
npx tsx src/scripts/replay-inbound.ts          # list what's replayable
npx tsx src/scripts/replay-inbound.ts --send   # forward them
```

Safe to re-run — the replay guard means a message forwarded twice is recorded and
ignored the second time rather than advancing the state machine twice.

**Unsubscribes.** A member who asks Dawn to stop is paused (`people.paused`), which is
reversible and matches what the reply promises. A **non-member** has no row to pause, so
their address goes into `suppressions` instead — checked first by the send gateway, ahead
of everything else. Without that, the `Reply "unsubscribe"` promise in every email footer
had no mechanism behind it for anyone who wasn't a member.

## 5. Onboard the team (day 0)

Send them the `/join` link. They sign up, talk to Dawn (or upload a LinkedIn PDF), and
land on a screen that tells them they're in, what's coming, and that the counterparts
are simulated.

Then confirm each of them actually landed:

```sql
select name, email, intro_cadence, is_synthetic, is_demo_persona,
       embedding_offering is not null as embedded
from people
where is_synthetic = false and is_demo_persona = false;
```

Every row needs `embedded = true` and `intro_cadence = 'burst'`. An unembedded member
is invisible to matching and will sit through the entire pilot receiving nothing.

## 6. Generate the personas (day 0, after onboarding)

```sh
npm run personas              # ~6 counterparts per member, written against their goals
npm run personas -- --reset   # remove the previous set first
```

**Read the printed list.** Each line names a persona and the goal it answers. This is
the single highest-leverage moment in the pilot: these are the introductions your
teammates will be offered, and a persona that doesn't ring true is a "no" that tells
you nothing about whether the product works. Re-run with `--reset` until the list
looks like people you'd actually want to meet.

## 7. Start the sequence

```sql
select vault.create_secret('https://your-app', 'dawn_app_url');
select vault.create_secret('<CRON_SECRET>',    'dawn_cron_secret');
select schedule_dawn_jobs();
```

Expect: `Scheduled dawn-run-matches (hourly), dawn-nudge-intros (every 6h at :20) and
dawn-reconcile-companies (daily 03:30 UTC). decay-proximity and expire-intros remain
intentionally unscheduled — see 0031.`

Volume is governed in three independent places and all of them have to allow it: the
schedule (every 3h), the initiating member's `intro_cadence` (`burst` = one intro per
6h), and — since migration 0036 — **the suggested person's own cadence**. That third
gate is why a run can report `no eligible match (… candidates over their own
cadence)` while both people look idle: under double opt-in the suggested party gets a
real email, so they are metered by their own tolerance, counting asks in both
directions. Lower any one of the three to slow things down.

Separately, `dawn-nudge-intros` follows up on unanswered asks at +3d and +7d and then
expires the introduction quietly (`MAX_NUDGES` in `src/lib/intro-flow.ts`). The side
that did say yes is deliberately not told it fell through. That puts the ceiling at
three Dawn emails per person per introduction. To follow up on one intro immediately:

```sh
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://your-app/api/cron/nudge-intros?introduction_id=<uuid>"
```

Want the first batch immediately rather than at the top of the next third hour:

```sh
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://your-app/api/cron/run-matches?synthetic=false&limit=10"
```

## 8. Read the drafts — do this before step 10

With delivery off, the run produces introductions and messages that go nowhere. That is
the point: **read them before anyone else can.**

`/admin/monitor` → **Outbox**. Filter to `draft`, open a few, read the exact body that
would have been transmitted — unsubscribe footer included, because the footer is stored
with the message rather than appended at send time. The banner at the top states plainly
whether delivery is on.

What to check:

- Does the opt-in ask sound like a person, and does the rationale actually say why these
  two? A rationale that could describe any two members is the failure mode to look for.
- Is the direction right — does A genuinely have what B is looking for, in that order?
- Does the run summary in the `run-matches` response agree with what got opened? The
  agent explains its reasoning there, including when it declined to open anything.
- `agent_notes` — has it written anything, and is it specific enough to be useful?

The Intros tab shows the same runs by state, and `/admin/console` → Network runs matching
for one person and records a Pass, which is the same rejection signal the calibration
loop reads.

## 9. Play the other side (daily) — needs delivery on

The heart of the original pilot: persona mail lands in one inbox, you reply as each
persona, and inbound triage attributes the reply so the double opt-in advances. Every
piece of that is back, but it needs step 10 first — with delivery off there is nothing to
reply to.

Once delivery is on: set `MAIL_REDIRECT_TO` to your inbox so persona addresses resolve,
reply as each persona, and watch `introductions` advance. If a reply doesn't land, use
`replay-inbound.ts` (step 4) before debugging anything else — the most common cause is
`APP_URL` pointing at a deployment the webhook can't reach.

## 10. Go live — switch delivery on

Deliberately last, and deliberately its own step.

**First, clear the drafts.** Everything opened while delivery was off left an
introduction in `a_invited` with `next_action_at` armed, and a `sends` row that never
went anywhere. Switch delivery on with those in place and the first nudge sweep chases
people about introductions they were never told about — the follow-up arrives before the
ask. Retire them:

```sql
-- Introductions opened while nothing could be delivered.
update introductions set state = 'expired', next_action_at = null
 where state in ('a_invited','b_invited')
   and id in (select introduction_id from sends where status = 'draft');

delete from sends where status = 'draft';
```

(Deleting the drafts also frees the idempotency key, so those pairs can be re-opened
properly on the next run rather than colliding.)

Then:

0. Prove the gates still refuse what they claim to refuse:

```sh
npm run verify:gateway
```

   Creates a throwaway synthetic pair, drives `send()` through suppression, consent,
   idempotency, and the delivery switch, and deletes everything after. It forces delivery
   off regardless of your environment, so it is safe to run at any point. 17 checks; any
   failure is a reason not to proceed.

1. Set `AGENTMAIL_API_KEY`, and `MAIL_REDIRECT_TO` if the cohort is synthetic.
2. Set `DAWN_DELIVERY_ENABLED=true`.
3. Target one real address and watch it land:

```sh
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://your-app/api/cron/run-matches?person_id=<uuid>&limit=1"
```

4. Confirm in Outbox that the row is `sent` with a `provider_message_id`. A row stuck at
   `draft` means the variable did not take; a `failed` row with
   `AGENTMAIL_API_KEY unset` means the key did not.

To stop: set `DAWN_DELIVERY_ENABLED` to anything else (or unset it). The gateway drafts
again from the next send; nothing else changes and no code is touched.

## 11. Stop, and clean up

```sql
select unschedule_dawn_jobs();   -- stop proposing; in-flight intros can still be replied to
```

```sql
-- Back to a sane cadence for anyone who stays in the network.
update people set intro_cadence = 'daily'
where is_synthetic = false and is_demo_persona = false;
```

```sh
npm run personas -- --reset      # removes personas and their history; members untouched
```

Then tell your teammates it's over. They were told the counterparts were fictional,
but nobody should be left wondering whether an intro is still coming.

---

## Failure modes worth recognising

| Symptom | Cause |
|---|---|
| No intros at all | Cron never scheduled (`select * from cron.job`), or the Vault secrets are missing |
| One member never gets an intro | No embeddings on their row, or `paused = true` |
| `run-matches` returns `skipped: "no candidates"` | Not enough personas answering that member's ask — generate more |
| Nothing is ever delivered | Expected until step 10. Check Outbox: rows at `draft` mean the pipeline is working and the switch is off. |
| `run-matches` opens nothing, and `summary` explains why | Also expected. The agent declining a weak run is a feature; read the summary before treating it as a fault. |
| Rows stuck at `draft` after step 10 | `DAWN_DELIVERY_ENABLED` isn't exactly `"true"` on that deployment. `"TRUE"`, `"1"`, and a trailing space all read as off, by design. |
| `sends.failure_reason` says `AGENTMAIL_API_KEY unset` | Delivery is on but the transport has no credentials — a deploy that thinks it's live and isn't. |
| A nudge arrives before the opt-in it follows up | Draft-era introductions weren't cleared before go-live. See the SQL in step 10. |
| Someone is emailed after unsubscribing | Should be impossible — check `suppressions` for their address, and remember a member is `people.paused` instead. Both are checked; only the second is reversible by them. |

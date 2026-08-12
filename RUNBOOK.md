# Pilot runbook — 5 teammates, 3 days of introductions

> ## ⚠️ This pilot is no longer runnable as written.
>
> The email layer it depends on has been removed: no AgentMail inbox, no send gateway,
> no inbound webhook, no inbox/exchange UI. `src/lib/agentmail.ts` is a typed no-op and
> a CI guard fails the build if any send path returns. So **steps 4 and 6–8 below cannot
> be executed** — nothing will be delivered and no reply can arrive.
>
> What still works: onboarding, embedding-based matching, `rerank`, and the
> `/admin/monitor` views. `run-matches` still computes and persists matches; it simply
> stops there instead of opening an introduction.
>
> The double opt-in machinery (`intro-flow.ts`, `introductions`, the opt-in states) is
> deliberately kept in the repo, dark, to be rewired to a channel later — see SPEC §3.2's
> send gateway, build step 5. Migration 0031 unschedules `dawn-decay-proximity` and
> `dawn-expire-intros`, both of which became no-ops.
>
> **This file needs a rewrite** once the Gmail onboarding flow and `/chat` land, at which
> point the operator story is: sign in with Google → ingest → confirm profile → query the
> graph. Kept in the meantime because the environment, cron, and troubleshooting sections
> are still accurate, and because the pilot's hard-won failure modes are worth preserving.

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

The AgentMail, inbound-gating, and mail-redirect variables are gone with the email
layer. `DEMO_PERSONA_INBOX` and `INTRO_TEST_SINGLE_SIDED` went with them — both existed
only so one inbox could play both sides of an email round trip.

The scripts (`npm run personas`) additionally need `SUPABASE_SERVICE_ROLE_KEY` in your
local `.env`.

The plus-addressing setup that used to be required here is not any more: personas needed
one deliverable address each only so an operator could reply as them over real email.
They are still generated as matching fixtures, and `people.email` is still unique, but
nothing sends to those addresses.

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

Apply everything through `0019`:

```sh
supabase db push        # or apply 0018_demo_cohort.sql and 0019_pilot_schedule.sql via the dashboard
```

`0018` adds the demo-persona marker. `0019` redefines `schedule_dawn_jobs()` for a
three-hourly cadence and adds `unschedule_dawn_jobs()` — **neither is called at
migration time**, deliberately. You call them in step 7.

## 4. Inbound email — removed

The `agentmail-webhook` Edge Function, `/api/agent/inbound`, and `src/lib/triage.ts` are
deleted. Nothing can arrive, so there is nothing to register. SPEC §3.4 keeps the triage
design (replay guard → self-send guard → sender resolution → trust → rate ceiling) for
whenever inbound returns; recover the implementation from git history at `3171c91`.

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

## 8. Play the other side (daily) — not possible

This step was the heart of the pilot: persona mail landed in one inbox, you replied as
each persona, and inbound triage attributed the reply so the double opt-in advanced. All
three of those pieces are gone — no send, no inbox, no triage — so there is nothing to
reply to and no way for a reply to be recorded.

Until a channel is rewired (SPEC §3.2, build step 5), the closest thing to exercising the
other side is `/admin/console` → Network, which runs matching for a person and records a
Pass — the same rejection signal the calibration loop reads.

Check the run in `/admin/monitor`: introductions by state and members with nothing in
flight. The inbox tab and the per-intro thread reader are gone with the email layer.

## 9. Stop, and clean up

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
| Nothing is ever delivered | Expected — the email layer is removed. `run-matches` stops at the match. |

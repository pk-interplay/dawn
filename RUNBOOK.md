# Pilot runbook — 5 teammates, 3 days of introductions

The test: a handful of real colleagues onboard at `/join`, and over the following days
Dawn emails each of them a few warm introductions. Every counterpart is fictional and
delivers to one inbox you control, so you play the other side of the network over real
email while your teammates' experience — the matching, the asking, the replying — is
entirely real.

What this exercises end to end: onboarding → embedding-based matching → double opt-in
→ inbound reply parsing → scheduling. What it deliberately doesn't: a meeting actually
happening.

Order matters in one place. **Personas are generated from what your teammates
actually asked for**, so onboarding has to finish before you create them, and the cron
has to stay unscheduled until then. The rest is ordinary setup.

---

## 1. Deploy first

Nothing works locally. `pg_cron` calls the app over HTTPS to propose introductions,
and AgentMail's webhook calls it to deliver replies — both need a public URL. While
`APP_URL` points at localhost, no teammate's reply can ever reach the state machine.

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
| `AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX_ID` | required, or mail is only simulated |
| `CRON_SECRET` | long random string; gates `/api/cron/*` and `/api/agent/inbound` |
| `DEMO_PERSONA_INBOX` | the inbox you will read as every persona, e.g. `pk@interplay.vc` |
| `INBOUND_AUTOREPLY` | `true` — otherwise an unsubscribe is honoured silently, with no acknowledgement to a real colleague |
| `INBOUND_MAX_PER_HOUR` | `20`. Counted per person, not per address, so your persona replies don't share one budget — but you'll be answering several personas an hour |
| `ADMIN_EMAILS` / `ADMIN_EMAIL_DOMAINS` | your address / your domain, for `/admin/monitor` |
| `MAIL_REDIRECT_TO` | **blank.** Set, it swallows your teammates' introductions into your own inbox |
| `INTRO_TEST_SINGLE_SIDED` | **blank.** Set, it records person B as having consented to an introduction they were never shown |

The scripts (`npm run personas`) additionally need `SUPABASE_SERVICE_ROLE_KEY` and
`DEMO_PERSONA_INBOX` in your local `.env`.

Does your mail provider support plus-addressing? Send yourself a test at
`you+test@yourdomain` before relying on it. Personas need one address each
(`people.email` is unique) that all land in one mailbox, and plus tags are how that
works. Google Workspace and most providers do this; if yours doesn't, use per-persona
aliases and set `DEMO_PERSONA_INBOX` accordingly.

## 3. Migrations

Apply everything through `0019`:

```sh
supabase db push        # or apply 0018_demo_cohort.sql and 0019_pilot_schedule.sql via the dashboard
```

`0018` adds the demo-persona marker. `0019` redefines `schedule_dawn_jobs()` for a
three-hourly cadence and adds `unschedule_dawn_jobs()` — **neither is called at
migration time**, deliberately. You call them in step 7.

## 4. Inbound email

Deploy the webhook and register it once:

```sh
supabase functions deploy agentmail-webhook
supabase secrets set APP_URL=https://your-app CRON_SECRET=<same value as the app>
```

Then, against your AgentMail account:

```js
client.webhooks.create({ url: "<edge function url>", events: ["message.received"] })
```

Verify before inviting anyone: email Dawn's inbox from an address that isn't a member
and confirm an `inbound_events` row appears with `decision = 'non_member'`. If nothing
lands, replies will vanish silently for the whole pilot — fix it now.

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

Expect: `Scheduled dawn-run-matches (every 3h), dawn-decay-proximity, dawn-expire-intros.`

Volume is governed in two independent places and both have to allow it: the schedule
(every 3h) and each member's `intro_cadence` (`burst` = one intro per 6h). The ceiling
is four opt-in asks per member per day. Lower either one to slow it down.

Want the first batch immediately rather than at the top of the next third hour:

```sh
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://your-app/api/cron/run-matches?synthetic=false&limit=10"
```

## 8. Play the other side (daily)

Persona mail arrives in `DEMO_PERSONA_INBOX`, tagged so you can filter it. **Reply
normally, from your ordinary address.** Inbound triage matches your address to the
persona Dawn wrote to in that thread and attributes the reply to the persona, so a
plain "yes, happy to chat" from `pk@` is recorded as Ava Chen opting in.

Two rules:

- **Reply in the thread.** The thread is what identifies which persona is speaking —
  a fresh email resolves to you, not to them.
- **Answer as that person would**, including saying no. An honest mix of yes and no is
  what makes your teammates' side of the data worth reading.

Check the run in `/admin/monitor`: introductions by state, the inbox tab for what
arrived, and members with nothing in flight.

If a reply doesn't resolve — it shows up as `decision = 'non_member'` — the fallback
is the admin intro controls; don't hand-edit `introductions` rows, or the state
machine and the email trail stop agreeing.

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
| Your persona replies come back as the waitlist template | You replied outside the thread, or plus-addressing isn't delivering |
| Teammates' intros land in your inbox | `MAIL_REDIRECT_TO` is set |
| Everything is recorded but nothing is delivered | `AGENTMAIL_API_KEY` unset — the flow runs in simulated mode |
| Replies do nothing | Webhook not registered, or `APP_URL`/`CRON_SECRET` mismatched between app and Edge Function |
| Persona replies stop being processed mid-day | `INBOUND_MAX_PER_HOUR` reached for that persona |

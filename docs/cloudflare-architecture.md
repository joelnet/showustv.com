---
title: Cloudflare Cost-Optimized Architecture (mid-2026)
purpose: Cheapest-possible Cloudflare-native stack for the TV Time clone.
plan: "Workers Paid ($5/mo baseline) from day one — no Free-tier daily cliffs, argon2id fits, Queues + Email Sending unlocked."
targets: "$5/mo baseline (Workers Paid), ~$15/mo at 1k DAU, ~$25/mo at 2k DAU."
---

## Component summary (Workers Paid, pricing as of mid-2026)

| Product | Included in $5/mo Paid | Overage | Role in this app |
|---|---|---|---|
| **Workers Paid** | 10M req/mo + 30M CPU-ms/mo; unlimited subrequests; 30s CPU/invocation | $0.30/M req, $0.02/M CPU-ms | Core runtime |
| **Pages** (static) | Unlimited static bandwidth, 500 builds/mo | Functions billed as Workers | Static SPA shell |
| **D1** (SQLite) | 25B rows read/mo + 50M rows written/mo + 5 GB storage | $0.001/M read, $1.00/M written, $0.75/GB-mo over 5 GB | Primary database |
| **Durable Objects (SQLite)** | None on Paid — billed per request + GB-s + storage from op 1 | $0.15/M req, $12.50/M GB-s, $0.001/M read, $1.00/M written, $0.20/GB-mo | **Use sparingly.** Session alarms, per-user push scheduling. |
| **KV** | 10M reads + 1M writes + 1M deletes + 1M lists + 1 GB storage / mo | $0.50/M read, $5.00/M write/delete/list, $0.50/GB-mo | Sessions cache, TMDB metadata cache |
| **R2** | 10 GB-mo storage, 1M class-A, 10M class-B, egress FREE | $0.015/GB-mo, $4.50/M class-A, $0.36/M class-B | Only if we self-host avatars / GIF meme uploads |
| **Cache API + Tiered Cache** | Free (edge cache; Tiered Cache free for all) | — | First line of edge caching, absorbs duplicate hits |
| **Queues** | 1M ops/mo | $0.40/M ops thereafter (write+read+delete = 3 ops/msg) | Notification fan-out, sync backfill batches |
| **Cron Triggers** | Free (billed as one Worker req per fire) | — | Nightly TMDB sync |
| **Images (Transformations)** | 5k unique/mo | $0.50/1k transforms | Skip at start; hotlink TMDB posters |
| **Turnstile** | Unlimited challenges, 20 widgets/account | — | Signup, password-reset CAPTCHA |
| **Cloudflare Access** | 50 seats free, then $7/user/mo | — | **Wrong tool.** Access whitelists identities, not self-serve signup. |
| **Web Analytics** | Free | — | Turn on. |
| **Email Sending** (Cloudflare, Beta) | 3k emails/mo included | $0.35 per 1k | Primary transactional path (password reset, digest emails). |
| **Email Routing** (inbound) | Unlimited | — | Receive `noreply@`, forward. |
| **Web Push** | No CF product needed | Worker cost only (~2 ms CPU + 1 subrequest per notification) | VAPID + browser push services (FCM/Mozilla/Apple) — delivery is free. |

## Architecture

```
              ┌────────────────────────────────────────┐
              │  Browser / PWA  (Service Worker + Push)│
              └───────────────▲───────▲────────────────┘
                              │       │  Web Push (VAPID)
                    HTTPS     │       │  → FCM / Mozilla / Apple (free)
                              │       │
              ┌───────────────┴───────┴────────────────┐
              │  Cloudflare Pages  (static SPA shell)  │
              │  + Turnstile widget on /signup, /reset │
              └───────────────▲────────────────────────┘
                              │ /api/*
              ┌───────────────┴────────────────────────┐
              │  Workers "api" (single Worker)         │
              │  - Session cookie auth (argon2id/bcrypt)│
              │  - Verify Turnstile                    │
              │  - Route: library, checkins, social    │
              └───┬────────┬────────┬───────┬──────────┘
                  │        │        │       │
              ┌───▼──┐  ┌──▼──┐  ┌──▼──┐ ┌──▼──────────┐
              │  D1  │  │ KV  │  │ DO  │ │ Cache API   │
              │ core │  │sess │  │alarm│ │ TMDB proxy  │
              │ +soc │  │+tmdb│  │/fee │ │ (edge)      │
              └──────┘  └─────┘  └──┬──┘ └─────────────┘
                                    │
                             ┌──────▼──────┐
                             │  Queue      │──► Push-sender Worker
                             │ episode-fan │    (VAPID JWT + POST)
                             └──────▲──────┘
                                    │
                          ┌─────────┴─────────┐
                          │ Cron Worker       │
                          │ nightly TMDB sync │
                          └───────────────────┘

  Transactional email:
     Paid → Cloudflare Email Sending (3k/mo free, $0.35/1k)
     Free → Resend Free (3k/mo, 100/day cap)

  Show posters:  <img src="image.tmdb.org/..."> — hotlink, zero cost.
```

## Architectural choices with cost reasoning

### Per-user library → D1, not DO, not KV
- Library is relational (users × shows × episodes × ratings).
- 1k DAU × 5 check-ins/day = 150k writes/mo, well under the 50M included on Paid.
- Reads are cheap ($0.001/M).
- Per-user Durable Object *sounds* elegant but every request costs a DO request + GB-s + row R/W, and cross-user queries (feed, trending) become painful.
- KV is a non-starter — ratings/lists need range queries.

### Follow graph & social feed
- Store follow edges in D1: `follows(follower_id, followee_id, created_at)`.
- **<100 users**: read-time query per feed load — costs a few thousand row-reads, free tier absorbs.
- **~1k DAU**: still cheap ($0.001/M reads).
- Write-fanout to KV/DO becomes cheaper only at ~10k+ DAU with high fan-out.
- **Stick with D1 read-time through 1k DAU. Revisit at 10k.**

### Password reset email
On Workers Paid, use **Cloudflare Email Sending** (3k/mo included, $0.35/1k over). Native, single vendor, no extra domain setup beyond DNS records. Fall back to **Resend** ($20/mo Pro or free 3k/mo tier) only if Email Sending's Beta status becomes a blocker. **Avoid MailChannels** — free Cloudflare integration ended Aug 2024.

### Web push
- No Cloudflare-native product. Use VAPID keys, POST to `endpoint` from browser's PushManager.
- Delivery to FCM/Mozilla/Apple is free.
- Cost = Worker CPU + requests. ~2 ms CPU + 1 subrequest per notification.
- 1M/mo ≈ 2M CPU-ms — well within Paid included.
- Use `pushforge` (Workers-native, zero-dep). Avoid the classic `web-push` npm (needs `nodejs_compat`, heavier).
- Fan out through **Queues** so one cron doesn't burst-block.

### Show poster images
- Hotlink `image.tmdb.org/t/p/w342/...` directly.
- TMDB's CDN is free bandwidth to us.
- Only wrap in a Worker + Cache API if we need TTL control or a custom domain.
- Never proxy through R2 unless we need transforms TMDB doesn't provide (they already ship `w92 / w185 / w342 / w500 / original`).

### Passwords
- Use **argon2id** (m=64 MB, t=3, p=1). Workers Paid has 30 s CPU / invocation — no CPU pressure at signup/login rates.
- Store hash in D1 `users.pw_hash`.
- WASM builds of argon2 run well on Workers; e.g. `hash-wasm` or `@node-rs/argon2` via `nodejs_compat`.

### Sessions
- Cookie-based, HTTP-only, Secure, SameSite=Lax.
- Session record in KV keyed on random 256-bit token; TTL 30 days sliding.
- Backup canonical session state in D1 if strict consistency needed (KV has up to 60s eventual consistency globally).

## Cost scenarios

### A. Personal / <100 users — $5/mo baseline

| Item | Usage | Cost |
|---|---|---|
| **Workers Paid base** | <100k req/mo, well under 10M included | **$5.00** |
| Pages | Static SPA | $0 |
| D1 | <100k reads/mo, <10k writes/mo, <1 GB | $0 (under monthly included) |
| KV | Sessions + TMDB cache within monthly included | $0 |
| Cache API | TMDB image passthrough | $0 |
| Cron | 1× nightly TMDB sync | $0 |
| Web Push | VAPID → browser services | $0 |
| Turnstile | Signup / reset CAPTCHA | $0 |
| Web Analytics | | $0 |
| Email (reset) | Cloudflare Email Sending (<100/mo, under 3k included) | $0 |
| **Total** | | **$5/mo** |

Constraint: avoid Durable Objects — SQLite DO is billed per request + GB-s from op one on Paid. D1 handles all Phase 1 needs.

### B. ~1k DAU realistic

Assumptions: 27M req/mo, 150k D1 writes/mo, 15M D1 reads/mo, 1.8M push notifications/mo, 2 GB D1.

| Item | Usage | Cost |
|---|---|---|
| Workers Paid base | | $5.00 |
| Workers requests | 17M billable × $0.30/M | $5.10 |
| Workers CPU | 159M billable CPU-ms × $0.02/M | $3.18 |
| D1 storage / reads / writes | Under free | $0 |
| KV | Under free monthly | $0 |
| Queues | 5.4M ops (4.4M billable × $0.40/M) | $1.76 |
| Cron | Included | $0 |
| Email | 1k resets/mo (under 3k free) | $0 |
| Turnstile / Analytics / Cache / R2 | | $0 |
| **Total** | | **~$15/mo** |

Doubling to 2k DAU stays under ~$25/mo. Dominant lever = Worker requests. Collapse chatty endpoints and cache aggressively at the edge.

## Watch-outs (2026-era gotchas)

- **KV writes are expensive per op** ($5/M) — never use KV as a hot write path. Reads are the generous side.
- **Durable Objects SQLite is billed per request + GB-s from op one** on Paid (billing went live 7 Jan 2026). Older tutorials describing "free DO storage" are stale. D1 handles Phase 1 needs.
- **KV eventual consistency** — reads can lag writes ~60 s globally. Don't store canonical session state without a D1 backup.
- **MailChannels-via-Cloudflare is dead** since Aug 2024. Old tutorials are wrong.
- **Cloudflare Access ≠ consumer auth.** 50 free seats is real, but Access whitelists identities via IdP. Not self-serve signup. Confirmed wrong tool.
- **Cloudflare Email Sending is currently Beta.** Watch the changelog; have a Resend fallback ready.
- **Cache API TTLs don't survive purge-all** — don't rely on it for durable state.
- **Turnstile 20 widgets/account is per-account, not per-site** — enough, but note if you split staging/prod.
- **Argo Smart Routing ≠ Tiered Cache.** Tiered Cache is free. Argo Routing is $5/domain + $0.10/GB. Do not enable Argo unless measured.
- **Cron minimum interval is 1 minute**. For per-user reminders, prefer DO Alarms over cron — but weigh DO cost first.
- **`web-push` npm needs `nodejs_compat`** — prefer `pushforge`.
- **TMDB attribution + ~50 req/s rate limit.** Cache aggressively so your Worker isn't the rate-limited party.
- **Workers Paid billing is metered per second, not per invocation.** A stuck request that idles for 30 s still bills only ~1 ms CPU — but a bug that loops CPU eats budget fast. Set up billing alerts.

## Sources (all Cloudflare official pricing pages)

- Workers pricing — https://developers.cloudflare.com/workers/platform/pricing/
- D1 pricing — https://developers.cloudflare.com/d1/platform/pricing/
- Durable Objects pricing — https://developers.cloudflare.com/durable-objects/platform/pricing/
- Workers KV pricing — https://developers.cloudflare.com/kv/platform/pricing/
- R2 pricing — https://developers.cloudflare.com/r2/pricing/
- Queues pricing — https://developers.cloudflare.com/queues/platform/pricing/
- Pages Functions pricing — https://developers.cloudflare.com/pages/functions/pricing/
- Cron Triggers — https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Images pricing — https://developers.cloudflare.com/images/pricing/
- Turnstile plans — https://developers.cloudflare.com/turnstile/plans/
- Zero Trust / Access plans — https://www.cloudflare.com/plans/zero-trust-services/
- Email Service pricing — https://developers.cloudflare.com/email-service/platform/pricing/
- Web Analytics — https://developers.cloudflare.com/web-analytics/
- MailChannels EoL notice — https://support.mailchannels.com/hc/en-us/articles/26814255454093-End-of-Life-Notice-Cloudflare-Workers
- Resend pricing — https://resend.com/pricing
- Cloudflare Agents push notifications guide — https://developers.cloudflare.com/agents/guides/push-notifications/
- PushForge — https://github.com/draphy/pushforge
- Smart Tiered Cache free-for-all — https://blog.cloudflare.com/introducing-smarter-tiered-cache-topology-generation/

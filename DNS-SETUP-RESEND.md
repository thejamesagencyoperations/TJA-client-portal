# Task: add 3 DNS records to thejamesagency.com (Network Solutions)

**Goal:** let the TJA client portal send email from `noreply@thejamesagency.com`.
Resend (the sending service) needs to see three records in DNS before it will
deliver to anyone. They're already registered on the Resend side and it's polling
for them — **the only outstanding work is creating them at the DNS host.**

**Who's asking:** Cameron Poolton (cameron@thejamesagency.com), who owns the domain
and the Network Solutions account.

---

## ⛔ Read this first — what must NOT change

The James Agency runs its **real company email on Google Workspace** through this
same domain. Breaking it would take down email for the whole agency.

**Do not touch, edit or delete any of these:**

| Record | Current value | Why it matters |
|---|---|---|
| Root `MX` | `aspmx.l.google.com` (prio 1), `alt1`/`alt2.aspmx.l.google.com` (5), `aspmx2`/`aspmx3.googlemail.com` (10) | **All TJA email.** |
| Root `TXT` | `v=spf1 include:_spf.thejamesagency_com._d.easydmarc.pro ~all` | Their existing SPF (EasyDMARC). |
| Root `TXT` | `google-site-verification=dNwEByWHDspXj4-4T4u84SxrYBLGTCF4rv1c_MAu_m4` | Google domain verification. |
| Root `A` | `104.198.132.50` | The website. |

**You are only ADDING three new records.** Every one sits on a **subdomain**
(`send.` and `resend._domainkey.`), so none of them collide with the records above.
In particular: the new SPF goes on `send`, **not** the root — the root SPF stays
exactly as it is. There must be **no** second SPF record on the root when you're done.

If a screen ever offers to "replace", "reset" or "restore default" DNS records —
**stop and ask Cameron.**

---

## The three records to add

### 1 · DKIM — `TXT`

| Field | Value |
|---|---|
| **Type** | `TXT` |
| **Host / Name** | `resend._domainkey` |
| **Value** | see below (218 characters) |

```
p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC+43Yb+6csoB12qw1ijf89yCM1KPpkaRjzBPg0uJIdEX/V2rqYwrFNzLwooTRrYlJ/QB9LN1bmbhdz65rfvEVC6FiOBLRoHtCfXB0bd2Wn7si7Q2CoV558zikPES9lEtd8wubboqDhB19GSpn8FL23pqySMpoTZ0jMraOVeMdE3wIDAQAB
```

### 2 · SPF — `TXT`

| Field | Value |
|---|---|
| **Type** | `TXT` |
| **Host / Name** | `send` |
| **Value** | `v=spf1 include:amazonses.com ~all` |

### 3 · SPF — `MX`

| Field | Value |
|---|---|
| **Type** | `MX` |
| **Host / Name** | `send` |
| **Priority** | `10` |
| **Value** | `feedback-smtp.us-east-1.amazonses.com` |

---

## Where to do it

DNS for `thejamesagency.com` is hosted at **Network Solutions**
(authoritative nameservers: `ns1.worldnic.com`, `ns2.worldnic.com`).

1. Sign in at **https://www.networksolutions.com** (Cameron has the credentials —
   ask him; do not attempt a password reset).
2. **My Domain Names** → `thejamesagency.com` → **Manage**.
3. Look for **Change Where Domain Points** → **Advanced DNS**, or a button labelled
   **Manage Advanced DNS Records**. Network Solutions moves this around; the target
   is the page listing existing `A` / `MX` / `TXT` records.
4. Add each record above. TXT and MX are usually **separate sections** on the same
   page, each with its own **Add / Edit** and its own **Save** — saving one section
   does not save the other.

---

## ⚠️ Network Solutions quirks that cause silent failures

These are specific to this host and are the usual reasons this goes wrong:

1. **Host field = subdomain only.** Enter `send`, **not** `send.thejamesagency.com`.
   Netsol appends the domain automatically; the full name produces
   `send.thejamesagency.com.thejamesagency.com`, which silently never verifies.
2. **The DKIM value is 218 characters and Netsol's input can truncate it.** After
   saving, **reopen the record and confirm the value still ends in `wIDAQAB`.** If
   it's cut short, that's the failure — re-paste it.
3. **Don't add quotes.** Some hosts want `"…"` around TXT values. Netsol adds them
   itself. Paste the raw value.
4. **Netsol is slow.** Other hosts propagate in minutes; Netsol can take a few hours.
   Not-yet-visible ≠ broken.
5. Some Netsol accounts show a **"you have unsaved changes"** step — make sure the
   final **Save / Continue** is actually clicked, not just the per-record one.

---

## How to confirm it worked

Wait ~15 minutes after saving, then check the records are publicly visible.
**Either** run these in Terminal:

```bash
dig +short TXT resend._domainkey.thejamesagency.com
dig +short TXT send.thejamesagency.com
dig +short MX  send.thejamesagency.com
```

**or** open these URLs in a browser (no tools needed):

- https://dns.google/resolve?name=resend._domainkey.thejamesagency.com&type=TXT
- https://dns.google/resolve?name=send.thejamesagency.com&type=TXT
- https://dns.google/resolve?name=send.thejamesagency.com&type=MX

**Done looks like:** all three return a value (the JSON has an `"Answer"` array).
The DKIM one must end `wIDAQAB` — if it's shorter, it was truncated (quirk #2).

Then in **Resend → Domains → thejamesagency.com**, click **Verify**. Status should
go `pending` → **`verified`**. Resend also re-checks on its own.

### Also confirm nothing broke

```bash
dig +short MX thejamesagency.com      # must still list aspmx.l.google.com etc.
dig +short TXT thejamesagency.com     # must still show the easydmarc SPF — and ONLY one v=spf1 line
```

If the root MX changed, or a second `v=spf1` appeared on the root, **revert that
immediately and tell Cameron** — the first breaks agency email, the second breaks
SPF (multiple root SPF records is a hard fail, not a warning).

---

## Report back to Cameron

- ✅ all three added and visible in DNS, root MX + SPF untouched, Resend `verified`
- ⏳ added but not yet visible → note the time; Netsol can take hours
- ❌ blocked (can't sign in, page not found, value truncated) → say which, and stop

**Cameron's next step once verified** (he'll handle this, it's not part of this task):
tell Claude in the portal project, which will run
`supabase secrets set PORTAL_FROM_EMAIL=noreply@thejamesagency.com` and the portal
starts emailing real clients.

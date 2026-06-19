# Going live on Supabase

The portal is **already wired** for Supabase. Until you paste your project keys it
keeps running on local data, so nothing breaks. These are the steps to flip it to a
live, shared, multi-user product. **~15 minutes.**

> What you need from me / what I've done: all the app code + the SQL schema are
> done. The steps below are the ones only you can do (they live in your Supabase
> dashboard) plus pasting two keys. After step 5 it's live.

---

## 1. Create (or pick) the Supabase project
- In your Supabase account, create a new project (or use an existing one in the
  TJA ecosystem). Note the **region** and set a DB password.

## 2. Run the schema
- Open **SQL Editor → New query**.
- Paste the entire contents of [`supabase/schema.sql`](supabase/schema.sql) and click **Run**.
- This creates the `app_state` + `profiles` tables, the signup trigger, and the
  Row-Level-Security policies (admins write everything for their client; clients
  may upload files + review present docs; everyone reads their own client's data).

## 3. Create the two demo users
**Authentication → Users → Add user** (twice). For each, set "Auto Confirm User",
and under **User Metadata** paste the JSON shown:

| User | Email | Password | User metadata |
|---|---|---|---|
| Admin (TJA) | `clientservices@thejamesagency.com` | *(your choice)* | `{ "role": "admin", "client_id": "celtic-elevator" }` |
| Client (Celtic) | `celticelevator@thejamesagency.com` | *(your choice)* | `{ "role": "client", "client_id": "celtic-elevator" }` |

The trigger auto-creates a matching row in `profiles`. (If a profile is missing,
re-run: `insert into profiles(id,email,role,client_id) select id,email,'admin','celtic-elevator' from auth.users where email='clientservices@thejamesagency.com';`)

## 4. Seed the first dashboard row (optional but recommended)
So the admin sees data on first login, insert one `app_state` row. Easiest: log in
as the admin once (after step 5) and make any edit — it auto-saves to Supabase. Or
run this in SQL Editor to seed an empty shell:
```sql
insert into public.app_state (client_id, scope, data) values
  ('celtic-elevator','dashboard','{}'::jsonb)
on conflict do nothing;
```
(The app will fill it from the built-in Celtic seed on first save.)

## 5. Paste your keys
- In Supabase: **Project Settings → API**. Copy the **Project URL** and the
  **anon public** key.
- Open [`assets/js/supabase-config.js`](assets/js/supabase-config.js) and paste them:
```js
window.SUPABASE_CONFIG = {
  url: "https://YOURPROJECT.supabase.co",
  anonKey: "eyJhbGciOi...the anon public key...",
};
```
- Reload the app. The login now authenticates against Supabase, and all data
  (dashboard, files, present-docs) reads/writes Supabase — shared across everyone.

---

## How it behaves
- **Config blank →** local sandbox (localStorage), exactly as before.
- **Config filled →** Supabase auth + shared data. localStorage acts as a fast
  local cache; edits push to Supabase (debounced); a fresh login pulls the latest.

## Where it lives / hosting
The front end is static (no build step), so host it anywhere and point it at
Supabase:
- **Quickest:** Netlify/Vercel/GitHub Pages drag-and-drop of this folder, or
- **Final:** embed behind the gated link on thejamesagency.com.
Supabase is only the backend (auth + data); it doesn't host the static files.

## Known V1 limits (fine for a demo, revisit later)
- Present-docs images + uploaded files are stored as base64 inside the JSONB row.
  Fine for a handful of items; **for production move these to Supabase Storage
  buckets** (a follow-up — the adapter is structured to make that swap contained).
- RLS is per-client via the `profiles.client_id`. Multi-client rollout will want a
  `clients` table + per-engagement rows when the structure firms up.

## Security
- The **anon key is safe to expose** in the browser (that's its purpose); RLS is
  what protects the data. Never put the **service_role** key in the front end.

# Milan Bracket Madness

A 3-bracket, 32-entry company voting game with live scoring, champion-pick bonuses, and a public dashboard. Hosted as a static site on GitHub Pages with Supabase as the backend. No Node, no terminal commands required end-to-end.

---

## What's in here

```
bracket-madness/
├── index.html              ← Main app (sign-in, voting, dashboard)
├── admin.html              ← Admin panel (you only)
├── app.js                  ← Main app logic
├── admin.js                ← Admin logic
├── styles.css              ← Shared brand styles
├── supabase-config.js      ← Edit this with your Supabase URL + key
├── README.md               ← You are here
└── supabase/
    └── migrations/
        └── 001_initial.sql ← Paste into Supabase SQL Editor
```

---

## Setup (one-time, ~20 minutes)

### 1. Create a free Supabase project

1. Go to [supabase.com](https://supabase.com) → sign up if you haven't.
2. Click **New project**. Pick a name (e.g., `bracket-madness`), choose a region close to your team, set a database password (save it somewhere — you won't need it day-to-day).
3. Wait ~2 minutes for the project to spin up.

### 2. Apply the database schema

1. In your Supabase dashboard, left sidebar → **SQL Editor** → click **New query**.
2. Open `supabase/migrations/001_initial.sql` in this folder.
3. Copy the entire file contents and paste into the SQL Editor.
4. Click **Run** (bottom-right). You should see "Success. No rows returned."

If you see an error about `pg_cron`, go to **Database → Extensions**, search for `pg_cron`, and enable it — then re-run the migration.

### 3. Turn off email confirmation (so password signup is instant)

1. **Authentication → Providers → Email**.
2. Find the **"Confirm email"** toggle and turn it **OFF**.
3. Click **Save**.

This is the key step that lets your team sign up with a password and be instantly signed in — no inbox detour, no email rate limits.

### 4. Plug your project into the config file

1. **Settings → API Keys** (under "Publishable and secret API keys").
2. Copy the **Publishable key** (starts with `sb_publishable_`). Then go to **Settings → General** and copy the **Project URL**.
3. Open `supabase-config.js` in this folder and paste them in:
   ```js
   window.SUPABASE_URL = "https://xxxxxxxx.supabase.co";
   window.SUPABASE_KEY = "sb_publishable_…";
   ```

The publishable key is meant to be public — Row Level Security in the database is what protects your data. **Never** paste the **secret key** (`sb_secret_…`) here — that one stays server-side only.

### 5. Push to GitHub Pages

If you're new to GitHub Pages, do it through the web UI — no terminal required.

1. Go to [github.com/new](https://github.com/new) → create a new public repository (e.g., `bracket-madness`). Don't initialize with a README.
2. On the empty-repo page, click **uploading an existing file**.
3. Drag the entire contents of this `bracket-madness/` folder into the upload area. (Or zip the folder, drop the zip, GitHub will keep its contents.)
4. Commit.
5. **Settings → Pages**. Under "Build and deployment", set Source = **Deploy from a branch**, Branch = **main** / root. Save.
6. After ~1 minute, your site is live at `https://YOUR-USERNAME.github.io/bracket-madness/`.

### 6. Sign up your own account, then make yourself admin

1. Open the live URL. Click **Create an account**. Sign up with your `@milanlaser.com` email + a password.
2. Back in Supabase → **SQL Editor** → new query → paste and run (replace with your real email):
   ```sql
   insert into public.admins (player_id)
   select id from public.players where email = 'YOUR_EMAIL@milanlaser.com';
   ```
3. Go to `https://YOUR-USERNAME.github.io/bracket-madness/admin.html`. You should see the admin panel.

---

## Running the activity

### Step 1: Create your 3 brackets

In the admin panel:

1. Fill in "Bracket name" (e.g. *Green Characters*), a URL-safe slug (e.g. *green-characters*), and the champion-bonus points value (default 5).
2. Click **Create bracket**. Repeat 2 more times.

### Step 2: Add 32 entries per bracket

1. Click **Manage** on a bracket card.
2. In the textarea, paste 32 names, one per line. **The top of the list is the #1 seed**; the bottom is #32. Standard "top seed plays bottom seed" tournament pairing will be applied automatically.
3. Click **Save entries & generate bracket**. This creates all 5 rounds and pre-seeds round 1.

### Step 3: Open champion picks (optional but recommended)

Before round 1 opens, give players a chance to predict the eventual champion for a bonus.

1. In the bracket's **Manage** view, find the "Open champion picks" section.
2. Set a close datetime (typically right before round 1 opens).
3. Click **Open champion picks**.

The bracket card status changes to `CHAMPION_PICKS`. Players who open the app will see the champion pick screen for this bracket.

### Step 4: Schedule the rounds

For each round, set **Opens at** and **Closes at**. Recommended cadence:

- **Round of 32**: Opens Monday 9am, closes Tuesday 5pm
- **Round of 16**: Opens Tuesday 5pm, closes Wednesday 5pm
- **Quarterfinals**: Opens Wednesday 5pm, closes Thursday 5pm
- **Semifinals**: Opens Thursday 5pm, closes Friday 12pm
- **Final**: Opens Friday 12pm, closes Friday 5pm

Adjust to taste — a 2-week run with one round per workday is a common rhythm. The system polls every 5 minutes and auto-opens / auto-closes rounds at their scheduled times. Rounds also auto-close early once every signed-up player has voted.

### Step 5: Share the link

Send your team `https://YOUR-USERNAME.github.io/bracket-madness/`. They:

1. Click the link
2. Create an account with their `@milanlaser.com` email + a password
3. (If picks are open) make their champion pick
4. (When a round opens) vote on the 16/8/4/2/1 matchups
5. Watch the live dashboard

### Step 6: Resolve any ties

If a matchup ends in an exact tie, the bracket pauses there. In the admin panel, the bracket's card will show **"N ties to resolve"**. Open Manage → Resolve ties section → click a winner. The bracket advances immediately.

---

## How scoring works

- **+1 point** per matchup where you voted with the eventual majority winner.
- **+5 points** (configurable per bracket) when your champion pick wins the whole bracket. Awarded once the final closes.
- Your standing across **all three brackets combined** is shown in the live leaderboard.

---

## Day-to-day operations

| Situation | What to do |
|---|---|
| Someone forgot their password | Supabase → Authentication → Users → click their row → Send recovery email (or reset directly) |
| Someone signed up with the wrong email | Supabase → Authentication → Users → delete the row → they sign up again |
| A round closed too early or with wrong votes | Open admin panel → bracket → adjust the round's `closes_at` if not yet closed; otherwise contact someone who's better at SQL 🙂 |
| You want to force-close a round before its deadline | Admin → bracket → round card → **Force-close now** |
| Tie needs resolving | Admin → bracket → Resolve ties section |

---

## What's running where

- **Static site** (HTML + JS + CSS): GitHub Pages. Free, no maintenance.
- **Database**: Supabase Postgres. Free tier holds ~500 MB; this game will use under 5 MB.
- **Auth**: Supabase. Email + password. `@milanlaser.com` domain enforced at the database level via a trigger — non-Milan emails get rejected even if someone bypasses the frontend.
- **Scheduled jobs**: `pg_cron` runs every 5 minutes inside Postgres to open and close rounds at their deadlines. No external service needed.
- **Live updates**: The dashboard polls every 30 seconds (no realtime websocket connection held open — keeps us well under Supabase's free-tier 200-concurrent-connection cap, fine for 200+ players).

---

## Customizing

- **Round names**: Edit `ROUND_DEFS` in `admin.js` and `ROUND_SHORT` in `app.js`.
- **Champion bonus**: Set per-bracket when you create it. Editable later via the Supabase Table Editor.
- **Brand colors**: Edit the `:root` CSS variables in `styles.css`.
- **Polling cadence**: The 30-second auto-refresh interval is in `app.js` (look for `setInterval`).

---

## Security notes

- The Supabase **publishable key** (`sb_publishable_…`) in `supabase-config.js` is intentionally public — it's the key the browser uses. The database's Row Level Security policies are what actually protect your data.
- The **secret key** (`sb_secret_…`) is private — never put it in this repo, never commit it anywhere browser-facing.
- All vote, pick, and bracket mutations go through RLS policies that verify: you're authenticated, you're the player you claim to be, and the round/bracket is in the right state. Admin functions additionally check the `admins` table.
- Without email confirmation, someone could technically sign up as `coworker@milanlaser.com` if they knew the email. Inside a Milan team running a fun activity, this is a non-issue — and you can spot fake signups in the Supabase **Authentication → Users** list.

---

## Troubleshooting

**"Could not save your vote"** when voting — the round may have just closed. Refresh the page.

**Signup says "Only @milanlaser.com emails are allowed"** — confirmed working as designed.

**Admin panel shows "Not authorized"** — you forgot Step 6. Re-run the admin promotion SQL with your email.

**Bracket cards say `0/5 rounds`** — entries weren't saved successfully, or the round-generation step errored. Try deleting the bracket and re-creating.

**Page is stuck on the spinner** — check the browser console (F12 → Console). Most likely: `supabase-config.js` wasn't filled in correctly, or your Supabase project is paused (free tier projects pause after a week of inactivity — go to your Supabase dashboard and click **Restore**).

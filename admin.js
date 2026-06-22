// ============================================================
// Milan Bracket Madness — Admin Panel
// ============================================================

const sb = (() => {
  if (!window.SUPABASE_URL || window.SUPABASE_URL.includes('PASTE_YOUR')) return null;
  return supabase.createClient(window.SUPABASE_URL, window.SUPABASE_KEY);
})();

const ROUND_DEFS = [
  { number: 1, name: 'Round of 32', matchups: 16 },
  { number: 2, name: 'Round of 16', matchups: 8 },
  { number: 3, name: 'Quarterfinals', matchups: 4 },
  { number: 4, name: 'Semifinals', matchups: 2 },
  { number: 5, name: 'Final', matchups: 1 },
];

const state = {
  ready: false,
  user: null,
  isAdmin: false,
  player: null,
  brackets: [],
  entries: {},
  entriesByBracket: {},
  rounds: {},
  matchups: {},
  players: [],
  tallies: {},
  msg: null,
  msgKind: 'success',
  signinError: null,
  signinBusy: false,
  signinMode: 'signin',
  expandedBracket: null,
};

// ============================================================
// THEME
// ============================================================
function getTheme() { return document.documentElement.dataset.theme || 'light'; }
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('bracket-theme', theme); } catch {}
}
function toggleTheme() {
  applyTheme(getTheme() === 'dark' ? 'light' : 'dark');
  render();
}
function brandLogoSrc() {
  return getTheme() === 'dark' ? 'milan-logo-white.svg' : 'milan-logo.svg';
}
const MOON_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.354 15.354A9 9 0 1 1 8.646 3.646 7 7 0 0 0 20.354 15.354z"/></svg>';

// ============================================================
// AUTH
// ============================================================
async function bootstrap() {
  if (!sb) {
    document.getElementById('app').innerHTML = renderConfigMissing();
    return;
  }
  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    state.user = session.user;
    await checkAdmin();
    if (state.isAdmin) await loadData();
  }
  state.ready = true;
  render();

  sb.auth.onAuthStateChange(async (_e, session) => {
    state.user = session?.user || null;
    if (state.user) {
      await checkAdmin();
      if (state.isAdmin) await loadData();
    } else {
      state.isAdmin = false;
    }
    render();
  });
}

async function checkAdmin() {
  const { data } = await sb.from('admins').select('player_id').eq('player_id', state.user.id).maybeSingle();
  state.isAdmin = !!data;
}

async function signIn(email, password) {
  state.signinError = null; state.signinBusy = true; render();
  const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
  state.signinBusy = false;
  if (error) state.signinError = error.message;
  render();
}

async function signUp(email, password) {
  state.signinError = null; state.signinBusy = true; render();
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail.endsWith('@milanlaser.com')) {
    state.signinError = 'Only @milanlaser.com emails are allowed.';
    state.signinBusy = false; render(); return;
  }
  const { error } = await sb.auth.signUp({ email: cleanEmail, password });
  state.signinBusy = false;
  if (error) state.signinError = error.message;
  render();
}

async function signOut() { await sb.auth.signOut(); }

// ============================================================
// DATA LOADING
// ============================================================
async function loadData() {
  const [bracketsRes, entriesRes, roundsRes, matchupsRes, playersRes, talliesRes, playerRes] = await Promise.all([
    sb.from('brackets').select('*').order('sort_order').order('created_at'),
    sb.from('entries').select('*').order('seed'),
    sb.from('rounds').select('*').order('round_number'),
    sb.from('matchups').select('*').order('position'),
    sb.from('players').select('*').order('display_name'),
    sb.from('matchup_tallies').select('*'),
    sb.from('players').select('*').eq('id', state.user.id).maybeSingle(),
  ]);
  state.brackets = bracketsRes.data || [];
  state.entries = {};
  state.entriesByBracket = {};
  (entriesRes.data || []).forEach(e => {
    state.entries[e.id] = e;
    if (!state.entriesByBracket[e.bracket_id]) state.entriesByBracket[e.bracket_id] = [];
    state.entriesByBracket[e.bracket_id].push(e);
  });
  state.rounds = {};
  (roundsRes.data || []).forEach(r => {
    if (!state.rounds[r.bracket_id]) state.rounds[r.bracket_id] = [];
    state.rounds[r.bracket_id].push(r);
  });
  state.matchups = {};
  (matchupsRes.data || []).forEach(m => {
    if (!state.matchups[m.round_id]) state.matchups[m.round_id] = [];
    state.matchups[m.round_id].push(m);
  });
  state.players = playersRes.data || [];
  state.player = playerRes.data;
  state.tallies = {};
  (talliesRes.data || []).forEach(t => state.tallies[t.matchup_id] = t);
}

// ============================================================
// ACTIONS
// ============================================================
function msg(text, kind = 'success') {
  state.msg = text; state.msgKind = kind;
  render();
  setTimeout(() => { if (state.msg === text) { state.msg = null; render(); } }, 5000);
}

async function createBracket(name, slug, bonus) {
  const sortOrder = state.brackets.length;
  const { error } = await sb.from('brackets').insert({
    name: name.trim(),
    slug: slug.trim().toLowerCase(),
    champion_bonus_points: bonus,
    sort_order: sortOrder,
    status: 'setup',
  });
  if (error) return msg('Could not create bracket: ' + error.message, 'error');
  await loadData(); render();
  msg(`Created "${name}". Add 32 entries to continue.`);
}

async function saveEntries(bracketId, rawText) {
  const existing = state.entriesByBracket[bracketId] || [];
  if (existing.length > 0) {
    return msg('This bracket already has entries. Delete them first if you need to redo.', 'error');
  }
  const names = rawText.split('\n').map(n => n.trim()).filter(Boolean);
  if (names.length !== 32) {
    return msg(`Need exactly 32 entries. You provided ${names.length}.`, 'error');
  }
  const rows = names.map((name, i) => ({
    bracket_id: bracketId,
    seed: i + 1,
    name,
  }));
  const { error } = await sb.from('entries').insert(rows);
  if (error) return msg('Could not save entries: ' + error.message, 'error');

  await generateBracketStructure(bracketId);
  await loadData(); render();
  msg('Entries saved and bracket structure generated.');
}

function isImageUrl(str) {
  return typeof str === 'string' && /^https?:\/\//i.test(str);
}

async function clearEntryIcon(entryId) {
  if (state.entries[entryId]) state.entries[entryId].icon = null;
  const { error } = await sb.from('entries').update({ icon: null }).eq('id', entryId);
  if (error) {
    msg('Could not clear icon: ' + error.message, 'error');
    await loadData(); render();
    return;
  }
  render();
}

async function uploadEntryIcon(entryId, file) {
  const sizeMB = file.size / 1024 / 1024;
  if (sizeMB > 2) {
    return msg(`Image is ${sizeMB.toFixed(1)}MB — max 2MB. Compress or resize first.`, 'error');
  }
  const ext = (file.name.split('.').pop() || 'png').toLowerCase();
  const safeExt = ['png','jpg','jpeg','gif','webp','svg'].includes(ext) ? ext : 'png';
  const filename = `${entryId}-${Date.now()}.${safeExt}`;

  const { error: uploadError } = await sb.storage
    .from('entry-icons')
    .upload(filename, file, { contentType: file.type, upsert: false });
  if (uploadError) return msg('Upload failed: ' + uploadError.message, 'error');

  const { data: pub } = sb.storage.from('entry-icons').getPublicUrl(filename);
  const publicUrl = pub.publicUrl;

  const { error: updateError } = await sb.from('entries').update({ icon: publicUrl }).eq('id', entryId);
  if (updateError) return msg('Save failed: ' + updateError.message, 'error');

  if (state.entries[entryId]) state.entries[entryId].icon = publicUrl;
  render();
  msg('Image uploaded.');
}

function renderEntryIconPreview(e) {
  if (e.icon && isImageUrl(e.icon)) {
    return `<img src="${escapeHtml(e.icon)}" alt="" loading="lazy">`;
  }
  return '<span class="preview-placeholder">+</span>';
}

async function deleteEntries(bracketId) {
  if (!confirm('Delete all 32 entries AND the round/matchup structure? Vote data will be wiped too.')) return;
  await sb.from('rounds').delete().eq('bracket_id', bracketId);
  await sb.from('entries').delete().eq('bracket_id', bracketId);
  await sb.from('brackets').update({ status: 'setup', champion_picks_close_at: null }).eq('id', bracketId);
  await loadData(); render();
  msg('Bracket reset to setup.');
}

async function generateBracketStructure(bracketId) {
  // Fetch entries fresh from DB — local state may not be refreshed yet
  const { data: entries, error: entriesErr } = await sb.from('entries')
    .select('*').eq('bracket_id', bracketId).order('seed');
  if (entriesErr) return msg('Could not load entries: ' + entriesErr.message, 'error');
  if (!entries || entries.length !== 32) {
    return msg(`Expected 32 entries, got ${entries?.length || 0}.`, 'error');
  }

  // Create 5 rounds with placeholder schedules
  const now = new Date();
  const baseStart = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const roundRows = ROUND_DEFS.map((rd, i) => ({
    bracket_id: bracketId,
    round_number: rd.number,
    name: rd.name,
    opens_at: new Date(baseStart.getTime() + i * 86400000).toISOString(),
    closes_at: new Date(baseStart.getTime() + (i + 1) * 86400000 - 60000).toISOString(),
    status: 'pending',
  }));
  const { data: rounds, error: rErr } = await sb.from('rounds').insert(roundRows).select();
  if (rErr) return msg('Round create failed: ' + rErr.message, 'error');

  const seedOrder = generateSeedOrder(32);
  const seedToEntry = {};
  entries.forEach(e => { seedToEntry[e.seed] = e; });

  // Round 1: pair entries by tournament seeding
  const r1 = rounds.find(r => r.round_number === 1);
  const r1Matchups = [];
  for (let i = 0; i < 16; i++) {
    r1Matchups.push({
      round_id: r1.id,
      position: i,
      entry_a_id: seedToEntry[seedOrder[2 * i]].id,
      entry_b_id: seedToEntry[seedOrder[2 * i + 1]].id,
    });
  }
  const { error: mErr } = await sb.from('matchups').insert(r1Matchups);
  if (mErr) return msg('R1 matchups failed: ' + mErr.message, 'error');

  // Rounds 2-5: empty matchups (winners get filled in as bracket advances)
  for (const rd of ROUND_DEFS.slice(1)) {
    const round = rounds.find(r => r.round_number === rd.number);
    const empties = [];
    for (let i = 0; i < rd.matchups; i++) {
      empties.push({ round_id: round.id, position: i });
    }
    const { error: emptyErr } = await sb.from('matchups').insert(empties);
    if (emptyErr) return msg(`R${rd.number} matchups failed: ${emptyErr.message}`, 'error');
  }
}

function generateSeedOrder(n) {
  let seeds = [1];
  while (seeds.length < n) {
    const next = [];
    const total = seeds.length * 2 + 1;
    for (const s of seeds) {
      next.push(s);
      next.push(total - s);
    }
    seeds = next;
  }
  return seeds;
}

async function openChampionPicks(bracketId, closeAtLocal) {
  const closeAt = new Date(closeAtLocal).toISOString();
  const { error } = await sb.rpc('admin_open_champion_picks', {
    p_bracket_id: bracketId,
    p_close_at: closeAt,
  });
  if (error) return msg('Could not open picks: ' + error.message, 'error');
  await loadData(); render();
  msg('Champion picks opened.');
}

async function updateRoundSchedule(roundId, opensLocal, closesLocal) {
  const updates = {};
  if (opensLocal) updates.opens_at = new Date(opensLocal).toISOString();
  if (closesLocal) updates.closes_at = new Date(closesLocal).toISOString();
  const { error } = await sb.from('rounds').update(updates).eq('id', roundId);
  if (error) return msg('Could not update round: ' + error.message, 'error');
  await loadData(); render();
  msg('Round schedule saved.');
}

async function forceCloseRound(roundId) {
  if (!confirm('Force-close this round now? Winners will be computed from current votes.')) return;
  const { error } = await sb.rpc('admin_close_round', { p_round_id: roundId });
  if (error) return msg('Could not close round: ' + error.message, 'error');
  await loadData(); render();
  msg('Round closed.');
}

async function openRoundNow(roundId) {
  const { error } = await sb.rpc('admin_open_round', { p_round_id: roundId });
  if (error) return msg('Could not open round: ' + error.message, 'error');
  await loadData(); render();
  msg('Round opened. Users can now vote.');
}

async function reorderEntries(bracketId, draggedId, targetId, dropBefore) {
  const sorted = (state.entriesByBracket[bracketId] || []).slice().sort((a, b) => a.seed - b.seed);
  const orderedIds = sorted.map(e => e.id);
  const fromIdx = orderedIds.indexOf(draggedId);
  if (fromIdx < 0) return;
  orderedIds.splice(fromIdx, 1);
  let toIdx = orderedIds.indexOf(targetId);
  if (toIdx < 0) toIdx = orderedIds.length;
  if (!dropBefore) toIdx += 1;
  orderedIds.splice(toIdx, 0, draggedId);

  // Optimistic local reseed for snappy UX
  orderedIds.forEach((id, i) => { if (state.entries[id]) state.entries[id].seed = i + 1; });
  render();

  const { error } = await sb.rpc('admin_reorder_entries', {
    p_bracket_id: bracketId,
    p_entry_ids: orderedIds,
  });
  if (error) {
    msg('Could not reorder: ' + error.message, 'error');
    await loadData(); render();
    return;
  }
  await loadData(); render();
  msg('Seeding updated. Round 1 matchups repaired.');
}

async function resolveTie(matchupId, winnerEntryId) {
  const { error } = await sb.rpc('resolve_tie', {
    p_matchup_id: matchupId,
    p_winner_entry_id: winnerEntryId,
  });
  if (error) return msg('Could not resolve tie: ' + error.message, 'error');
  await loadData(); render();
  msg('Tie resolved.');
}

async function deleteBracket(bracketId) {
  const b = state.brackets.find(x => x.id === bracketId);
  if (!b) return;
  if (!confirm(`Delete bracket "${b.name}" and ALL its entries, rounds, matchups, votes, and champion picks? This cannot be undone.`)) return;
  const { error } = await sb.from('brackets').delete().eq('id', bracketId);
  if (error) return msg('Delete failed: ' + error.message, 'error');
  await loadData(); render();
  msg('Bracket deleted.');
}

// ============================================================
// HELPERS
// ============================================================
function escapeHtml(s) {
  return (s == null ? '' : String(s)).replace(/[<>&"']/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function entryName(id) { return state.entries[id]?.name || '—'; }
function entrySeed(id) { return state.entries[id]?.seed || '—'; }
function toLocalDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = n => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function formatWhen(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}
function getUnresolvedTies(bracketId) {
  const ties = [];
  (state.rounds[bracketId] || []).forEach(r => {
    (state.matchups[r.id] || []).forEach(m => {
      if (m.is_tie && !m.winner_entry_id) ties.push({ matchup: m, round: r });
    });
  });
  return ties;
}

// ============================================================
// RENDER
// ============================================================
function render() {
  const root = document.getElementById('app');
  if (!state.ready) { root.innerHTML = '<div class="spinner"></div>'; return; }
  if (!state.user) { root.innerHTML = renderSignIn(); attachSigninHandlers(); return; }
  if (!state.isAdmin) { root.innerHTML = renderNotAdmin(); attachNotAdminHandlers(); return; }
  root.innerHTML = renderAdmin();
  attachAdminHandlers();
}

function renderConfigMissing() {
  return `
    <div class="signin-page">
      <div class="signin-card">
        <h1>Setup required</h1>
        <p class="sub">Edit <code>supabase-config.js</code>, then reload.</p>
      </div>
    </div>`;
}

function renderSignIn() {
  const mode = state.signinMode;
  return `
    <div class="signin-page">
      <div class="signin-card">
        <div class="logo-row">
          <img src="${brandLogoSrc()}" alt="Milan Laser" class="milan-logo-stacked">
        </div>
        <div class="event-tag">BRACKET MADNESS · ADMIN</div>
        <h1>Sign in</h1>
        <p class="sub">Sign in with your admin @milanlaser.com account.</p>
        <form class="signin-form" id="signin-form">
          <div class="row"><label for="email">Email</label><input id="email" type="email" required placeholder="you@milanlaser.com" autocomplete="email"></div>
          <div class="row"><label for="password">Password</label><input id="password" type="password" required minlength="6" placeholder="At least 6 characters" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}"></div>
          ${state.signinError ? `<div class="signin-error">${escapeHtml(state.signinError)}</div>` : ''}
          <button type="submit" class="submit" ${state.signinBusy ? 'disabled' : ''}>${state.signinBusy ? 'Working…' : (mode === 'signup' ? 'Create account' : 'Sign in')}</button>
        </form>
        <div class="signin-toggle">
          ${mode === 'signup'
            ? `Already signed up? <button id="toggle-mode" type="button">Sign in</button>`
            : `First time? <button id="toggle-mode" type="button">Create an account</button>`}
        </div>
      </div>
    </div>`;
}

function attachSigninHandlers() {
  document.getElementById('signin-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    if (state.signinMode === 'signup') signUp(email, password);
    else signIn(email, password);
  });
  document.getElementById('toggle-mode')?.addEventListener('click', () => {
    state.signinMode = state.signinMode === 'signup' ? 'signin' : 'signup';
    state.signinError = null; render();
  });
}

function renderNotAdmin() {
  return `
    <header class="top-nav">
      <div class="brand">
        <img src="${brandLogoSrc()}" alt="Milan Laser" class="brand-logo">
        <span class="sub">ADMIN</span>
      </div>
      <div class="nav-right">
        <button class="theme-toggle" id="theme-toggle" type="button" aria-label="Toggle dark mode" aria-pressed="${getTheme() === 'dark'}" title="Toggle dark mode">${MOON_ICON}</button>
        <div class="player-chip">
          <div class="avatar">?</div>
          <div class="pmeta">
            <div class="plabel">${escapeHtml(state.user.email)}</div>
            <div class="pvalue"><span>Not an admin</span></div>
          </div>
          <button class="signout" id="signout-btn" type="button">Sign out</button>
        </div>
      </div>
    </header>
    <div class="admin-wrap">
      <div class="admin-section">
        <h2>Not authorized</h2>
        <p class="sub">You're signed in but not an admin yet. To grant yourself admin access, run this in the Supabase SQL editor:</p>
        <pre style="background:var(--bg);padding:14px;border-radius:6px;font-family:ui-monospace,monospace;font-size:12px;overflow-x:auto;white-space:pre-wrap;">insert into public.admins (player_id)
select id from public.players where email = '${escapeHtml(state.user.email)}';</pre>
        <p class="sub" style="margin-top:14px;">Then reload this page.</p>
        <p style="margin-top:16px;"><a href="index.html">← Back to the bracket</a></p>
      </div>
    </div>`;
}

function attachNotAdminHandlers() {
  document.getElementById('signout-btn')?.addEventListener('click', signOut);
  document.getElementById('theme-toggle')?.addEventListener('click', toggleTheme);
}

function renderAdmin() {
  return `
    <header class="top-nav">
      <div class="brand">
        <img src="${brandLogoSrc()}" alt="Milan Laser" class="brand-logo">
        <span class="sub">ADMIN</span>
      </div>
      <div class="nav-right">
        <button class="theme-toggle" id="theme-toggle" type="button" aria-label="Toggle dark mode" aria-pressed="${getTheme() === 'dark'}" title="Toggle dark mode">${MOON_ICON}</button>
        <div class="player-chip">
          <div class="avatar">${escapeHtml((state.player?.display_name || '?').split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase())}</div>
          <div class="pmeta">
            <div class="plabel">${escapeHtml(state.player?.display_name || state.user.email)}</div>
            <div class="pvalue"><a href="index.html" style="color:var(--lime); font-weight:700;">View live →</a></div>
          </div>
          <button class="signout" id="signout-btn" type="button">Sign out</button>
        </div>
      </div>
    </header>
    <div class="admin-wrap">
      ${state.msg ? `<div class="admin-msg ${state.msgKind}">${escapeHtml(state.msg)}</div>` : ''}
      ${renderCreateBracket()}
      ${state.brackets.map(b => renderBracketCard(b)).join('')}
      ${renderPlayersSection()}
    </div>`;
}

function renderCreateBracket() {
  return `
    <div class="admin-section">
      <h2>Create a new bracket</h2>
      <p class="sub">Three brackets total. Pick a name and a champion-bonus value.</p>
      <form id="create-bracket-form">
        <div class="row">
          <div>
            <label for="cb-name">Bracket name</label>
            <input id="cb-name" type="text" required placeholder="e.g. Green Characters">
          </div>
          <div>
            <label for="cb-slug">Slug (URL-safe)</label>
            <input id="cb-slug" type="text" required placeholder="e.g. green-characters" pattern="[a-z0-9-]+">
          </div>
        </div>
        <div class="row">
          <div>
            <label for="cb-bonus">Champion bonus points</label>
            <input id="cb-bonus" type="number" min="0" max="50" value="5">
          </div>
          <div></div>
        </div>
        <button type="submit" class="btn">Create bracket</button>
      </form>
    </div>`;
}

function renderBracketCard(bracket) {
  const expanded = state.expandedBracket === bracket.id;
  const entries = state.entriesByBracket[bracket.id] || [];
  const rounds = state.rounds[bracket.id] || [];
  const ties = getUnresolvedTies(bracket.id);
  const headerActions = `
    <button class="btn ghost" data-toggle="${bracket.id}" type="button">${expanded ? 'Collapse' : 'Manage'}</button>
    <button class="btn danger" data-delete-bracket="${bracket.id}" type="button">Delete</button>`;
  return `
    <div class="admin-section">
      <div class="bracket-card-head" style="margin-bottom:0;">
        <div>
          <h2 style="margin-bottom:4px;">${escapeHtml(bracket.name)} <span class="bracket-status-pill ${bracket.status}">${escapeHtml(bracket.status)}</span></h2>
          <div class="sub" style="margin-bottom:0;">${entries.length}/32 entries · ${rounds.length}/5 rounds${ties.length ? ` · <strong style="color:var(--red);">${ties.length} tie${ties.length===1?'':'s'} to resolve</strong>` : ''}</div>
        </div>
        <div style="display:flex; gap:8px;">${headerActions}</div>
      </div>
      ${expanded ? renderBracketDetail(bracket) : ''}
    </div>`;
}

function renderBracketDetail(bracket) {
  const entries = state.entriesByBracket[bracket.id] || [];
  const rounds = (state.rounds[bracket.id] || []).slice().sort((a,b) => a.round_number - b.round_number);
  const ties = getUnresolvedTies(bracket.id);
  return `
    <hr style="border:none; border-top:1px solid var(--light-gray); margin: 20px 0;">
    ${renderEntriesSection(bracket, entries)}
    ${renderChampionPicksSection(bracket)}
    ${rounds.length > 0 ? renderRoundsSection(bracket, rounds) : ''}
    ${ties.length > 0 ? renderTiesSection(bracket, ties) : ''}`;
}

function renderEntriesSection(bracket, entries) {
  if (entries.length === 0) {
    return `
      <h3>1. Add 32 entries</h3>
      <p class="sub">Paste 32 names below, one per line. Seed 1 (top seed) at the top, seed 32 at the bottom. You'll upload images per entry after this step.</p>
      <textarea id="entries-${bracket.id}" placeholder="Monopoly&#10;Scrabble&#10;Chess&#10;…"></textarea>
      <button class="btn" data-save-entries="${bracket.id}" type="button">Save entries &amp; generate bracket</button>`;
  }
  const locked = !['setup', 'champion_picks'].includes(bracket.status);
  const sorted = entries.slice().sort((a, b) => a.seed - b.seed);
  return `
    <h3>1. Entries ${locked ? '(locked — voting started)' : '(drag to reorder, click icon slot to upload)'}</h3>
    <p class="sub">${locked
      ? 'Voting has started, so seeds and icons are locked. Reordering would invalidate cast votes.'
      : 'Top of the list is seed 1. Drag the ⋮⋮ handle to reseed (Round 1 matchups repair automatically). Click any icon slot to upload an image — max 2MB, square images look best.'}</p>
    <div class="entries-grid" data-entries-bracket="${bracket.id}">
      ${sorted.map(e => `
        <div class="entry-item ${locked ? 'locked' : ''}" data-entry-id="${e.id}">
          ${locked ? '' : '<span class="drag-handle" draggable="true" aria-hidden="true" title="Drag to reorder">⋮⋮</span>'}
          <span class="entry-seed">${e.seed}</span>
          <label class="entry-icon-slot" ${locked ? '' : `title="${e.icon ? 'Click to replace image' : 'Click to upload an image'}"`}>
            ${renderEntryIconPreview(e)}
            ${locked ? '' : `<input type="file" accept="image/*" hidden data-upload-entry="${e.id}">`}
          </label>
          ${(!locked && e.icon) ? `<button class="entry-icon-clear" type="button" data-clear-entry="${e.id}" title="Clear icon" aria-label="Clear icon for ${escapeHtml(e.name)}">×</button>` : ''}
          <span class="entry-name">${escapeHtml(e.name)}</span>
        </div>
      `).join('')}
    </div>
    <button class="btn ghost" data-delete-entries="${bracket.id}" type="button">Delete entries &amp; rounds (start over)</button>`;
}

function renderChampionPicksSection(bracket) {
  const entries = state.entriesByBracket[bracket.id] || [];
  if (entries.length === 0) return '';

  const hasDeadline = !!bracket.champion_picks_close_at;
  const deadlinePassed = hasDeadline && new Date(bracket.champion_picks_close_at) <= new Date();

  if (bracket.status === 'complete') {
    return `
      <h3>2. Champion picks — FINAL</h3>
      <p class="sub">Bracket is complete. Champion bonuses have been awarded.</p>`;
  }

  if (!hasDeadline) {
    return `
      <h3>2. Open champion picks</h3>
      <p class="sub">Let players pick the bracket winner. They earn a bonus if their pick takes home the whole bracket. Picks can stay open through Round 1 voting — set the deadline to whenever you want them locked in.</p>
      <form data-open-picks="${bracket.id}">
        <label for="picks-close-${bracket.id}">Picks close at</label>
        <input id="picks-close-${bracket.id}" type="datetime-local" required>
        <button class="btn lime" type="submit">Open champion picks</button>
      </form>`;
  }

  if (deadlinePassed) {
    return `
      <h3>2. Champion picks — LOCKED</h3>
      <p class="sub">Deadline ${formatWhen(bracket.champion_picks_close_at)} has passed. Players can no longer change their pick.</p>
      <form data-open-picks="${bracket.id}">
        <label for="picks-close-${bracket.id}">Extend deadline (reopens picks)</label>
        <input id="picks-close-${bracket.id}" type="datetime-local" value="${toLocalDateTime(bracket.champion_picks_close_at)}" required>
        <button class="btn ghost" type="submit">Update deadline</button>
      </form>`;
  }

  return `
    <h3>2. Champion picks — OPEN</h3>
    <p class="sub">Closes ${formatWhen(bracket.champion_picks_close_at)}.${bracket.status === 'voting' ? ' Round 1 is also open — picks and voting are running concurrently.' : ''}</p>
    <form data-open-picks="${bracket.id}">
      <label for="picks-close-${bracket.id}">Update close time</label>
      <input id="picks-close-${bracket.id}" type="datetime-local" value="${toLocalDateTime(bracket.champion_picks_close_at)}" required>
      <button class="btn" type="submit">Save deadline</button>
    </form>`;
}

function renderRoundsSection(bracket, rounds) {
  return `
    <h3>3. Round schedule</h3>
    <p class="sub">Each round opens at "opens at" and closes at "closes at". The system auto-opens and auto-closes within ~5 minutes of these times. Rounds also auto-close early if every signed-up player has voted.</p>
    ${rounds.map(r => `
      <div class="bracket-card">
        <div class="bracket-card-head">
          <h3 style="margin:0;">${escapeHtml(r.name)} <span class="bracket-status-pill ${r.status === 'open' ? 'voting' : r.status === 'closed' ? 'complete' : ''}">${r.status}</span></h3>
          <div style="display:flex; gap:8px;">
            ${r.status === 'pending' ? `<button class="btn lime" data-open-round="${r.id}" type="button">Open now</button>` : ''}
            ${r.status === 'open' ? `<button class="btn danger" data-force-close="${r.id}" type="button">Force-close now</button>` : ''}
          </div>
        </div>
        <form data-update-round="${r.id}">
          <div class="row">
            <div>
              <label>Opens at</label>
              <input type="datetime-local" name="opens" value="${toLocalDateTime(r.opens_at)}" required>
            </div>
            <div>
              <label>Closes at</label>
              <input type="datetime-local" name="closes" value="${toLocalDateTime(r.closes_at)}" required>
            </div>
          </div>
          <button class="btn ghost" type="submit">Save schedule</button>
        </form>
      </div>
    `).join('')}`;
}

function renderTiesSection(bracket, ties) {
  return `
    <h3 style="color:var(--red);">4. Resolve ties</h3>
    <p class="sub">These matchups ended in an exact tie. Pick a winner to advance the bracket.</p>
    ${ties.map(({matchup, round}) => {
      const tally = state.tallies[matchup.id] || {};
      return `
        <div class="tie-card">
          <h4>${escapeHtml(round.name)} · matchup ${matchup.position + 1}</h4>
          <div style="font-size:14px; color:var(--dark-teal);">
            <strong>${entrySeed(matchup.entry_a_id)} ${escapeHtml(entryName(matchup.entry_a_id))}</strong>
            (${tally.votes_a || 0} votes)
            vs
            <strong>${entrySeed(matchup.entry_b_id)} ${escapeHtml(entryName(matchup.entry_b_id))}</strong>
            (${tally.votes_b || 0} votes)
          </div>
          <div class="tie-options">
            <button class="btn" data-resolve-tie-matchup="${matchup.id}" data-resolve-tie-winner="${matchup.entry_a_id}" type="button">Winner: ${escapeHtml(entryName(matchup.entry_a_id))}</button>
            <button class="btn" data-resolve-tie-matchup="${matchup.id}" data-resolve-tie-winner="${matchup.entry_b_id}" type="button">Winner: ${escapeHtml(entryName(matchup.entry_b_id))}</button>
          </div>
        </div>
      `;
    }).join('')}`;
}

function renderPlayersSection() {
  return `
    <div class="admin-section">
      <h2>Players (${state.players.length})</h2>
      <p class="sub">Everyone who has signed up so far.</p>
      <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(200px,1fr)); gap:6px; font-size:13px;">
        ${state.players.map(p => `<div style="background:var(--bg); padding:8px 12px; border-radius:4px;"><strong>${escapeHtml(p.display_name)}</strong><br><span style="color:var(--mid-gray); font-size:11px;">${escapeHtml(p.email)}</span></div>`).join('')}
      </div>
    </div>`;
}

function attachAdminHandlers() {
  document.getElementById('signout-btn')?.addEventListener('click', signOut);
  document.getElementById('theme-toggle')?.addEventListener('click', toggleTheme);

  document.getElementById('create-bracket-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('cb-name').value;
    const slug = document.getElementById('cb-slug').value;
    const bonus = parseInt(document.getElementById('cb-bonus').value, 10) || 5;
    createBracket(name, slug, bonus);
  });

  document.querySelectorAll('[data-toggle]').forEach(el => {
    el.addEventListener('click', () => {
      state.expandedBracket = state.expandedBracket === el.dataset.toggle ? null : el.dataset.toggle;
      render();
    });
  });

  document.querySelectorAll('[data-save-entries]').forEach(el => {
    el.addEventListener('click', () => {
      const bracketId = el.dataset.saveEntries;
      const ta = document.getElementById('entries-' + bracketId);
      saveEntries(bracketId, ta.value);
    });
  });

  document.querySelectorAll('[data-delete-entries]').forEach(el => {
    el.addEventListener('click', () => deleteEntries(el.dataset.deleteEntries));
  });

  document.querySelectorAll('[data-delete-bracket]').forEach(el => {
    el.addEventListener('click', () => deleteBracket(el.dataset.deleteBracket));
  });

  document.querySelectorAll('[data-open-picks]').forEach(form => {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const bracketId = form.dataset.openPicks;
      const input = form.querySelector('input[type="datetime-local"]');
      openChampionPicks(bracketId, input.value);
    });
  });

  document.querySelectorAll('[data-update-round]').forEach(form => {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const roundId = form.dataset.updateRound;
      const opens = form.querySelector('input[name="opens"]').value;
      const closes = form.querySelector('input[name="closes"]').value;
      updateRoundSchedule(roundId, opens, closes);
    });
  });

  document.querySelectorAll('[data-force-close]').forEach(el => {
    el.addEventListener('click', () => forceCloseRound(el.dataset.forceClose));
  });

  document.querySelectorAll('[data-open-round]').forEach(el => {
    el.addEventListener('click', () => openRoundNow(el.dataset.openRound));
  });

  attachEntryDragHandlers();
}

let dragSourceId = null;
let dragBracketId = null;

function attachEntryDragHandlers() {
  document.querySelectorAll('[data-entries-bracket]').forEach(grid => {
    const bracketId = grid.dataset.entriesBracket;

    grid.querySelectorAll('.drag-handle[draggable="true"]').forEach(handle => {
      const item = handle.closest('.entry-item');
      handle.addEventListener('dragstart', (e) => {
        dragSourceId = item.dataset.entryId;
        dragBracketId = bracketId;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', dragSourceId);
        item.classList.add('dragging');
      });
      handle.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        document.querySelectorAll('.drag-over-before, .drag-over-after').forEach(el => {
          el.classList.remove('drag-over-before', 'drag-over-after');
        });
        dragSourceId = null;
        dragBracketId = null;
      });
    });

    grid.querySelectorAll('.entry-item').forEach(item => {
      item.addEventListener('dragover', (e) => {
        if (!dragSourceId || dragBracketId !== bracketId) return;
        if (item.dataset.entryId === dragSourceId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = item.getBoundingClientRect();
        const before = (e.clientY - rect.top) < rect.height / 2;
        item.classList.toggle('drag-over-before', before);
        item.classList.toggle('drag-over-after', !before);
      });
      item.addEventListener('dragleave', () => {
        item.classList.remove('drag-over-before', 'drag-over-after');
      });
      item.addEventListener('drop', (e) => {
        e.preventDefault();
        if (!dragSourceId || dragBracketId !== bracketId) return;
        const targetId = item.dataset.entryId;
        if (targetId === dragSourceId) return;
        const before = item.classList.contains('drag-over-before');
        item.classList.remove('drag-over-before', 'drag-over-after');
        reorderEntries(bracketId, dragSourceId, targetId, before);
      });
    });

    grid.querySelectorAll('input[type="file"][data-upload-entry]').forEach(fileInput => {
      fileInput.addEventListener('change', () => {
        const file = fileInput.files && fileInput.files[0];
        if (file) uploadEntryIcon(fileInput.dataset.uploadEntry, file);
        fileInput.value = '';
      });
    });

    grid.querySelectorAll('[data-clear-entry]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearEntryIcon(btn.dataset.clearEntry);
      });
    });
  });

  document.querySelectorAll('[data-resolve-tie-matchup]').forEach(el => {
    el.addEventListener('click', () => {
      resolveTie(el.dataset.resolveTieMatchup, el.dataset.resolveTieWinner);
    });
  });
}

bootstrap();

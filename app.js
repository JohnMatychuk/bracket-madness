// ============================================================
// Milan Bracket Madness — Main App
// ============================================================

const sb = (() => {
  if (!window.SUPABASE_URL || window.SUPABASE_URL.includes('PASTE_YOUR')) return null;
  return supabase.createClient(window.SUPABASE_URL, window.SUPABASE_KEY);
})();

const ROUND_SHORT = ['R32', 'R16', 'QF', 'SF', 'F'];

const state = {
  ready: false,
  user: null,
  player: null,
  brackets: [],
  entries: {},
  rounds: {},
  matchups: {},
  myVotes: {},
  myChampionPicks: {},
  myLocks: {},
  tallies: {},
  leaderboard: [],
  activeBracketId: null,
  signinMode: 'signin',
  signinError: null,
  signinInfo: null,
  signinBusy: false,
  changingPickFor: null,
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
    await loadData();
  }
  state.ready = true;
  render();

  sb.auth.onAuthStateChange((event, session) => {
    state.user = session?.user || null;
    if (state.user) {
      loadData().then(render);
    } else {
      Object.assign(state, {
        player: null, brackets: [], entries: {}, rounds: {}, matchups: {},
        myVotes: {}, myChampionPicks: {}, tallies: {}, leaderboard: [],
        activeBracketId: null,
      });
      render();
    }
  });
}

async function signIn(email, password) {
  state.signinError = null; state.signinBusy = true; render();
  const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
  state.signinBusy = false;
  if (error) state.signinError = error.message;
  render();
}

async function signUp(email, password) {
  state.signinError = null; state.signinInfo = null; state.signinBusy = true; render();
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail.endsWith('@milanlaser.com')) {
    state.signinError = 'Only @milanlaser.com emails are allowed.';
    state.signinBusy = false; render(); return;
  }
  const { data, error } = await sb.auth.signUp({ email: cleanEmail, password });
  state.signinBusy = false;
  if (error) {
    state.signinError = error.message;
  } else if (!data.session) {
    state.signinInfo = 'Account created — check your email to confirm, then sign in.';
    state.signinMode = 'signin';
  } else {
    state.signinInfo = "You're in! Loading…";
  }
  render();
}

async function signOut() {
  await sb.auth.signOut();
}

// ============================================================
// DATA LOADING
// ============================================================
async function loadData() {
  if (!state.user) return;

  const [
    playerRes, bracketsRes, entriesRes, roundsRes, matchupsRes,
    votesRes, picksRes, locksRes, leaderboardRes,
  ] = await Promise.all([
    sb.from('players').select('*').eq('id', state.user.id).maybeSingle(),
    sb.from('brackets').select('*').order('sort_order').order('created_at'),
    sb.from('entries').select('*').order('seed'),
    sb.from('rounds').select('*').order('round_number'),
    sb.from('matchups').select('*').order('position'),
    sb.from('votes').select('*').eq('player_id', state.user.id),
    sb.from('champion_picks').select('*').eq('player_id', state.user.id),
    sb.from('round_locks').select('*').eq('player_id', state.user.id),
    sb.from('leaderboard').select('*').order('total_points', { ascending: false }),
  ]);

  state.player = playerRes.data;
  state.brackets = bracketsRes.data || [];
  state.entries = {};
  (entriesRes.data || []).forEach(e => state.entries[e.id] = e);
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
  state.myVotes = {};
  (votesRes.data || []).forEach(v => state.myVotes[v.matchup_id] = v);
  state.myChampionPicks = {};
  (picksRes.data || []).forEach(p => state.myChampionPicks[p.bracket_id] = p);
  state.myLocks = {};
  (locksRes.data || []).forEach(l => state.myLocks[l.round_id] = l);
  state.leaderboard = leaderboardRes.data || [];

  // Fetch tallies only for rounds the caller can see: closed rounds OR rounds the caller has locked
  state.tallies = {};
  const tallyPromises = [];
  Object.values(state.rounds).flat().forEach(round => {
    const visible = round.status === 'closed' || !!state.myLocks[round.id];
    if (visible) {
      tallyPromises.push(
        sb.rpc('get_round_tallies', { p_round_id: round.id }).then(({ data }) => {
          (data || []).forEach(t => { state.tallies[t.matchup_id] = t; });
        })
      );
    }
  });
  await Promise.all(tallyPromises);

  if (!state.activeBracketId && state.brackets.length > 0) {
    state.activeBracketId = state.brackets[0].id;
  } else if (state.activeBracketId && !state.brackets.find(b => b.id === state.activeBracketId)) {
    state.activeBracketId = state.brackets[0]?.id || null;
  }
}

// ============================================================
// ACTIONS
// ============================================================
async function castVote(matchupId, entryId) {
  const existing = state.myVotes[matchupId];
  state.myVotes[matchupId] = {
    ...(existing || {}),
    matchup_id: matchupId,
    voted_entry_id: entryId,
    player_id: state.user.id,
  };
  render();

  let res;
  if (existing) {
    res = await sb.from('votes').update({
      voted_entry_id: entryId,
      updated_at: new Date().toISOString(),
    }).eq('matchup_id', matchupId).eq('player_id', state.user.id);
  } else {
    res = await sb.from('votes').insert({
      matchup_id: matchupId,
      voted_entry_id: entryId,
      player_id: state.user.id,
    });
  }
  if (res.error) {
    alert('Could not save your vote: ' + res.error.message);
    if (existing) state.myVotes[matchupId] = existing;
    else delete state.myVotes[matchupId];
  }
  await loadData();
  render();
}

async function submitChampionPick(bracketId, entryId) {
  const existing = state.myChampionPicks[bracketId];
  let res;
  if (existing) {
    res = await sb.from('champion_picks').update({
      entry_id: entryId,
      updated_at: new Date().toISOString(),
    }).eq('bracket_id', bracketId).eq('player_id', state.user.id);
  } else {
    res = await sb.from('champion_picks').insert({
      bracket_id: bracketId,
      entry_id: entryId,
      player_id: state.user.id,
    });
  }
  if (res.error) {
    alert('Could not save your pick: ' + res.error.message);
    return;
  }
  state.changingPickFor = null;
  await loadData();
  render();
}

function selectBracket(bracketId) {
  state.activeBracketId = bracketId;
  render();
}

async function lockMyVotesForRound(roundId, roundName) {
  if (!confirm(`Lock in your votes for ${roundName}? You won't be able to change them after this. In return you'll see live vote tallies.`)) return;
  const { error } = await sb.rpc('lock_round', { p_round_id: roundId });
  if (error) {
    alert('Could not lock in: ' + error.message);
    return;
  }
  await loadData();
  render();
}

// ============================================================
// HELPERS
// ============================================================
function activeBracket() {
  return state.brackets.find(b => b.id === state.activeBracketId);
}
function bracketRounds(bracketId) {
  return (state.rounds[bracketId] || []).slice().sort((a, b) => a.round_number - b.round_number);
}
function currentOpenRound(bracketId) {
  return bracketRounds(bracketId).find(r => r.status === 'open');
}
function bracketStateLabel(bracket) {
  if (!bracket) return '';
  if (bracket.status === 'setup') return 'TBD';
  if (bracket.status === 'champion_picks') return 'PICKS';
  if (bracket.status === 'complete') return 'DONE';
  const open = currentOpenRound(bracket.id);
  if (open) return ROUND_SHORT[open.round_number - 1] || '—';
  const lastClosed = bracketRounds(bracket.id).slice().reverse().find(r => r.status === 'closed');
  if (lastClosed) return ROUND_SHORT[lastClosed.round_number - 1] || '—';
  return '—';
}
function entryName(id) { return state.entries[id]?.name || '—'; }
function entrySeed(id) { return state.entries[id]?.seed || '—'; }
function isImageUrl(str) { return typeof str === 'string' && /^https?:\/\//i.test(str); }
function entryIconHtml(id) {
  const e = state.entries[id];
  if (e?.icon && isImageUrl(e.icon)) {
    return `<img class="slot-icon" src="${escapeHtml(e.icon)}" alt="" loading="lazy">`;
  }
  return '<span class="slot-icon empty" aria-hidden="true"></span>';
}
function escapeHtml(s) {
  return (s == null ? '' : String(s)).replace(/[<>&"']/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function initials(name) {
  if (!name) return '?';
  return name.split(/\s+/).map(w => w[0] || '').slice(0, 2).join('').toUpperCase();
}
function myScore() {
  if (!state.player) return 0;
  return state.leaderboard.find(r => r.player_id === state.player.id)?.total_points || 0;
}
function myChampionsAlive() {
  if (!state.player) return { alive: 0, picked: 0 };
  const row = state.leaderboard.find(r => r.player_id === state.player.id);
  return { alive: row?.champions_alive || 0, picked: row?.champions_picked || 0 };
}
function formatCountdown(target) {
  if (!target) return null;
  const ms = new Date(target) - new Date();
  if (ms <= 0) return null;
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const pad = (n) => n.toString().padStart(2, '0');
  if (d > 0) return `${d}d ${pad(h)}h ${pad(m)}m ${pad(s)}s`;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

// ============================================================
// RENDER
// ============================================================
let lastRenderedSection = null;

function render() {
  const root = document.getElementById('app');
  if (!state.ready) { root.innerHTML = `<div class="spinner"></div>`; return; }
  if (!state.user) { root.innerHTML = renderSignIn(); attachSigninHandlers(); return; }
  root.innerHTML = renderApp();
  attachAppHandlers();

  // Only animate when changing sections (not on every 30s auto-refresh)
  const currentSection = state.activeBracketId || '__none__';
  if (currentSection !== lastRenderedSection) {
    root.classList.add('bm-animate');
    setTimeout(() => root.classList.remove('bm-animate'), 700);
    lastRenderedSection = currentSection;
  }

  requestAnimationFrame(() => requestAnimationFrame(drawBracketConnectors));
}

function drawBracketConnectors() {
  const inner = document.querySelector('.bracket-inner');
  if (!inner) return;
  inner.style.position = 'relative';
  const old = inner.querySelector(':scope > svg.bracket-connectors');
  if (old) old.remove();

  const containerRect = inner.getBoundingClientRect();
  if (containerRect.width === 0) return;

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.classList.add('bracket-connectors');
  svg.setAttribute('width', String(containerRect.width));
  svg.setAttribute('height', String(containerRect.height));

  const cols = inner.querySelectorAll('.round-col');
  for (let i = 0; i < cols.length - 1; i++) {
    const aWraps = cols[i].querySelectorAll('.matchup-wrap');
    const nWraps = cols[i + 1].querySelectorAll('.matchup-wrap');
    for (let j = 0; j < aWraps.length; j += 2) {
      const A = aWraps[j], B = aWraps[j + 1], T = nWraps[j / 2];
      if (!A || !B || !T) continue;
      const aR = A.getBoundingClientRect();
      const bR = B.getBoundingClientRect();
      const tR = T.getBoundingClientRect();
      const aX = aR.right - containerRect.left;
      const aY = aR.top + aR.height / 2 - containerRect.top;
      const bX = bR.right - containerRect.left;
      const bY = bR.top + bR.height / 2 - containerRect.top;
      const tX = tR.left - containerRect.left;
      const tY = tR.top + tR.height / 2 - containerRect.top;
      const midX = (Math.max(aX, bX) + tX) / 2;

      const lineFromA = document.createElementNS(NS, 'polyline');
      lineFromA.setAttribute('points', `${aX},${aY} ${midX},${aY} ${midX},${tY} ${tX},${tY}`);
      lineFromA.setAttribute('fill', 'none');
      lineFromA.setAttribute('stroke', 'currentColor');
      lineFromA.setAttribute('stroke-width', '1.5');
      lineFromA.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(lineFromA);

      const lineFromB = document.createElementNS(NS, 'polyline');
      lineFromB.setAttribute('points', `${bX},${bY} ${midX},${bY} ${midX},${tY}`);
      lineFromB.setAttribute('fill', 'none');
      lineFromB.setAttribute('stroke', 'currentColor');
      lineFromB.setAttribute('stroke-width', '1.5');
      lineFromB.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(lineFromB);
    }
  }

  inner.appendChild(svg);
}

window.addEventListener('resize', () => requestAnimationFrame(drawBracketConnectors));

function renderConfigMissing() {
  return `
    <div class="signin-page">
      <div class="signin-card">
        <h1>Setup required</h1>
        <p class="sub">Edit <code>supabase-config.js</code> with your Supabase project URL and publishable key, then reload this page.</p>
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
        <div class="event-tag">BRACKET MADNESS</div>
        <h1>${mode === 'signup' ? 'Get in the game' : 'Welcome back'}</h1>
        <p class="sub">${mode === 'signup'
          ? 'Sign up with your @milanlaser.com email and pick a password.'
          : 'Sign in with your @milanlaser.com email.'}</p>
        <form class="signin-form" id="signin-form">
          <div class="row">
            <label for="email">Email</label>
            <input id="email" type="email" required placeholder="you@milanlaser.com" autocomplete="email">
          </div>
          <div class="row">
            <label for="password">Password</label>
            <input id="password" type="password" required minlength="6" placeholder="At least 6 characters" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}">
          </div>
          ${state.signinError ? `<div class="signin-error">${escapeHtml(state.signinError)}</div>` : ''}
          ${state.signinInfo ? `<div class="signin-info">${escapeHtml(state.signinInfo)}</div>` : ''}
          <button type="submit" class="submit" ${state.signinBusy ? 'disabled' : ''}>
            ${state.signinBusy ? 'Working…' : (mode === 'signup' ? 'Create account' : 'Sign in')}
          </button>
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
  const form = document.getElementById('signin-form');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const email = document.getElementById('email').value;
      const password = document.getElementById('password').value;
      if (state.signinMode === 'signup') signUp(email, password);
      else signIn(email, password);
    });
  }
  document.getElementById('toggle-mode')?.addEventListener('click', () => {
    state.signinMode = state.signinMode === 'signup' ? 'signin' : 'signup';
    state.signinError = null; state.signinInfo = null;
    render();
  });
}

function renderApp() {
  return renderTopNav() + renderBracketTabs() + renderActiveBracket();
}

function renderTopNav() {
  const name = state.player?.display_name || state.user.email;
  const score = myScore();
  const champs = myChampionsAlive();
  let champText;
  if (champs.picked === 0) champText = 'No champ picks';
  else if (champs.alive > 0) champText = `${champs.alive} champ${champs.alive === 1 ? '' : 's'} alive`;
  else champText = 'No champs alive';
  return `
    <header class="top-nav">
      <div class="brand">
        <img src="${brandLogoSrc()}" alt="Milan Laser" class="brand-logo">
        <span class="sub">BRACKET MADNESS</span>
      </div>
      <div class="nav-right">
        <button class="theme-toggle" id="theme-toggle" type="button" aria-label="Toggle dark mode" aria-pressed="${getTheme() === 'dark'}" title="Toggle dark mode">${MOON_ICON}</button>
        <div class="player-chip">
          <div class="avatar">${initials(name)}</div>
          <div class="pmeta">
            <div class="plabel">${escapeHtml(name)}</div>
            <div class="pvalue">
              <span class="pscore">${score} pts</span>
              <span class="pdot">·</span>
              <span>${champText}</span>
            </div>
          </div>
          <button class="signout" id="signout-btn" type="button">Sign out</button>
        </div>
      </div>
    </header>`;
}

function renderBracketTabs() {
  if (state.brackets.length === 0) return '';
  const anyComplete = state.brackets.some(b => b.status === 'complete');
  return `
    <nav class="bracket-tabs">
      ${state.brackets.map(b => `
        <button class="bracket-tab ${b.id === state.activeBracketId ? 'active' : ''}" data-bracket-tab="${b.id}" type="button">
          ${escapeHtml(b.name)}
          <span class="pill">${bracketStateLabel(b)}</span>
        </button>
      `).join('')}
      ${anyComplete ? `
        <button class="bracket-tab ${state.activeBracketId === 'standings' ? 'active' : ''}" data-bracket-tab="standings" type="button">
          Final Standings
          <span class="pill">🏆</span>
        </button>
      ` : ''}
    </nav>`;
}

function renderActiveBracket() {
  if (state.activeBracketId === 'standings') {
    return renderStandingsPage() + renderFooter();
  }
  const b = activeBracket();
  if (!b) {
    return `
      <div class="empty-state">
        <h2>No brackets yet</h2>
        <p>Your admin hasn't created any brackets yet. Hold tight — the game is about to start.</p>
      </div>${renderFooter()}`;
  }
  if (b.status === 'setup') {
    return `
      <div class="empty-state">
        <h2>${escapeHtml(b.name)} — coming soon</h2>
        <p>This bracket is being set up. Check back once entries are in and picks open.</p>
      </div>${renderFooter()}`;
  }
  return renderBracketView(b) + renderFooter();
}

function renderStandingsPage() {
  const board = state.leaderboard;
  const completedBrackets = state.brackets.filter(b => b.status === 'complete');
  const allComplete = completedBrackets.length === state.brackets.length;
  const myId = state.player?.id;

  return `
    <section class="hero">
      <div>
        <h1>Final <span class="accent">Standings</span><span class="lime-dot"></span></h1>
        <div class="tagline">${allComplete ? 'All' : completedBrackets.length + ' of ' + state.brackets.length} brackets complete · ${board.length} player${board.length === 1 ? '' : 's'}</div>
      </div>
    </section>
    <div class="standings-page">
      ${board.length === 0 ? '<div class="empty-state"><p>No standings yet.</p></div>' : `
      <table class="standings-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Player</th>
            <th class="num">Total</th>
            <th class="num">Rounds</th>
            <th class="num">Champion Bonus</th>
            <th>Champions Alive</th>
          </tr>
        </thead>
        <tbody>
          ${board.map((r, i) => `
            <tr class="${r.player_id === myId ? 'you' : ''} ${i === 0 ? 'first' : ''}">
              <td class="rank">${i + 1}</td>
              <td class="player">${r.player_id === myId ? 'You' : escapeHtml(r.display_name)}</td>
              <td class="num total">${r.total_points}</td>
              <td class="num">${r.round_points}</td>
              <td class="num">${r.champion_bonus}</td>
              <td>${r.champions_alive}/${r.champions_picked || 0}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>`}
    </div>`;
}

function canStillPickChampion(bracket) {
  if (!['champion_picks', 'voting'].includes(bracket.status)) return false;
  if (!bracket.champion_picks_close_at) return true;
  return new Date(bracket.champion_picks_close_at) > new Date();
}

function renderChampionPickGrid(bracket) {
  if (!canStillPickChampion(bracket)) return '';
  const entries = Object.values(state.entries)
    .filter(e => e.bracket_id === bracket.id)
    .sort((a, b) => a.seed - b.seed);
  if (entries.length === 0) return '';

  const myPick = state.myChampionPicks[bracket.id];
  const isChanging = state.changingPickFor === bracket.id;
  // Only show the expanded grid if no pick yet OR user explicitly clicked "Change pick"
  if (myPick && !isChanging) return '';

  const cd = bracket.champion_picks_close_at
    ? formatCountdown(bracket.champion_picks_close_at)
    : null;
  const targetAttr = bracket.champion_picks_close_at
    ? ` data-countdown-target="${bracket.champion_picks_close_at}"`
    : '';

  return `
    <section class="champion-pick-banner expanded">
      <div class="cpb-header">
        <div>
          <div class="cpb-label">Champion pick · +${bracket.champion_bonus_points} bonus if your pick wins it all</div>
          <div class="cpb-title">Pick the bracket winner${myPick ? ' — your current pick is ' + escapeHtml(entryName(myPick.entry_id)) : ''}</div>
        </div>
        <div class="cpb-deadline"${targetAttr}>
          <div class="cpb-deadline-label">Locks in</div>
          <div class="cpb-deadline-time">${cd || 'Open'}</div>
        </div>
      </div>
      <div class="picks-grid">
        ${entries.map(e => `
          <button class="pick-option ${myPick?.entry_id === e.id ? 'selected' : ''}" data-pick="${e.id}" data-pick-bracket="${bracket.id}" type="button">
            <span class="seed">${e.seed}</span>
            ${entryIconHtml(e.id)}
            <span class="name">${escapeHtml(e.name)}</span>
          </button>
        `).join('')}
      </div>
    </section>`;
}

function renderChampionPickCard(bracket) {
  if (!canStillPickChampion(bracket)) return '';
  const myPick = state.myChampionPicks[bracket.id];
  const isChanging = state.changingPickFor === bracket.id;
  // Only show the compact card when picked AND not currently changing (grid is showing instead)
  if (!myPick || isChanging) return '';

  const cd = bracket.champion_picks_close_at
    ? formatCountdown(bracket.champion_picks_close_at)
    : null;
  const targetAttr = bracket.champion_picks_close_at
    ? ` data-countdown-target="${bracket.champion_picks_close_at}"`
    : '';

  return `
    <aside class="champion-pick-card">
      <div class="cpc-label">Your champion pick</div>
      <div class="cpc-pick">
        ${entryIconHtml(myPick.entry_id)}
        <strong>${escapeHtml(entryName(myPick.entry_id))}</strong>
      </div>
      <div class="cpc-deadline"${targetAttr}>
        <span class="cpc-deadline-label">Locks in</span>
        <span class="cpc-deadline-time">${cd || 'Soon'}</span>
      </div>
      <button class="btn ghost cpc-change" data-change-pick="${bracket.id}" type="button">Change pick</button>
    </aside>`;
}

function renderChampionPickScreen(bracket) {
  const entries = Object.values(state.entries)
    .filter(e => e.bracket_id === bracket.id)
    .sort((a, b) => a.seed - b.seed);
  const myPick = state.myChampionPicks[bracket.id];
  const deadline = bracket.champion_picks_close_at;
  const countdown = deadline ? formatCountdown(deadline) : null;

  return `
    ${renderHero(bracket, {
      tagline: 'Pick your champion before round 1 opens. You can change your mind up until the deadline.',
      countdownTime: countdown,
      countdownTarget: deadline,
      countdownLabel: 'Picks close in',
      countdownRound: countdown ? 'Lock in early' : 'Picks closed',
    })}
    <section class="picks-section">
      <div class="picks-card">
        <h2>Champion pick</h2>
        <p class="picks-sub">If your pick takes home the whole bracket, you score a <strong>+${bracket.champion_bonus_points} bonus</strong>. Pick smart.</p>
        ${myPick ? `<div class="locked-banner">Your current pick: <strong>${escapeHtml(entryName(myPick.entry_id))}</strong>. You can change it until the deadline.</div>` : ''}
        ${entries.length === 0
          ? `<div style="color:var(--dark-gray); font-size:14px;">Entries aren't loaded yet — check back soon.</div>`
          : `<div class="picks-grid">
              ${entries.map(e => `
                <button class="pick-option ${myPick?.entry_id === e.id ? 'selected' : ''}" data-pick="${e.id}" data-pick-bracket="${bracket.id}" type="button">
                  <span class="seed">${e.seed}</span>
                  ${entryIconHtml(e.id)}
                  <span class="name">${escapeHtml(e.name)}</span>
                </button>
              `).join('')}
            </div>`}
        <div class="pick-status ${myPick ? 'saved' : ''}">${myPick ? '✓ Pick saved.' : 'Tap any entry to save your pick.'}</div>
      </div>
    </section>`;
}

function renderHero(bracket, opts) {
  const parts = bracket.name.split(/\s+/);
  const accent = parts[parts.length - 1];
  const front = parts.slice(0, -1).join(' ');
  const cdClass = opts.countdownTime ? '' : 'closed';
  const targetAttr = opts.countdownTarget ? ` data-countdown-target="${opts.countdownTarget}"` : '';
  return `
    <section class="hero">
      <div>
        <h1>${escapeHtml(front)}${front ? ' ' : ''}<span class="accent">${escapeHtml(accent)}</span><span class="lime-dot"></span></h1>
        <div class="tagline">${opts.tagline}</div>
      </div>
      <div class="countdown ${cdClass}"${targetAttr}>
        <div class="label">${opts.countdownLabel}</div>
        <div class="time">${opts.countdownTime || '—'}</div>
        <div class="round">${opts.countdownRound}</div>
      </div>
    </section>`;
}

function renderBracketView(bracket) {
  const rounds = bracketRounds(bracket.id);
  const openRound = currentOpenRound(bracket.id);

  let heroOpts;
  if (openRound) {
    const cd = formatCountdown(openRound.closes_at);
    const myChamp = state.myChampionPicks[bracket.id];
    heroOpts = {
      tagline: `32 entries. 5 rounds. One champion.${myChamp ? ` You picked <strong>${escapeHtml(entryName(myChamp.entry_id))}</strong>.` : ''}`,
      countdownTime: cd,
      countdownTarget: openRound.closes_at,
      countdownLabel: 'Round closes in',
      countdownRound: `${openRound.name} · ${cd ? 'Vote now' : 'Closing…'}`,
    };
  } else if (bracket.status === 'complete') {
    const finalRound = rounds.find(r => r.round_number === 5);
    const finalMatchup = (state.matchups[finalRound?.id] || [])[0];
    const champion = finalMatchup?.winner_entry_id ? entryName(finalMatchup.winner_entry_id) : '—';
    heroOpts = {
      tagline: `Champion: <strong>${escapeHtml(champion)}</strong>. Final standings below.`,
      countdownTime: 'Done',
      countdownLabel: 'Bracket',
      countdownRound: 'Complete',
    };
  } else {
    const next = rounds.find(r => r.status === 'pending');
    heroOpts = {
      tagline: next
        ? `Next round (${escapeHtml(next.name)}) opens ${new Date(next.opens_at).toLocaleString()}.`
        : 'Voting paused — check back soon.',
      countdownTime: next ? formatCountdown(next.opens_at) : '—',
      countdownTarget: next ? next.opens_at : null,
      countdownLabel: 'Next round in',
      countdownRound: next ? next.name : 'Paused',
    };
  }

  return `
    ${renderHero(bracket, heroOpts)}
    ${renderChampionPickGrid(bracket)}
    ${renderLockBanner(bracket)}
    <div class="main-area">
      <div class="bracket-wrap">
        <div class="bracket-inner">
          ${rounds.map((r, idx) => renderRoundColumn(r, idx === 4)).join('')}
        </div>
      </div>
      <div class="sidebar-stack">
        ${renderChampionPickCard(bracket)}
        ${renderStandings()}
      </div>
    </div>`;
}

function renderLockBanner(bracket) {
  const openRound = currentOpenRound(bracket.id);
  if (!openRound) return '';
  const matchups = state.matchups[openRound.id] || [];
  if (matchups.length === 0) return '';

  const isLocked = !!state.myLocks[openRound.id];
  const myVotedCount = matchups.filter(m => state.myVotes[m.id]).length;
  const total = matchups.length;

  if (isLocked) {
    return `
      <section class="lock-banner locked">
        <span>🔒 Your votes for <strong>${escapeHtml(openRound.name)}</strong> are locked — tallies revealed below.</span>
      </section>`;
  }
  if (myVotedCount < total) {
    return `
      <section class="lock-banner partial">
        <span><strong>${myVotedCount}/${total}</strong> votes cast for ${escapeHtml(openRound.name)} · finish voting to unlock the "Lock in" button.</span>
      </section>`;
  }
  return `
    <section class="lock-banner ready">
      <span><strong>All ${total} votes in.</strong> Lock in your picks for ${escapeHtml(openRound.name)} to reveal live tallies — you won't be able to change votes after.</span>
      <button class="btn lime" data-lock-round="${openRound.id}" data-lock-round-name="${escapeHtml(openRound.name)}" type="button">Lock in my votes</button>
    </section>`;
}

function renderRoundColumn(round, isFinal) {
  const matchups = (state.matchups[round.id] || []).slice().sort((a, b) => a.position - b.position);
  const statusClass = round.status === 'closed' ? 'closed' : (round.status === 'pending' ? 'pending' : '');
  const statusText = round.status === 'closed'
    ? 'Closed'
    : (round.status === 'pending'
      ? new Date(round.opens_at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
      : 'Open');
  return `
    <div class="round-col">
      <div class="round-header">
        <span>${escapeHtml(round.name)}</span>
        <span class="status ${statusClass}">${statusText}</span>
      </div>
      ${matchups.length === 0
        ? '<div style="color:var(--mid-gray);font-size:12px;font-style:italic;">No matchups yet</div>'
        : matchups.map(m => renderMatchup(m, round, isFinal)).join('')}
    </div>`;
}

function renderMatchup(matchup, round, isFinal) {
  const a = matchup.entry_a_id;
  const b = matchup.entry_b_id;
  const myVote = state.myVotes[matchup.id];
  const tally = state.tallies[matchup.id];
  const isLockedForMe = round.status === 'open' && !!state.myLocks[round.id];
  const isPending = round.status === 'pending' || (!a && !b);
  const isOpen = round.status === 'open' && a && b && !isLockedForMe;
  const isClosed = round.status === 'closed';
  const winnerId = matchup.winner_entry_id;
  const myPickWon = myVote && winnerId && myVote.voted_entry_id === winnerId;
  const isTie = matchup.is_tie && !winnerId;

  const votesA = tally?.votes_a || 0;
  const votesB = tally?.votes_b || 0;
  const totalVotes = votesA + votesB;
  const pctA = totalVotes ? Math.round(100 * votesA / totalVotes) : 0;
  const pctB = totalVotes ? Math.round(100 * votesB / totalVotes) : 0;

  if (isLockedForMe) {
    const aPicked = myVote?.voted_entry_id === a;
    const bPicked = myVote?.voted_entry_id === b;
    return `
      <div class="matchup-wrap">
        <div class="matchup voted locked">
          <div class="ribbon">🔒 Locked in</div>
          <div class="slot ${aPicked ? 'picked' : ''}">
            <div class="seed">${entrySeed(a)}</div>
            ${entryIconHtml(a)}
            <div class="name">${escapeHtml(entryName(a))}</div>
            <div class="meta">${votesA} · ${pctA}%</div>
          </div>
          <div class="slot ${bPicked ? 'picked' : ''}">
            <div class="seed">${entrySeed(b)}</div>
            ${entryIconHtml(b)}
            <div class="name">${escapeHtml(entryName(b))}</div>
            <div class="meta">${votesB} · ${pctB}%</div>
          </div>
        </div>
      </div>`;
  }

  if (isPending) {
    return `
      <div class="matchup-wrap">
        <div class="matchup ${isFinal ? 'final' : 'upcoming'}">
          ${isFinal ? '<div class="ribbon">🏆 Champion</div>' : ''}
          <div class="slot">
            <div class="seed">${a ? entrySeed(a) : '—'}</div>
            ${a ? entryIconHtml(a) : '<span class="slot-icon empty" aria-hidden="true"></span>'}
            <div class="name">${a ? escapeHtml(entryName(a)) : 'TBD'}</div>
            <div class="meta"></div>
          </div>
          <div class="slot">
            <div class="seed">${b ? entrySeed(b) : '—'}</div>
            ${b ? entryIconHtml(b) : '<span class="slot-icon empty" aria-hidden="true"></span>'}
            <div class="name">${b ? escapeHtml(entryName(b)) : 'TBD'}</div>
            <div class="meta"></div>
          </div>
        </div>
      </div>`;
  }

  if (isOpen) {
    const voted = !!myVote;
    const ribbon = voted ? `<div class="ribbon">Voted ✓ Tap to change</div>` : `<div class="ribbon">Vote Now</div>`;
    const aPicked = myVote?.voted_entry_id === a;
    const bPicked = myVote?.voted_entry_id === b;
    return `
      <div class="matchup-wrap">
        <div class="matchup ${voted ? 'voted' : 'open'}">
          ${ribbon}
          <button class="slot ${aPicked ? 'picked' : ''}" data-vote-matchup="${matchup.id}" data-vote-entry="${a}" type="button">
            <div class="seed">${entrySeed(a)}</div>
            ${entryIconHtml(a)}
            <div class="name">${escapeHtml(entryName(a))}</div>
            <div class="meta"></div>
          </button>
          <button class="slot ${bPicked ? 'picked' : ''}" data-vote-matchup="${matchup.id}" data-vote-entry="${b}" type="button">
            <div class="seed">${entrySeed(b)}</div>
            ${entryIconHtml(b)}
            <div class="name">${escapeHtml(entryName(b))}</div>
            <div class="meta"></div>
          </button>
        </div>
      </div>`;
  }

  const aWin = winnerId === a;
  const bWin = winnerId === b;

  if (isTie) {
    return `
      <div class="matchup-wrap">
        <div class="matchup tie">
          <div class="ribbon">Tie — awaiting admin</div>
          <div class="slot">
            <div class="seed">${entrySeed(a)}</div>
            ${entryIconHtml(a)}
            <div class="name">${escapeHtml(entryName(a))}</div>
            <div class="meta">${votesA} · ${pctA}%</div>
          </div>
          <div class="slot">
            <div class="seed">${entrySeed(b)}</div>
            ${entryIconHtml(b)}
            <div class="name">${escapeHtml(entryName(b))}</div>
            <div class="meta">${votesB} · ${pctB}%</div>
          </div>
        </div>
      </div>`;
  }

  return `
    <div class="matchup-wrap">
      <div class="matchup closed">
        <div class="slot ${aWin ? 'winner' : 'loser'}">
          <div class="seed">${entrySeed(a)}</div>
          ${entryIconHtml(a)}
          <div class="name">${escapeHtml(entryName(a))}</div>
          <div class="meta">${votesA} · ${pctA}%</div>
        </div>
        <div class="slot ${bWin ? 'winner' : 'loser'}">
          <div class="seed">${entrySeed(b)}</div>
          ${entryIconHtml(b)}
          <div class="name">${escapeHtml(entryName(b))}</div>
          <div class="meta">${votesB} · ${pctB}%</div>
        </div>
      </div>
      ${myPickWon ? '<div class="point-badge" aria-label="You earned a point">+1</div>' : ''}
    </div>`;
}

function renderStandings() {
  const myId = state.player?.id;
  const rows = state.leaderboard.slice(0, 12);
  return `
    <aside class="standings">
      <h2>Standings</h2>
      <div class="h2-sub">Across all brackets · live</div>
      ${rows.length === 0 ? '<div style="font-size:13px;color:var(--dark-gray);">No scores yet.</div>' : ''}
      ${rows.map((r, i) => `
        <div class="leader-row ${r.player_id === myId ? 'you' : ''} ${i === 0 ? 'medal-1' : ''}">
          <div class="rank">${i + 1}</div>
          <div>${r.player_id === myId ? 'You' : escapeHtml(r.display_name)}</div>
          ${r.champions_picked > 0
            ? (r.champions_alive > 0
              ? `<div class="champ-tag">CHAMP ${r.champions_alive > 1 ? '×' + r.champions_alive : 'IN'}</div>`
              : `<div class="champ-tag out">OUT</div>`)
            : '<div></div>'}
          <div class="pts">${r.total_points}</div>
        </div>
      `).join('')}
    </aside>`;
}

function renderFooter() {
  return `
    <div class="footer-note">
      Milan Bracket Madness · <a href="admin.html">Admin</a>
    </div>`;
}

function attachAppHandlers() {
  document.getElementById('signout-btn')?.addEventListener('click', signOut);
  document.getElementById('theme-toggle')?.addEventListener('click', toggleTheme);
  document.querySelectorAll('[data-bracket-tab]').forEach(el => {
    el.addEventListener('click', () => selectBracket(el.dataset.bracketTab));
  });
  document.querySelectorAll('[data-pick]').forEach(el => {
    el.addEventListener('click', () => submitChampionPick(el.dataset.pickBracket, el.dataset.pick));
  });
  document.querySelectorAll('[data-change-pick]').forEach(el => {
    el.addEventListener('click', () => {
      state.changingPickFor = el.dataset.changePick;
      render();
    });
  });
  document.querySelectorAll('[data-lock-round]').forEach(el => {
    el.addEventListener('click', () => {
      lockMyVotesForRound(el.dataset.lockRound, el.dataset.lockRoundName);
    });
  });
  document.querySelectorAll('[data-vote-matchup]').forEach(el => {
    el.addEventListener('click', () => castVote(el.dataset.voteMatchup, el.dataset.voteEntry));
  });
}

// ============================================================
// AUTO-REFRESH
// ============================================================
setInterval(async () => {
  if (state.user && document.visibilityState === 'visible') {
    await loadData();
    render();
  }
}, 30000);

// Lightweight per-second countdown updates (no full re-render)
setInterval(() => {
  document.querySelectorAll('[data-countdown-target]').forEach(el => {
    const target = el.dataset.countdownTarget;
    const cd = formatCountdown(target);
    const timeEl = el.querySelector('.time, .cpb-deadline-time');
    if (timeEl) timeEl.textContent = cd || '—';
    if (cd && new Date(target) - new Date() < 60 * 60 * 1000) {
      el.classList.add('urgent');
    }
  });
}, 1000);

bootstrap();

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
  tallies: {},
  leaderboard: [],
  activeBracketId: null,
  signinMode: 'signin',
  signinError: null,
  signinInfo: null,
  signinBusy: false,
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
    votesRes, picksRes, talliesRes, leaderboardRes,
  ] = await Promise.all([
    sb.from('players').select('*').eq('id', state.user.id).maybeSingle(),
    sb.from('brackets').select('*').order('sort_order').order('created_at'),
    sb.from('entries').select('*').order('seed'),
    sb.from('rounds').select('*').order('round_number'),
    sb.from('matchups').select('*').order('position'),
    sb.from('votes').select('*').eq('player_id', state.user.id),
    sb.from('champion_picks').select('*').eq('player_id', state.user.id),
    sb.from('matchup_tallies').select('*'),
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
  state.tallies = {};
  (talliesRes.data || []).forEach(t => state.tallies[t.matchup_id] = t);
  state.leaderboard = leaderboardRes.data || [];

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
  await loadData();
  render();
}

function selectBracket(bracketId) {
  state.activeBracketId = bracketId;
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
  if (d > 0) return `${d}d ${h.toString().padStart(2, '0')}h ${m.toString().padStart(2, '0')}m`;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// ============================================================
// RENDER
// ============================================================
function render() {
  const root = document.getElementById('app');
  if (!state.ready) { root.innerHTML = `<div class="spinner"></div>`; return; }
  if (!state.user) { root.innerHTML = renderSignIn(); attachSigninHandlers(); return; }
  root.innerHTML = renderApp();
  attachAppHandlers();
}

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
  return `
    <nav class="bracket-tabs">
      ${state.brackets.map(b => `
        <button class="bracket-tab ${b.id === state.activeBracketId ? 'active' : ''}" data-bracket-tab="${b.id}" type="button">
          ${escapeHtml(b.name)}
          <span class="pill">${bracketStateLabel(b)}</span>
        </button>
      `).join('')}
    </nav>`;
}

function renderActiveBracket() {
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
  if (b.status === 'champion_picks') {
    return renderChampionPickScreen(b) + renderFooter();
  }
  return renderBracketView(b) + renderFooter();
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
    <div class="main-area">
      <div class="bracket-wrap">
        <div class="bracket-inner">
          ${rounds.map((r, idx) => renderRoundColumn(r, idx === 4)).join('')}
        </div>
      </div>
      ${renderStandings()}
    </div>`;
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
  const isPending = round.status === 'pending' || (!a && !b);
  const isOpen = round.status === 'open' && a && b;
  const isClosed = round.status === 'closed';
  const winnerId = matchup.winner_entry_id;
  const myPickWon = myVote && winnerId && myVote.voted_entry_id === winnerId;
  const isTie = matchup.is_tie && !winnerId;

  if (isPending) {
    return `
      <div class="matchup-wrap">
        <div class="matchup ${isFinal ? 'final' : 'upcoming'}">
          ${isFinal ? '<div class="ribbon">🏆 Champion</div>' : ''}
          <div class="slot">
            <div class="seed">${a ? entrySeed(a) : '—'}</div>
            <div class="name">${a ? escapeHtml(entryName(a)) : 'TBD'}</div>
            <div class="meta"></div>
          </div>
          <div class="slot">
            <div class="seed">${b ? entrySeed(b) : '—'}</div>
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
            <div class="name">${escapeHtml(entryName(a))}</div>
            <div class="meta"></div>
          </button>
          <button class="slot ${bPicked ? 'picked' : ''}" data-vote-matchup="${matchup.id}" data-vote-entry="${b}" type="button">
            <div class="seed">${entrySeed(b)}</div>
            <div class="name">${escapeHtml(entryName(b))}</div>
            <div class="meta"></div>
          </button>
        </div>
      </div>`;
  }

  const votesA = tally?.votes_a || 0;
  const votesB = tally?.votes_b || 0;
  const total = votesA + votesB;
  const pctA = total ? Math.round(100 * votesA / total) : 0;
  const pctB = total ? Math.round(100 * votesB / total) : 0;
  const aWin = winnerId === a;
  const bWin = winnerId === b;

  if (isTie) {
    return `
      <div class="matchup-wrap">
        <div class="matchup tie">
          <div class="ribbon">Tie — awaiting admin</div>
          <div class="slot">
            <div class="seed">${entrySeed(a)}</div>
            <div class="name">${escapeHtml(entryName(a))}</div>
            <div class="meta">${votesA} · ${pctA}%</div>
          </div>
          <div class="slot">
            <div class="seed">${entrySeed(b)}</div>
            <div class="name">${escapeHtml(entryName(b))}</div>
            <div class="meta">${votesB} · ${pctB}%</div>
          </div>
        </div>
      </div>`;
  }

  return `
    <div class="matchup-wrap">
      <div class="matchup closed ${myPickWon ? 'point-earned' : ''}">
        <div class="slot ${aWin ? 'winner' : 'loser'}">
          <div class="seed">${entrySeed(a)}</div>
          <div class="name">${escapeHtml(entryName(a))}</div>
          <div class="meta">${votesA} · ${pctA}%</div>
        </div>
        <div class="slot ${bWin ? 'winner' : 'loser'}">
          <div class="seed">${entrySeed(b)}</div>
          <div class="name">${escapeHtml(entryName(b))}</div>
          <div class="meta">${votesB} · ${pctB}%</div>
        </div>
      </div>
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
  document.querySelectorAll('.countdown[data-countdown-target]').forEach(el => {
    const target = el.dataset.countdownTarget;
    const cd = formatCountdown(target);
    const timeEl = el.querySelector('.time');
    if (timeEl) timeEl.textContent = cd || '—';
    if (cd && new Date(target) - new Date() < 60 * 60 * 1000) {
      el.classList.add('urgent');
    }
  });
}, 1000);

bootstrap();

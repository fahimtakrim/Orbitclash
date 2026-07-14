(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const PILOT_COLORS = ['#22d3ee', '#8b5cf6', '#fb7185', '#fbbf24', '#34d399', '#f97316'];
  const PILOT_HAIR = ['#0f172a', '#312e81', '#831843', '#78350f', '#064e3b', '#7c2d12'];
  const MAX_PLAYERS = 6;
  const LOW_POWER_DEVICE = window.matchMedia('(pointer: coarse)').matches || Number(navigator.deviceMemory || 4) <= 4;
  const SNAPSHOT_INTERVAL = LOW_POWER_DEVICE ? 125 : 100;
  const STATE_INTERVAL = LOW_POWER_DEVICE ? 85 : 65;
  const PVP_MAX_HEALTH = 600;
  const PVP_RESPAWN_MS = 2800;
  const PVP_KILL_TARGETS = [3, 5, 10];

  const mp = {
    active: false,
    isHost: false,
    intentionalClose: false,
    roomCode: '',
    playerId: '',
    roster: [],
    remotePlayers: new Map(),
    networkProjectiles: [],
    currentMap: 'Forest',
    latestSnapshot: null,
    lastSnapshotSent: 0,
    lastStateSent: 0,
    lastPingAt: 0,
    pingTimer: null,
    localDown: false,
    finalReceived: false,
    gameOverSent: false,
    applyingSnapshot: false,
    matchStartedAt: 0,
    matchType: 'COOP',
    killTarget: 5,
    playerKills: new Map(),
    pvpKills: new Map(),
    pvpDeaths: new Map(),
    pvpProjectiles: [],
    pvpProcessedHits: new Set(),
    trackedLocalBullets: new WeakSet(),
    pvpWinnerId: '',
    lastKillEvent: null,
    seenKillEventId: 0,
    shotSequence: 0,
    lastHudUpdate: 0,
    lastSquadHtml: '',
    trackedBots: new WeakSet(),
    sequence: 0,
  };

  let currentMapName = 'Forest';
  let soloMatchStartedAt = 0;
  let toastTimer = null;

  function safeStorageGet(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }

  function safeStorageSet(key, value) {
    try { localStorage.setItem(key, value); } catch (_) {}
  }

  function cleanName(value) {
    return String(value || '')
      .replace(/[^a-zA-Z0-9 _-]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 16) || `Pilot-${Math.floor(100 + Math.random() * 900)}`;
  }

  function getCallsign() {
    const input = $('playerNameInput');
    const name = cleanName(input?.value);
    if (input) input.value = name;
    safeStorageSet('orbitclash-callsign', name);
    return name;
  }

  function colorForPlayer(id, fallbackIndex = 0) {
    const rosterIndex = mp.roster.findIndex((entry) => entry.id === id);
    const index = rosterIndex >= 0 ? rosterIndex : fallbackIndex;
    return PILOT_COLORS[index % PILOT_COLORS.length];
  }

  function profileForPlayer(id, name, fallbackIndex = 0) {
    const rosterIndex = mp.roster.findIndex((entry) => entry.id === id);
    const index = rosterIndex >= 0 ? rosterIndex : fallbackIndex;
    return {
      name: cleanName(name),
      gender: index % 3 === 2 ? 'female' : 'male',
      color: PILOT_COLORS[index % PILOT_COLORS.length],
      hairColor: PILOT_HAIR[index % PILOT_HAIR.length],
    };
  }

  function showToast(message, timeout = 2600) {
    const toast = $('orbitToast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add('hidden'), timeout);
  }

  function setMultiplayerStatus(message, tone = '') {
    const status = $('multiStatus');
    if (!status) return;
    status.textContent = message;
    status.classList.remove('error', 'success');
    if (tone) status.classList.add(tone);
  }

  function setMode(mode) {
    const isSolo = mode === 'solo';
    $('modeSoloBtn')?.classList.toggle('active', isSolo);
    $('modeMultiBtn')?.classList.toggle('active', !isSolo);
    $('modeSoloBtn')?.setAttribute('aria-selected', String(isSolo));
    $('modeMultiBtn')?.setAttribute('aria-selected', String(!isSolo));
    $('soloPanel')?.classList.toggle('hidden', !isSolo);
    $('multiplayerPanel')?.classList.toggle('hidden', isSolo);
  }

  function send(payload) {
    return Boolean(window.OrbitP2P?.send(payload));
  }

  function getTransport() {
    if (window.OrbitP2P) return Promise.resolve(window.OrbitP2P);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('The multiplayer transport did not load.')), 8000);
      window.addEventListener('orbit-transport-ready', () => {
        clearTimeout(timeout);
        resolve(window.OrbitP2P);
      }, { once: true });
    });
  }

  function startLatencyMonitor() {
    clearInterval(mp.pingTimer);
    mp.pingTimer = setInterval(() => {
      if (mp.active) {
        mp.lastPingAt = performance.now();
        send({ type: 'ping', sentAt: Date.now() });
      }
    }, 5000);
  }

  function createRoom() {
    if (typeof enterLandscapeMode === 'function') enterLandscapeMode();
    const button = $('createRoomBtn');
    if (button) button.disabled = true;
    setMultiplayerStatus('Opening a secure room…');
    getTransport()
      .then((transport) => transport.create({ name: getCallsign(), onMessage: handleServerMessage }))
      .catch((error) => setMultiplayerStatus(error.message, 'error'))
      .finally(() => { if (button) button.disabled = false; });
  }

  function joinRoom() {
    const codeInput = $('joinRoomCode');
    const code = String(codeInput?.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (codeInput) codeInput.value = code;
    if (code.length !== 6) {
      setMultiplayerStatus('Enter the complete six-character room code.', 'error');
      return;
    }
    if (typeof enterLandscapeMode === 'function') enterLandscapeMode();
    const button = $('joinRoomBtn');
    if (button) button.disabled = true;
    setMultiplayerStatus('Locating squad room…');
    getTransport()
      .then((transport) => transport.join({ code, name: getCallsign(), onMessage: handleServerMessage }))
      .catch((error) => setMultiplayerStatus(error.message, 'error'))
      .finally(() => { if (button) button.disabled = false; });
  }

  function handleServerMessage(message) {
    switch (message.type) {
      case 'room_ready':
        mp.active = true;
        mp.isHost = Boolean(message.isHost);
        mp.roomCode = message.roomCode;
        mp.playerId = message.playerId;
        mp.roster = Array.isArray(message.roster) ? message.roster.slice(0, MAX_PLAYERS) : [];
        mp.playerKills = new Map(mp.roster.map((entry) => [entry.id, 0]));
        startLatencyMonitor();
        showLobby();
        updateRoster(message.roster);
        break;
      case 'roster':
        updateRoster(message.roster);
        break;
      case 'game_started':
      case 'restart_game':
        beginNetworkGame(message.config || {});
        break;
      case 'guest_state':
        if (mp.isHost) applyGuestState(message.playerId, message.state);
        break;
      case 'guest_damage':
        if (mp.isHost) applyGuestDamage(message.playerId, message.botId, message.damage);
        break;
      case 'guest_pvp_hit':
        if (mp.isHost) applyPvpHit(message.playerId, message.targetId, message.damage, message.bulletId);
        break;
      case 'pvp_shot':
        receivePvpShot(message.playerId, message.shot);
        break;
      case 'host_snapshot':
        if (!mp.isHost) applyHostSnapshot(message.snapshot);
        break;
      case 'host_game_over':
        if (!mp.isHost) finishGuestMatch(message.summary || {});
        break;
      case 'room_closed':
        showToast(message.message || 'The squad leader closed the room.', 3800);
        resetMultiplayerState(false);
        returnToMenu(false);
        break;
      case 'error':
        setMultiplayerStatus(message.message || 'Unable to join that room.', 'error');
        if ($('lobbyMenu') && !$('lobbyMenu').classList.contains('hidden')) {
          const lobbyStatus = $('lobbyStatus');
          if (lobbyStatus) lobbyStatus.textContent = message.message || 'Room error.';
        }
        break;
      case 'pong': {
        const latency = Math.max(1, Math.round(Number(message.latency) || performance.now() - mp.lastPingAt));
        if ($('latencyDisplay')) $('latencyDisplay').textContent = `${latency} MS`;
        break;
      }
    }
  }

  function showLobby() {
    $('startMenu')?.classList.add('hidden');
    $('gameOverMenu')?.classList.add('hidden');
    $('lobbyMenu')?.classList.remove('hidden');
    if ($('roomCodeDisplay')) $('roomCodeDisplay').textContent = mp.roomCode;
    $('hostOptions')?.classList.toggle('hidden', !mp.isHost);
    $('guestWaiting')?.classList.toggle('hidden', mp.isHost);
    syncLobbyMatchFields();
    if ($('lobbyStatus')) {
      $('lobbyStatus').textContent = mp.isHost
        ? 'Share the room code, configure the mission, then launch.'
        : 'Connected. Waiting for the squad leader to deploy.';
    }
  }

  function updateRoster(nextRoster) {
    if (Array.isArray(nextRoster)) mp.roster = nextRoster.slice(0, MAX_PLAYERS);
    const liveIds = new Set(mp.roster.map((entry) => entry.id));
    for (const id of mp.remotePlayers.keys()) {
      if (!liveIds.has(id)) mp.remotePlayers.delete(id);
    }
    for (const member of mp.roster) {
      if (!mp.playerKills.has(member.id)) mp.playerKills.set(member.id, 0);
      if (!mp.pvpKills.has(member.id)) mp.pvpKills.set(member.id, 0);
      if (!mp.pvpDeaths.has(member.id)) mp.pvpDeaths.set(member.id, 0);
    }

    const list = $('lobbyPlayerList');
    if (list) {
      const slots = [];
      for (let index = 0; index < MAX_PLAYERS; index++) {
        const member = mp.roster[index];
        if (member) {
          const color = PILOT_COLORS[index % PILOT_COLORS.length];
          slots.push(`<div class="pilot-slot"><span class="pilot-avatar" style="background:${color}">${escapeHtml(member.name.slice(0, 1).toUpperCase())}</span><span class="pilot-meta"><strong>${escapeHtml(member.name)}</strong><small>${member.isHost ? 'ROOM HOST' : (mp.matchType === 'PVP' ? 'RIVAL PILOT' : 'STRIKE PILOT')}</small></span>${member.isHost ? '<span class="host-crown">◆</span>' : ''}</div>`);
        } else {
          slots.push('<div class="pilot-slot empty"><span class="pilot-avatar">＋</span><span class="pilot-meta"><strong>OPEN SLOT</strong><small>AWAITING PILOT</small></span></div>');
        }
      }
      list.innerHTML = slots.join('');
    }
    if ($('lobbyCount')) $('lobbyCount').textContent = `${mp.roster.length} / ${MAX_PLAYERS}`;
    updateSquadHud();
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  }

  function syncLobbyMatchFields() {
    const matchType = $('lobbyMatchType')?.value === 'PVP' ? 'PVP' : 'COOP';
    $('lobbyDifficultyWrap')?.classList.toggle('hidden', matchType === 'PVP');
    $('lobbyKillTargetWrap')?.classList.toggle('hidden', matchType !== 'PVP');
    const launchCopy = $('lobbyStartBtn')?.querySelector('small');
    if (launchCopy) launchCopy.textContent = matchType === 'PVP'
      ? 'First pilot to the KO target wins'
      : 'All connected pilots deploy together';
  }

  function startRoomMatch() {
    if (!mp.isHost) return;
    if (typeof enterLandscapeMode === 'function') enterLandscapeMode();
    const matchType = $('lobbyMatchType')?.value === 'PVP' ? 'PVP' : 'COOP';
    const requestedKillTarget = Number($('lobbyKillTarget')?.value) || 5;
    const config = {
      map: $('lobbyMapSelect')?.value || 'Forest',
      difficulty: $('lobbyDifficultySelect')?.value || 'NORMAL',
      matchType,
      killTarget: PVP_KILL_TARGETS.includes(requestedKillTarget) ? requestedKillTarget : 5,
    };
    const button = $('lobbyStartBtn');
    if (button) button.disabled = true;
    if ($('lobbyStatus')) $('lobbyStatus').textContent = 'Synchronizing battlefield…';
    send({ type: 'start_game', config });
    setTimeout(() => { if (button) button.disabled = false; }, 1500);
  }

  function beginNetworkGame(config) {
    const map = ['Forest', 'Garage', 'Cyber City'].includes(config.map) ? config.map : 'Forest';
    const level = ['EASY', 'NORMAL', 'HARD'].includes(config.difficulty) ? config.difficulty : 'NORMAL';
    const requestedKillTarget = Number(config.killTarget) || 5;
    mp.currentMap = map;
    mp.matchType = config.matchType === 'PVP' ? 'PVP' : 'COOP';
    mp.killTarget = PVP_KILL_TARGETS.includes(requestedKillTarget) ? requestedKillTarget : 5;
    mp.matchStartedAt = Date.now();
    mp.lastSnapshotSent = 0;
    mp.lastStateSent = 0;
    mp.localDown = false;
    mp.finalReceived = false;
    mp.gameOverSent = false;
    mp.latestSnapshot = null;
    mp.networkProjectiles = [];
    mp.pvpProjectiles = [];
    mp.remotePlayers.clear();
    mp.trackedBots = new WeakSet();
    mp.trackedLocalBullets = new WeakSet();
    mp.pvpProcessedHits.clear();
    mp.pvpWinnerId = '';
    mp.lastKillEvent = null;
    mp.seenKillEventId = 0;
    mp.shotSequence = 0;
    mp.playerKills = new Map(mp.roster.map((entry) => [entry.id, 0]));
    mp.pvpKills = new Map(mp.roster.map((entry) => [entry.id, 0]));
    mp.pvpDeaths = new Map(mp.roster.map((entry) => [entry.id, 0]));
    setDifficulty(level);
    $('lobbyMenu')?.classList.add('hidden');
    initGame(map);
    if (mp.matchType === 'PVP') {
      bots = [];
      drops = [];
      powerUps = [];
      bullets = [];
      configurePvpFighter(player, Math.max(0, mp.roster.findIndex((entry) => entry.id === mp.playerId)));
      if (mp.isHost) ensureHostProxies();
      document.body.classList.add('pvp-active');
    } else if (!mp.isHost) {
      bots = [];
      drops = [];
      powerUps = [];
      bullets = [];
    } else {
      ensureHostProxies();
    }
    updateSessionUI();
    if (mp.matchType === 'PVP') {
      showToast(`PvP Clash deployed · first to ${mp.killTarget} KOs wins.`);
    } else {
      showToast(mp.isHost ? 'Squad deployed. You are the simulation host.' : 'Squad deployed. Sync locked.');
    }
  }

  function ensureHostProxies() {
    for (const [index, member] of mp.roster.entries()) {
      if (member.id === mp.playerId) continue;
      ensureRemotePlayer(member.id, member.name, index, {
        x: pvpSpawnPoint(index).x,
        y: pvpSpawnPoint(index).y,
        health: mp.matchType === 'PVP' ? PVP_MAX_HEALTH : 2000,
        maxHealth: mp.matchType === 'PVP' ? PVP_MAX_HEALTH : 2000,
      });
      if (mp.matchType === 'PVP') configurePvpFighter(mp.remotePlayers.get(member.id), index);
    }
  }

  function pvpSpawnPoint(index) {
    const positions = [
      [0.18, 0.20], [0.82, 0.20], [0.32, 0.16],
      [0.68, 0.16], [0.42, 0.28], [0.58, 0.28],
    ];
    const [xRatio, yRatio] = positions[index % positions.length];
    return { x: Math.round(world.width * xRatio), y: Math.round(Math.max(90, world.height * yRatio)) };
  }

  function configurePvpFighter(fighter, index = 0) {
    if (!fighter) return;
    const spawn = pvpSpawnPoint(index);
    fighter.maxHealth = PVP_MAX_HEALTH;
    fighter.health = PVP_MAX_HEALTH;
    fighter.x = spawn.x;
    fighter.y = spawn.y;
    fighter.vx = 0;
    fighter.vy = 0;
    fighter.respawnAt = 0;
    fighter.inventory = [WEAPONS.PISTOL];
    fighter.weaponIndex = 0;
    fighter.weapon = WEAPONS.PISTOL;
    fighter.activeBuffs = { BOOST: 0, FIRE_RATE: 0, DAMAGE: 0, SHIELD: 0, DOUBLE: 0 };
  }

  function ensureRemotePlayer(id, name, index = 0, state = {}) {
    let remote = mp.remotePlayers.get(id);
    if (!remote) {
      remote = new Player(Number(state.x) || world.width / 2, Number(state.y) || 200);
      const profile = profileForPlayer(id, name, index);
      remote.name = profile.name;
      remote.color = profile.color;
      remote.gender = profile.gender;
      remote.hairColor = profile.hairColor;
      remote.networkId = id;
      remote.isNetworkProxy = true;
      remote.maxHealth = Number(state.maxHealth) || 2000;
      remote.health = Number.isFinite(state.health) ? state.health : remote.maxHealth;
      mp.remotePlayers.set(id, remote);
    }
    return remote;
  }

  function applyGuestState(playerId, state) {
    if (!state || typeof state !== 'object') return;
    const memberIndex = mp.roster.findIndex((entry) => entry.id === playerId);
    const member = mp.roster[memberIndex];
    if (!member) return;
    const remote = ensureRemotePlayer(playerId, member.name, memberIndex, state);
    remote.x = clampNumber(state.x, 0, world.width - remote.width, remote.x);
    remote.y = clampNumber(state.y, -300, world.height + 300, remote.y);
    remote.vx = clampNumber(state.vx, -40, 40, 0);
    remote.vy = clampNumber(state.vy, -40, 40, 0);
    remote.armAngle = clampNumber(state.armAngle, -Math.PI * 2, Math.PI * 2, 0);
    remote.onGround = Boolean(state.onGround);
    remote.shootCooldown = clampNumber(state.shootCooldown, 0, 180, 0);
    if (typeof state.weapon === 'string' && WEAPONS[state.weapon]) remote.weapon = WEAPONS[state.weapon];
  }

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }

  function applyGuestDamage(playerId, botId, amount) {
    const damage = clampNumber(amount, 0, 650, 0);
    if (!damage || typeof botId !== 'string') return;
    const bot = bots.find((entry) => entry.networkId === botId);
    if (!bot || bot.health <= 0) return;
    bot.lastDamagedBy = playerId;
    bot.health -= damage;
  }

  function fighterForId(id) {
    if (id === mp.playerId) return player;
    return mp.remotePlayers.get(id);
  }

  function trimProcessedPvpHits() {
    if (mp.pvpProcessedHits.size <= 900) return;
    const iterator = mp.pvpProcessedHits.values();
    for (let index = 0; index < 300; index++) {
      const next = iterator.next();
      if (next.done) break;
      mp.pvpProcessedHits.delete(next.value);
    }
  }

  function applyPvpHit(attackerId, targetId, amount, bulletId) {
    if (!mp.isHost || mp.matchType !== 'PVP' || attackerId === targetId) return;
    if (!mp.roster.some((member) => member.id === attackerId) || !mp.roster.some((member) => member.id === targetId)) return;
    const safeBulletId = String(bulletId || '').slice(0, 80);
    if (!safeBulletId) return;
    const hitKey = `${attackerId}:${targetId}:${safeBulletId}`;
    if (mp.pvpProcessedHits.has(hitKey)) return;
    mp.pvpProcessedHits.add(hitKey);
    trimProcessedPvpHits();

    const target = fighterForId(targetId);
    const damage = clampNumber(amount, 1, 90, 0);
    if (!target || !damage || target.health <= 0 || target.respawnAt > Date.now()) return;
    target.health = Math.max(0, target.health - damage);
    target.hitFlash = 5;
    target.lastDamagedBy = attackerId;
    if (target.health > 0) return;

    target.respawnAt = Date.now() + PVP_RESPAWN_MS;
    target.vx = 0;
    target.vy = 0;
    mp.pvpKills.set(attackerId, (mp.pvpKills.get(attackerId) || 0) + 1);
    mp.pvpDeaths.set(targetId, (mp.pvpDeaths.get(targetId) || 0) + 1);
    const attacker = mp.roster.find((member) => member.id === attackerId);
    const victim = mp.roster.find((member) => member.id === targetId);
    mp.lastKillEvent = {
      id: Date.now(),
      attackerId,
      targetId,
      attackerName: attacker?.name || 'Pilot',
      targetName: victim?.name || 'Pilot',
    };
    mp.seenKillEventId = mp.lastKillEvent.id;
    showToast(`${mp.lastKillEvent.attackerName} knocked out ${mp.lastKillEvent.targetName}.`, 2100);
  }

  function serializePvpShot(bullet) {
    return {
      id: bullet.networkBulletId,
      x: bullet.x,
      y: bullet.y,
      vx: bullet.vx,
      vy: bullet.vy,
      angle: bullet.angle,
      color: bullet.color,
      width: Math.min(30, Number(bullet.width) || 12),
      height: Math.min(12, Number(bullet.height) || 4),
      life: Math.min(110, Number(bullet.life) || 90),
    };
  }

  function processLocalPvpBullets() {
    if (mp.matchType !== 'PVP' || !player || player.health <= 0) return;
    for (let index = bullets.length - 1; index >= 0; index--) {
      const bullet = bullets[index];
      if (!bullet?.isPlayer) continue;
      if (!mp.trackedLocalBullets.has(bullet)) {
        mp.trackedLocalBullets.add(bullet);
        bullet.networkBulletId = `${mp.playerId}-${++mp.shotSequence}`;
        bullet.hitNetworkPlayers = new Set();
        send({ type: 'pvp_shot', shot: serializePvpShot(bullet) });
      }
      for (const [targetId, remote] of mp.remotePlayers) {
        if (remote.health <= 0 || bullet.hitNetworkPlayers.has(targetId)) continue;
        if (bullet.x <= remote.x || bullet.x >= remote.x + remote.width || bullet.y <= remote.y || bullet.y >= remote.y + remote.height) continue;
        bullet.hitNetworkPlayers.add(targetId);
        triggerHitMarker();
        if (mp.isHost) applyPvpHit(mp.playerId, targetId, bullet.damage, bullet.networkBulletId);
        else send({ type: 'pvp_hit', targetId, damage: bullet.damage, bulletId: bullet.networkBulletId });
        if (!bullet.piercing) {
          bullets.splice(index, 1);
          break;
        }
      }
    }
  }

  function receivePvpShot(playerId, shot) {
    if (mp.matchType !== 'PVP' || playerId === mp.playerId || !shot || typeof shot !== 'object') return;
    const id = String(shot.id || '').slice(0, 80);
    if (!id || mp.pvpProjectiles.some((projectile) => projectile.id === id)) return;
    mp.pvpProjectiles.push({
      id,
      ownerId: playerId,
      x: clampNumber(shot.x, -100, world.width + 100, 0),
      y: clampNumber(shot.y, -100, world.height + 100, 0),
      vx: clampNumber(shot.vx, -80, 80, 0),
      vy: clampNumber(shot.vy, -80, 80, 0),
      angle: clampNumber(shot.angle, -Math.PI * 2, Math.PI * 2, 0),
      color: typeof shot.color === 'string' ? shot.color.slice(0, 24) : '#fef08a',
      width: clampNumber(shot.width, 3, 30, 12),
      height: clampNumber(shot.height, 2, 12, 4),
      life: clampNumber(shot.life, 1, 110, 90),
    });
    if (mp.pvpProjectiles.length > 120) mp.pvpProjectiles.splice(0, mp.pvpProjectiles.length - 120);
  }

  function advancePvpProjectiles() {
    for (let index = mp.pvpProjectiles.length - 1; index >= 0; index--) {
      const projectile = mp.pvpProjectiles[index];
      projectile.x += projectile.vx;
      projectile.y += projectile.vy;
      projectile.life--;
      if (projectile.life <= 0 || projectile.x < -150 || projectile.x > world.width + 150 || projectile.y < -150 || projectile.y > world.height + 150) {
        mp.pvpProjectiles.splice(index, 1);
      }
    }
  }

  function drawPvpProjectiles(context) {
    for (const projectile of mp.pvpProjectiles) {
      context.save();
      context.translate(projectile.x, projectile.y);
      context.rotate(projectile.angle);
      context.fillStyle = projectile.color;
      if (!LOW_POWER_DEVICE) {
        context.shadowBlur = 10;
        context.shadowColor = projectile.color;
      }
      context.fillRect(-projectile.width / 2, -projectile.height / 2, projectile.width, projectile.height);
      context.restore();
    }
  }

  function processPvpRespawns() {
    if (!mp.isHost || mp.matchType !== 'PVP' || mp.pvpWinnerId) return;
    const now = Date.now();
    for (const [index, member] of mp.roster.entries()) {
      const fighter = fighterForId(member.id);
      if (!fighter || fighter.health > 0 || !fighter.respawnAt || fighter.respawnAt > now) continue;
      configurePvpFighter(fighter, index);
    }
  }

  function updatePvpRespawnOverlay() {
    const overlay = $('pvpRespawnOverlay');
    if (!overlay) return;
    const down = mp.active && mp.matchType === 'PVP' && gameState === 'PLAYING' && player && player.health <= 0;
    overlay.classList.toggle('hidden', !down);
    mp.localDown = Boolean(down);
    if (!down) return;
    const remaining = Math.max(1, Math.ceil(((Number(player.respawnAt) || Date.now() + 1000) - Date.now()) / 1000));
    if ($('pvpRespawnCountdown')) $('pvpRespawnCountdown').textContent = String(remaining);
  }

  function getPvpWinnerId() {
    for (const [id, kills] of mp.pvpKills) {
      if (kills >= mp.killTarget) return id;
    }
    return '';
  }

  function installBotTracking(bot) {
    if (!bot || mp.trackedBots.has(bot)) return;
    mp.trackedBots.add(bot);
    if (!bot.networkId) bot.networkId = `b-${crypto.randomUUID().slice(0, 8)}`;
    let trackedHealth = bot.health;
    Object.defineProperty(bot, 'health', {
      configurable: true,
      enumerable: true,
      get() { return trackedHealth; },
      set(nextValue) {
        const value = Number(nextValue);
        if (!Number.isFinite(value)) return;
        const previous = trackedHealth;
        trackedHealth = value;
        if (!mp.active || mp.applyingSnapshot || value >= previous) return;
        if (!mp.isHost) {
          const damage = Math.min(650, previous - value);
          if (damage > 0) send({ type: 'guest_damage', botId: bot.networkId, damage });
        } else if (previous > 0 && value <= 0) {
          const killerId = bot.lastDamagedBy || mp.playerId;
          mp.playerKills.set(killerId, (mp.playerKills.get(killerId) || 0) + 1);
        }
      },
    });
  }

  function serializePlayer(id, member, fighter) {
    const inventory = Array.isArray(fighter.inventory) ? fighter.inventory.map((weapon) => weapon.name).filter((name) => WEAPONS[name]).slice(0, 3) : ['PISTOL'];
    return {
      id,
      name: member?.name || fighter.name,
      x: fighter.x,
      y: fighter.y,
      vx: fighter.vx,
      vy: fighter.vy,
      armAngle: fighter.armAngle,
      onGround: fighter.onGround,
      health: Math.max(0, fighter.health),
      maxHealth: fighter.maxHealth,
      weapon: fighter.weapon?.name || 'PISTOL',
      weaponIndex: fighter.weaponIndex || 0,
      inventory,
      shootCooldown: fighter.shootCooldown || 0,
      activeBuffs: { ...(fighter.activeBuffs || {}) },
      respawnAt: Number(fighter.respawnAt) || 0,
    };
  }

  function serializeBot(bot) {
    installBotTracking(bot);
    return {
      id: bot.networkId,
      x: bot.x,
      y: bot.y,
      vx: bot.vx,
      vy: bot.vy,
      armAngle: bot.armAngle,
      onGround: bot.onGround,
      health: Math.max(0, bot.health),
      maxHealth: bot.maxHealth,
      name: bot.name,
      color: bot.color,
      gender: bot.gender,
      hairColor: bot.hairColor,
      weapon: bot.weapon?.name || 'PISTOL',
      hitFlash: bot.hitFlash || 0,
      poisonDots: bot.poisonDots || 0,
    };
  }

  function buildHostSnapshot() {
    const players = [];
    for (const [index, member] of mp.roster.entries()) {
      const fighter = member.id === mp.playerId ? player : mp.remotePlayers.get(member.id);
      if (fighter) players.push(serializePlayer(member.id, member, fighter));
    }
    const projectiles = bullets
      .filter((bullet) => !bullet.isPlayer)
      .slice(-(LOW_POWER_DEVICE ? 55 : 90))
      .map((bullet) => ({
        x: bullet.x, y: bullet.y, angle: bullet.angle, color: bullet.color,
        width: bullet.width, height: bullet.height, explosive: bullet.explosive,
        isSawblade: bullet.isSawblade, isPoison: bullet.isPoison,
      }));
    return {
      sequence: ++mp.sequence,
      sentAt: Date.now(),
      map: mp.currentMap,
      difficulty,
      score,
      wave,
      matchType: mp.matchType,
      killTarget: mp.killTarget,
      pvpKills: Object.fromEntries(mp.pvpKills),
      pvpDeaths: Object.fromEntries(mp.pvpDeaths),
      lastKillEvent: mp.lastKillEvent,
      players,
      bots: mp.matchType === 'PVP' ? [] : bots.map(serializeBot),
      projectiles,
    };
  }

  function applyHostSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.players) || !Array.isArray(snapshot.bots)) return;
    mp.latestSnapshot = snapshot;
    mp.applyingSnapshot = true;
    try {
      mp.matchType = snapshot.matchType === 'PVP' ? 'PVP' : mp.matchType;
      const snapshotKillTarget = Number(snapshot.killTarget);
      if (PVP_KILL_TARGETS.includes(snapshotKillTarget)) mp.killTarget = snapshotKillTarget;
      if (snapshot.pvpKills && typeof snapshot.pvpKills === 'object') mp.pvpKills = new Map(Object.entries(snapshot.pvpKills).map(([id, value]) => [id, Number(value) || 0]));
      if (snapshot.pvpDeaths && typeof snapshot.pvpDeaths === 'object') mp.pvpDeaths = new Map(Object.entries(snapshot.pvpDeaths).map(([id, value]) => [id, Number(value) || 0]));
      score = Number(snapshot.score) || 0;
      wave = Math.max(1, Number(snapshot.wave) || 1);
      if ($('scoreDisplay')) $('scoreDisplay').textContent = String(score);
      if ($('waveDisplay')) $('waveDisplay').textContent = `WAVE ${wave}`;

      const livePlayerIds = new Set();
      for (const [index, state] of snapshot.players.entries()) {
        livePlayerIds.add(state.id);
        if (state.id === mp.playerId) {
          const wasDown = player.health <= 0;
          player.health = Math.max(0, Number(state.health) || 0);
          player.maxHealth = Number(state.maxHealth) || 2000;
          player.respawnAt = Number(state.respawnAt) || 0;
          if (wasDown && player.health > 0 && mp.matchType === 'PVP') {
            player.x = Number(state.x) || player.x;
            player.y = Number(state.y) || player.y;
            player.vx = Number(state.vx) || 0;
            player.vy = Number(state.vy) || 0;
          }
          player.activeBuffs = { ...player.activeBuffs, ...(state.activeBuffs || {}) };
          const inventory = Array.isArray(state.inventory) ? state.inventory.map((name) => WEAPONS[name]).filter(Boolean).slice(0, 3) : [];
          if (inventory.length) player.inventory = inventory;
          player.weaponIndex = Math.min(player.inventory.length - 1, Math.max(0, Number(state.weaponIndex) || 0));
          player.weapon = WEAPONS[state.weapon] || player.inventory[player.weaponIndex] || WEAPONS.PISTOL;
          mp.localDown = player.health <= 0;
          const healthBar = $('healthBar');
          if (healthBar) healthBar.style.width = `${Math.max(0, player.health / player.maxHealth * 100)}%`;
        } else {
          const member = mp.roster.find((entry) => entry.id === state.id);
          const remote = ensureRemotePlayer(state.id, state.name || member?.name || 'Pilot', index, state);
          Object.assign(remote, {
            x: Number(state.x) || 0,
            y: Number(state.y) || 0,
            vx: Number(state.vx) || 0,
            vy: Number(state.vy) || 0,
            armAngle: Number(state.armAngle) || 0,
            onGround: Boolean(state.onGround),
            health: Math.max(0, Number(state.health) || 0),
            maxHealth: Number(state.maxHealth) || 2000,
            shootCooldown: Number(state.shootCooldown) || 0,
            respawnAt: Number(state.respawnAt) || 0,
          });
          remote.weapon = WEAPONS[state.weapon] || WEAPONS.PISTOL;
        }
      }
      for (const id of mp.remotePlayers.keys()) {
        if (!livePlayerIds.has(id)) mp.remotePlayers.delete(id);
      }

      const existingBots = new Map(bots.filter((bot) => bot.networkId).map((bot) => [bot.networkId, bot]));
      const nextBots = [];
      for (const state of snapshot.bots.slice(0, 32)) {
        let bot = existingBots.get(state.id);
        if (!bot) {
          bot = new Bot(Number(state.x) || 0, Number(state.y) || 0, {
            name: state.name || 'Hostile',
            color: state.color || '#fb7185',
            gender: state.gender || 'male',
            hairColor: state.hairColor || '#0f172a',
          });
          bot.networkId = state.id;
          installBotTracking(bot);
        }
        Object.assign(bot, {
          x: Number(state.x) || 0, y: Number(state.y) || 0,
          vx: Number(state.vx) || 0, vy: Number(state.vy) || 0,
          armAngle: Number(state.armAngle) || 0, onGround: Boolean(state.onGround),
          maxHealth: Number(state.maxHealth) || 100, health: Number(state.health) || 0,
          hitFlash: Number(state.hitFlash) || 0, poisonDots: Number(state.poisonDots) || 0,
        });
        bot.weapon = WEAPONS[state.weapon] || WEAPONS.PISTOL;
        nextBots.push(bot);
      }
      bots = nextBots;
      mp.networkProjectiles = Array.isArray(snapshot.projectiles) ? snapshot.projectiles.slice(0, LOW_POWER_DEVICE ? 55 : 90) : [];
      if (snapshot.lastKillEvent && Number(snapshot.lastKillEvent.id) > mp.seenKillEventId) {
        mp.seenKillEventId = Number(snapshot.lastKillEvent.id);
        showToast(`${snapshot.lastKillEvent.attackerName} knocked out ${snapshot.lastKillEvent.targetName}.`, 2100);
      }
    } finally {
      mp.applyingSnapshot = false;
    }
    updatePvpRespawnOverlay();
    updateSquadHud(true);
  }

  function sendGuestState(timestamp) {
    if (timestamp - mp.lastStateSent < STATE_INTERVAL || !player) return;
    mp.lastStateSent = timestamp;
    send({
      type: 'guest_state',
      state: {
        x: player.x, y: player.y, vx: player.vx, vy: player.vy,
        armAngle: player.armAngle, onGround: player.onGround,
        weapon: player.weapon?.name || 'PISTOL', shootCooldown: player.shootCooldown || 0,
      },
    });
  }

  function activeHostPlayers() {
    if (!mp.active || !mp.isHost) return player ? [player] : [];
    return [player, ...mp.remotePlayers.values()].filter(Boolean);
  }

  function processRemoteHazards() {
    if (!mp.isHost || mp.remotePlayers.size === 0) return;
    for (let bulletIndex = bullets.length - 1; bulletIndex >= 0; bulletIndex--) {
      const bullet = bullets[bulletIndex];
      if (bullet.isPlayer) continue;
      if (!bullet.hitNetworkPlayers) bullet.hitNetworkPlayers = new Set();
      for (const remote of mp.remotePlayers.values()) {
        if (remote.health <= 0 || bullet.hitNetworkPlayers.has(remote.networkId)) continue;
        if (bullet.x > remote.x && bullet.x < remote.x + remote.width && bullet.y > remote.y && bullet.y < remote.y + remote.height) {
          bullet.hitNetworkPlayers.add(remote.networkId);
          if (remote.activeBuffs?.SHIELD > 0) {
            addFloatingText('BLOCKED', remote.x + remote.width / 2, remote.y - 25, '#fbbf24', 15);
          } else {
            remote.health -= bullet.damage * (bullet.explosive ? 1.5 : 1);
            remote.hitFlash = 5;
          }
          if (!bullet.piercing) bullets.splice(bulletIndex, 1);
          break;
        }
      }
    }

    for (let index = drops.length - 1; index >= 0; index--) {
      const drop = drops[index];
      const receiver = [...mp.remotePlayers.values()].find((remote) => remote.health > 0 && checkCollision(remote, drop));
      if (!receiver) continue;
      if (receiver.inventory.length < 3 && !receiver.inventory.some((weapon) => weapon.name === drop.weapon.name)) receiver.inventory.push(drop.weapon);
      else receiver.inventory[receiver.weaponIndex] = drop.weapon;
      receiver.weaponIndex = Math.min(receiver.inventory.length - 1, receiver.weaponIndex);
      receiver.weapon = receiver.inventory[receiver.weaponIndex];
      drops.splice(index, 1);
    }

    for (let index = powerUps.length - 1; index >= 0; index--) {
      const pickup = powerUps[index];
      const receiver = [...mp.remotePlayers.values()].find((remote) => remote.health > 0 && checkCollision(remote, pickup));
      if (!receiver) continue;
      const type = pickup.typeObj.type;
      if (type === 'HEAL') receiver.health = Math.min(receiver.maxHealth, receiver.health + 800);
      else if (type === 'ATOMIC') triggerAtomicBlast();
      else if (receiver.activeBuffs && type in receiver.activeBuffs) receiver.activeBuffs[type] = 800;
      powerUps.splice(index, 1);
    }
  }

  function drawRemotePlayers(context, timestamp) {
    if (!mp.active) return;
    if (mp.matchType === 'PVP') drawPvpProjectiles(context);
    for (const remote of mp.remotePlayers.values()) {
      context.save();
      if (remote.health <= 0) context.globalAlpha = 0.34;
      remote.drawCharacter(context, true, timestamp);
      context.globalAlpha = 1;
      const ratio = Math.max(0, remote.health / remote.maxHealth);
      context.fillStyle = 'rgba(2,6,23,.8)';
      context.fillRect(remote.x - 4, remote.y - 15, remote.width + 8, 4);
      context.fillStyle = ratio > .35 ? '#22d3ee' : '#fb7185';
      context.fillRect(remote.x - 4, remote.y - 15, (remote.width + 8) * ratio, 4);
      context.restore();
    }
    if (!mp.isHost && mp.matchType !== 'PVP') {
      for (const projectile of mp.networkProjectiles) drawNetworkProjectile(context, projectile);
    }
  }

  function drawNetworkProjectile(context, projectile) {
    context.save();
    context.translate(Number(projectile.x) || 0, Number(projectile.y) || 0);
    context.rotate(Number(projectile.angle) || 0);
    context.fillStyle = projectile.color || '#fb7185';
    context.shadowBlur = 12;
    context.shadowColor = context.fillStyle;
    if (projectile.isSawblade) {
      context.beginPath();
      context.arc(0, 0, 14, 0, Math.PI * 2);
      context.fill();
    } else if (projectile.isPoison) {
      context.beginPath();
      context.arc(0, 0, 7, 0, Math.PI * 2);
      context.fill();
    } else {
      context.fillRect(-8, -2, Math.max(10, Number(projectile.width) || 12), Math.max(3, Number(projectile.height) || 4));
    }
    context.restore();
  }

  function onFrame(timestamp) {
    if (!mp.active || gameState !== 'PLAYING') return;
    if (mp.matchType === 'PVP') {
      advancePvpProjectiles();
      processLocalPvpBullets();
      updatePvpRespawnOverlay();
    } else {
      for (const bot of bots) installBotTracking(bot);
    }
    if (mp.isHost) {
      if (mp.matchType !== 'PVP') processRemoteHazards();
      if (timestamp - mp.lastSnapshotSent >= SNAPSHOT_INTERVAL) {
        mp.lastSnapshotSent = timestamp;
        send({ type: 'host_snapshot', snapshot: buildHostSnapshot() });
      }
    } else {
      drops = [];
      powerUps = [];
      sendGuestState(timestamp);
    }
    updateSquadHud(false, timestamp);
  }

  function handleEndCondition() {
    if (!mp.active || gameState !== 'PLAYING') return false;
    if (mp.isHost) {
      if (mp.matchType === 'PVP') {
        processPvpRespawns();
        mp.pvpWinnerId = getPvpWinnerId();
        if (mp.pvpWinnerId) {
          gameOver();
        } else {
          requestAnimationFrame(gameLoop);
        }
        return true;
      }
      const fighters = activeHostPlayers();
      if (fighters.length > 0 && fighters.every((fighter) => fighter.health <= 0)) {
        gameOver();
      } else {
        requestAnimationFrame(gameLoop);
      }
    } else {
      requestAnimationFrame(gameLoop);
    }
    return true;
  }

  function updateSessionUI() {
    const badge = $('sessionBadge');
    if (badge) badge.textContent = mp.active ? `${mp.matchType === 'PVP' ? 'PVP' : 'ROOM'} ${mp.roomCode}` : 'SOLO';
    $('squadHud')?.classList.toggle('hidden', !mp.active);
    if (mp.active && mp.matchType === 'PVP') {
      if ($('difficultyDisplay')) $('difficultyDisplay').textContent = `FIRST TO ${mp.killTarget}`;
      if ($('waveDisplay')) $('waveDisplay').textContent = 'PVP CLASH';
    }
    updateSquadHud(true);
  }

  function updateSquadHud(force = false, timestamp = performance.now()) {
    const display = $('squadDisplay');
    if (!display || !mp.active) return;
    if (!force && timestamp - mp.lastHudUpdate < 240) return;
    mp.lastHudUpdate = timestamp;
    const html = mp.roster.map((member, index) => {
      const fighter = member.id === mp.playerId ? player : mp.remotePlayers.get(member.id);
      const health = fighter ? Math.max(0, Math.round(fighter.health / fighter.maxHealth * 100)) : 100;
      const status = mp.matchType === 'PVP'
        ? `${mp.pvpKills.get(member.id) || 0}K / ${mp.pvpDeaths.get(member.id) || 0}D`
        : (health <= 0 ? 'DOWN' : `${health}%`);
      return `<div class="squad-mini"><i style="color:${PILOT_COLORS[index % PILOT_COLORS.length]};background:currentColor"></i><strong>${escapeHtml(member.name)}</strong><span>${status}</span></div>`;
    }).join('');
    if (html !== mp.lastSquadHtml) {
      display.innerHTML = html;
      mp.lastSquadHtml = html;
    }
    if (mp.matchType === 'PVP') {
      const localKills = mp.pvpKills.get(mp.playerId) || 0;
      if ($('scoreDisplay')) $('scoreDisplay').textContent = `${localKills}/${mp.killTarget}`;
      const leader = [...mp.roster].sort((a, b) => (mp.pvpKills.get(b.id) || 0) - (mp.pvpKills.get(a.id) || 0))[0];
      if ($('waveDisplay')) $('waveDisplay').textContent = leader ? `LEADER ${leader.name.toUpperCase()}` : 'PVP CLASH';
    }
  }

  function finishGuestMatch(summary) {
    if (mp.finalReceived) return;
    mp.finalReceived = true;
    score = Number(summary.score) || 0;
    wave = Math.max(1, Number(summary.wave) || 1);
    killStats = summary.killStats && typeof summary.killStats === 'object' ? { ...summary.killStats } : {};
    originalGameOver();
    $('pvpRespawnOverlay')?.classList.add('hidden');
    document.body.classList.remove('pvp-active');
    enhanceResults(summary);
  }

  function createMatchSummary() {
    const startedAt = mp.active ? mp.matchStartedAt : soloMatchStartedAt;
    const pvpScores = mp.roster
      .map((member) => ({
        id: member.id,
        name: member.name,
        kills: mp.pvpKills.get(member.id) || 0,
        deaths: mp.pvpDeaths.get(member.id) || 0,
      }))
      .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    return {
      score,
      wave,
      killStats: { ...killStats },
      durationMs: Math.max(0, Date.now() - startedAt),
      squadSize: mp.active ? mp.roster.length : 1,
      roomCode: mp.roomCode,
      playerKills: Object.fromEntries(mp.playerKills),
      mode: mp.active ? mp.matchType : 'SOLO',
      killTarget: mp.killTarget,
      winnerId: mp.pvpWinnerId || pvpScores[0]?.id || '',
      pvpScores,
    };
  }

  function enhanceResults(summary = createMatchSummary()) {
    const entries = Object.entries(summary.killStats || killStats || {}).sort((a, b) => b[1] - a[1]);
    const totalKills = entries.reduce((total, [, count]) => total + Number(count || 0), 0);
    const durationMs = Number(summary.durationMs) || Math.max(0, Date.now() - (mp.active ? mp.matchStartedAt : soloMatchStartedAt));
    const minutes = Math.floor(durationMs / 60000);
    const seconds = Math.floor(durationMs % 60000 / 1000);
    const isPvp = summary.mode === 'PVP' || (mp.active && mp.matchType === 'PVP');
    if (isPvp) {
      const standings = Array.isArray(summary.pvpScores) ? summary.pvpScores.slice().sort((a, b) => Number(b.kills) - Number(a.kills) || Number(a.deaths) - Number(b.deaths)) : [];
      const winner = standings.find((entry) => entry.id === summary.winnerId) || standings[0] || { name: 'Pilot', kills: 0, deaths: 0 };
      const localIndex = Math.max(0, standings.findIndex((entry) => entry.id === mp.playerId));
      const local = standings[localIndex] || { kills: 0, deaths: 0 };
      if ($('finalModeLabel')) $('finalModeLabel').textContent = `ROOM ${summary.roomCode || mp.roomCode} · PVP REPORT`;
      if ($('finalRank')) $('finalRank').textContent = String(localIndex + 1);
      if ($('finalScore')) $('finalScore').textContent = `${Number(winner.kills) || 0} KOs`;
      if ($('starRating')) $('starRating').textContent = `WINNER · ${String(winner.name || 'PILOT').toUpperCase()}`;
      if ($('summaryStats')) {
        $('summaryStats').innerHTML = [
          ['WINNER', escapeHtml(winner.name || 'Pilot'), `${winner.kills || 0} KOs`],
          ['YOUR KOs', Number(local.kills) || 0, `TARGET ${summary.killTarget || mp.killTarget}`],
          ['YOUR DEATHS', Number(local.deaths) || 0, `PLACE #${localIndex + 1}`],
          ['MATCH TIME', `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`, currentMapName.toUpperCase()],
        ].map(([label, value, detail]) => `<div class="summary-stat"><span>${label}</span><strong>${value}</strong><small>${detail}</small></div>`).join('');
      }
      if ($('killStatsDisplay')) {
        const rows = standings.map((entry, index) => `<tr><td class="text-left" style="color:${PILOT_COLORS[index % PILOT_COLORS.length]}">#${index + 1} ${escapeHtml(entry.name || 'Pilot')}</td><td class="text-right">${Number(entry.kills) || 0} KOs · ${Number(entry.deaths) || 0} D</td></tr>`).join('');
        $('killStatsDisplay').innerHTML = `<table><tbody>${rows || '<tr><td>No combat telemetry.</td></tr>'}</tbody></table>`;
      }
      const replay = $('restartBtnForest');
      if (replay) {
        replay.disabled = mp.active && !mp.isHost;
        replay.textContent = mp.active && !mp.isHost ? 'WAITING FOR ROOM HOST' : 'REMATCH';
        replay.style.opacity = replay.disabled ? '.45' : '1';
      }
      return;
    }
    const rank = wave >= 10 || score >= 12000 ? 'S' : wave >= 7 || score >= 7000 ? 'A' : wave >= 4 || score >= 3500 ? 'B' : 'C';
    const stars = rank === 'S' ? 3 : rank === 'A' ? 3 : rank === 'B' ? 2 : 1;

    if ($('finalModeLabel')) $('finalModeLabel').textContent = mp.active ? `ROOM ${mp.roomCode} · SQUAD REPORT` : 'SOLO OPERATION REPORT';
    if ($('finalRank')) $('finalRank').textContent = rank;
    if ($('finalScore')) $('finalScore').textContent = Number(score).toLocaleString();
    if ($('starRating')) $('starRating').textContent = `${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}`;
    if ($('summaryStats')) {
      $('summaryStats').innerHTML = [
        ['WAVES CLEARED', wave, difficulty],
        ['ELIMINATIONS', totalKills, `${(totalKills / Math.max(1, wave)).toFixed(1)} / WAVE`],
        ['MISSION TIME', `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`, currentMapName.toUpperCase()],
        ['SQUAD SIZE', summary.squadSize || (mp.active ? mp.roster.length : 1), mp.active ? 'CO-OP' : 'SOLO'],
      ].map(([label, value, detail]) => `<div class="summary-stat"><span>${label}</span><strong>${value}</strong><small>${detail}</small></div>`).join('');
    }

    if ($('killStatsDisplay')) {
      const rows = entries.length
        ? entries.map(([name, count]) => `<tr><td class="text-left capitalize" style="color:${CHAR_PROFILES[name]?.color || '#c4b5fd'}">${escapeHtml(name)}</td><td class="text-right">×${Number(count)}</td></tr>`).join('')
        : '<tr><td colspan="2" class="text-center">No confirmed eliminations.</td></tr>';
      $('killStatsDisplay').innerHTML = `<table><tbody>${rows}</tbody></table>`;
    }

    const replay = $('restartBtnForest');
    if (replay) {
      replay.disabled = mp.active && !mp.isHost;
      replay.textContent = mp.active && !mp.isHost ? 'WAITING FOR SQUAD LEADER' : 'REPLAY OPERATION';
      replay.style.opacity = replay.disabled ? '.45' : '1';
    }
  }

  function resetMultiplayerState(closeTransport = true) {
    if (closeTransport) window.OrbitP2P?.leave();
    clearInterval(mp.pingTimer);
    mp.pingTimer = null;
    mp.active = false;
    mp.isHost = false;
    mp.roomCode = '';
    mp.playerId = '';
    mp.roster = [];
    mp.remotePlayers.clear();
    mp.networkProjectiles = [];
    mp.pvpProjectiles = [];
    mp.pvpKills.clear();
    mp.pvpDeaths.clear();
    mp.pvpProcessedHits.clear();
    mp.matchType = 'COOP';
    mp.killTarget = 5;
    mp.pvpWinnerId = '';
    mp.lastSquadHtml = '';
    mp.latestSnapshot = null;
    mp.localDown = false;
    mp.finalReceived = false;
    mp.gameOverSent = false;
    $('pvpRespawnOverlay')?.classList.add('hidden');
    document.body.classList.remove('pvp-active');
    updateSessionUI();
  }

  function returnToMenu(disconnect = true) {
    if (disconnect) resetMultiplayerState(true);
    gameState = 'MENU';
    isGamePaused = false;
    $('hud')?.classList.add('hidden');
    $('gameOverMenu')?.classList.add('hidden');
    $('lobbyMenu')?.classList.add('hidden');
    $('customizeMenu')?.classList.add('hidden');
    $('startMenu')?.classList.remove('hidden');
    $('mobileFireBtn')?.classList.add('hidden');
    $('mobileSwapBtn')?.classList.add('hidden');
    $('pvpRespawnOverlay')?.classList.add('hidden');
    document.body.classList.remove('game-active', 'pvp-active');
    if (ambientGain) ambientGain.gain.linearRampToValueAtTime(0.001, audioCtx.currentTime + .35);
  }

  const originalInitGame = initGame;
  initGame = function orbitInitGame(mapName) {
    currentMapName = mapName;
    soloMatchStartedAt = Date.now();
    originalInitGame(mapName);
    const memberIndex = Math.max(0, mp.roster.findIndex((entry) => entry.id === mp.playerId));
    const profile = profileForPlayer(mp.playerId || 'solo', getCallsign(), memberIndex);
    player.name = profile.name;
    player.color = profile.color;
    player.gender = profile.gender;
    player.hairColor = profile.hairColor;
    player.networkId = mp.playerId || 'solo';
    updateSessionUI();
  };

  const originalGameOver = gameOver;
  gameOver = function orbitGameOver() {
    if (mp.active && !mp.isHost && !mp.finalReceived) return;
    const summary = createMatchSummary();
    originalGameOver();
    $('pvpRespawnOverlay')?.classList.add('hidden');
    document.body.classList.remove('pvp-active');
    enhanceResults(summary);
    if (mp.active && mp.isHost && !mp.gameOverSent) {
      mp.gameOverSent = true;
      send({ type: 'host_game_over', summary });
    }
  };

  const originalBotUpdate = Bot.prototype.update;
  Bot.prototype.update = function orbitBotUpdate(timestamp) {
    if (mp.active && !mp.isHost) return;
    if (!mp.active || !mp.isHost) return originalBotUpdate.call(this, timestamp);
    const originalPlayer = player;
    const candidates = activeHostPlayers().filter((fighter) => fighter.health > 0);
    let target = candidates[0];
    let nearest = Infinity;
    for (const fighter of candidates) {
      const distance = Math.hypot(fighter.x - this.x, fighter.y - this.y);
      if (distance < nearest) { nearest = distance; target = fighter; }
    }
    if (target) player = target;
    try { return originalBotUpdate.call(this, timestamp); }
    finally { player = originalPlayer; }
  };

  const originalPlayerUpdate = Player.prototype.update;
  Player.prototype.update = function orbitPlayerUpdate(timestamp) {
    if (mp.active && this === player && mp.localDown) return;
    return originalPlayerUpdate.call(this, timestamp);
  };

  function installReplayButton() {
    const oldButton = $('restartBtnForest');
    if (!oldButton) return;
    const button = oldButton.cloneNode(true);
    oldButton.replaceWith(button);
    button.addEventListener('click', () => {
      if (mp.active) {
        if (!mp.isHost) return;
        send({ type: 'restart_game', config: { map: mp.currentMap, difficulty, matchType: mp.matchType, killTarget: mp.killTarget } });
      } else {
        initGame(currentMapName);
      }
    });
  }

  $('modeSoloBtn')?.addEventListener('click', () => setMode('solo'));
  $('modeMultiBtn')?.addEventListener('click', () => setMode('multi'));
  $('createRoomBtn')?.addEventListener('click', createRoom);
  $('joinRoomBtn')?.addEventListener('click', joinRoom);
  $('joinRoomCode')?.addEventListener('input', (event) => {
    event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  });
  $('joinRoomCode')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') joinRoom(); });
  $('playerNameInput')?.addEventListener('change', getCallsign);
  $('lobbyMatchType')?.addEventListener('change', syncLobbyMatchFields);
  $('lobbyStartBtn')?.addEventListener('click', startRoomMatch);
  $('leaveRoomBtn')?.addEventListener('click', () => { resetMultiplayerState(true); returnToMenu(false); });
  $('copyRoomCodeBtn')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(mp.roomCode);
      showToast(`Room ${mp.roomCode} copied.`);
    } catch (_) {
      showToast(`Invite code: ${mp.roomCode}`, 4000);
    }
  });
  $('returnMenuBtn')?.addEventListener('click', () => returnToMenu(true));
  $('pauseBtn')?.addEventListener('click', (event) => {
    if (!mp.active) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    isGamePaused = false;
    $('pauseOverlay')?.classList.add('hidden');
    showToast('Online matches continue in real time.');
  }, true);

  const storedCallsign = safeStorageGet('orbitclash-callsign');
  if ($('playerNameInput')) $('playerNameInput').value = cleanName(storedCallsign || 'Orbit Pilot');
  setMode('solo');
  syncLobbyMatchFields();
  installReplayButton();

  window.OrbitMultiplayer = {
    drawRemotePlayers,
    onFrame,
    handleEndCondition,
    shouldSpawnWave() { return !mp.active || mp.matchType !== 'PVP'; },
    allowsWorldDrops() { return !mp.active || mp.matchType !== 'PVP'; },
    get state() { return { active: mp.active, isHost: mp.isHost, roomCode: mp.roomCode, players: mp.roster.length, matchType: mp.matchType, killTarget: mp.killTarget }; },
  };
})();

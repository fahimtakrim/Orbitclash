import { joinRoom as joinTrysteroRoom, selfId } from 'trystero';
import { MAX_PLAYERS, admitPilot, cleanPilotName, normalizeMatchConfig } from './room-rules.mjs';

const APP_ID = 'orbitclash-fohf-2026-coop-v1';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const state = {
  room: null,
  action: null,
  role: '',
  code: '',
  name: '',
  hostPeerId: '',
  roster: [],
  admitted: false,
  started: false,
  onMessage: null,
  joinTimer: null,
};

function emit(message) {
  try { state.onMessage?.(message); }
  catch (error) { console.warn('Orbitclash transport event failed:', error); }
}

function cleanCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

function createCode() {
  const random = new Uint32Array(6);
  crypto.getRandomValues(random);
  return [...random].map((number) => CODE_ALPHABET[number % CODE_ALPHABET.length]).join('');
}

function currentRoster() {
  return state.roster.map((member) => ({ ...member }));
}

function sendAction(message, target = null) {
  if (!state.action) return false;
  const options = target ? { target } : undefined;
  Promise.resolve(state.action.send(message, options)).catch((error) => {
    console.warn('Orbitclash peer message failed:', error);
  });
  return true;
}

function broadcastRoster() {
  const roster = currentRoster();
  sendAction({ kind: 'roster', roster });
  emit({ type: 'roster', roster });
}

function closeRoom() {
  clearTimeout(state.joinTimer);
  state.joinTimer = null;
  try { state.room?.leave(); } catch (_) {}
  state.room = null;
  state.action = null;
  state.role = '';
  state.code = '';
  state.name = '';
  state.hostPeerId = '';
  state.roster = [];
  state.admitted = false;
  state.started = false;
}

function handlePeerMessage(message, peerId) {
  if (!message || typeof message.kind !== 'string') return;

  if (message.kind === 'hello' && state.role === 'host') {
    if (state.started) {
      sendAction({ kind: 'deny', reason: 'That squad has already deployed.' }, peerId);
      return;
    }
    const admission = admitPilot(state.roster, { id: peerId, name: message.name });
    if (!admission.ok) {
      sendAction({ kind: 'deny', reason: admission.reason }, peerId);
      return;
    }
    if (admission.existing) return;
    state.roster = admission.roster;
    sendAction({ kind: 'admit', hostId: selfId, roomCode: state.code, roster: currentRoster() }, peerId);
    broadcastRoster();
    return;
  }

  if (message.kind === 'room_meta' && state.role === 'guest' && message.role === 'host') {
    state.hostPeerId = peerId;
    return;
  }

  if (message.kind === 'admit' && state.role === 'guest') {
    state.hostPeerId = peerId;
    state.roster = Array.isArray(message.roster) ? message.roster.slice(0, MAX_PLAYERS) : [];
    state.admitted = true;
    clearTimeout(state.joinTimer);
    emit({
      type: 'room_ready',
      roomCode: state.code,
      playerId: selfId,
      isHost: false,
      roster: currentRoster(),
    });
    return;
  }

  if (message.kind === 'deny' && state.role === 'guest') {
    emit({ type: 'error', code: 'ROOM_FULL', message: message.reason || 'Room admission denied.' });
    closeRoom();
    return;
  }

  const fromHost = state.role === 'guest' && peerId === state.hostPeerId;
  const admittedGuest = state.role === 'host' && state.roster.some((member) => member.id === peerId);

  if (message.kind === 'roster' && fromHost) {
    state.roster = Array.isArray(message.roster) ? message.roster.slice(0, MAX_PLAYERS) : state.roster;
    emit({ type: 'roster', roster: currentRoster() });
  } else if (message.kind === 'game_started' && fromHost) {
    emit({ type: 'game_started', config: message.config });
  } else if (message.kind === 'restart_game' && fromHost) {
    emit({ type: 'restart_game', config: message.config });
  } else if (message.kind === 'guest_state' && admittedGuest) {
    emit({ type: 'guest_state', playerId: peerId, state: message.state });
  } else if (message.kind === 'guest_damage' && admittedGuest) {
    emit({ type: 'guest_damage', playerId: peerId, botId: message.botId, damage: message.damage });
  } else if (message.kind === 'guest_pvp_hit' && admittedGuest) {
    emit({ type: 'guest_pvp_hit', playerId: peerId, targetId: message.targetId, damage: message.damage, bulletId: message.bulletId });
  } else if (message.kind === 'guest_pvp_shot' && admittedGuest) {
    emit({ type: 'pvp_shot', playerId: peerId, shot: message.shot });
    sendAction({ kind: 'remote_pvp_shot', playerId: peerId, shot: message.shot });
  } else if (message.kind === 'remote_pvp_shot' && fromHost) {
    emit({ type: 'pvp_shot', playerId: message.playerId, shot: message.shot });
  } else if (message.kind === 'host_snapshot' && fromHost) {
    emit({ type: 'host_snapshot', snapshot: message.snapshot });
  } else if (message.kind === 'host_game_over' && fromHost) {
    emit({ type: 'host_game_over', summary: message.summary });
  } else if (message.kind === 'room_closed' && fromHost) {
    emit({ type: 'room_closed', message: 'The squad leader closed the room.' });
    closeRoom();
  }
}

function openRoom({ code, name, role, onMessage }) {
  closeRoom();
  state.code = cleanCode(code);
  state.name = cleanPilotName(name);
  state.role = role;
  state.onMessage = onMessage;
  state.roster = role === 'host' ? [{ id: selfId, name: state.name, isHost: true }] : [];

  state.room = joinTrysteroRoom({
    appId: APP_ID,
    password: `orbitclash-${state.code}`,
    relayConfig: { redundancy: 3, warnOnRelayFailure: false },
  }, `oc-${state.code.toLowerCase()}`, {
    onJoinError: ({ error }) => {
      emit({ type: 'error', code: 'CONNECTION_FAILED', message: error?.message || 'Could not establish a peer connection.' });
    },
  });

  state.action = state.room.makeAction('oc-msg');
  state.action.onMessage = (message, { peerId }) => handlePeerMessage(message, peerId);

  state.room.onPeerJoin = (peerId) => {
    if (state.role === 'host') {
      sendAction({ kind: 'room_meta', role: 'host', hostId: selfId, name: state.name }, peerId);
    } else {
      sendAction({ kind: 'hello', name: state.name }, peerId);
    }
  };

  state.room.onPeerLeave = (peerId) => {
    if (state.role === 'host') {
      const before = state.roster.length;
      state.roster = state.roster.filter((member) => member.id !== peerId);
      if (state.roster.length !== before) broadcastRoster();
    } else if (peerId === state.hostPeerId) {
      emit({ type: 'room_closed', message: 'The squad leader left the room.' });
      closeRoom();
    }
  };
}

async function create({ name, onMessage }) {
  const code = createCode();
  openRoom({ code, name, role: 'host', onMessage });
  state.admitted = true;
  queueMicrotask(() => emit({
    type: 'room_ready',
    roomCode: code,
    playerId: selfId,
    isHost: true,
    roster: currentRoster(),
  }));
  return { code, playerId: selfId };
}

async function join({ code, name, onMessage }) {
  const roomCode = cleanCode(code);
  if (roomCode.length !== 6) throw new Error('Enter a complete six-character room code.');
  openRoom({ code: roomCode, name, role: 'guest', onMessage });
  state.joinTimer = setTimeout(() => {
    if (state.admitted) return;
    emit({ type: 'error', code: 'ROOM_NOT_FOUND', message: 'Room not found or the host could not be reached.' });
    closeRoom();
  }, 18000);
  return { code: roomCode, playerId: selfId };
}

function send(payload) {
  if (!state.room || !state.action || !payload?.type) return false;

  if (payload.type === 'ping') {
    const peers = Object.keys(state.room.getPeers());
    const target = state.role === 'guest' ? state.hostPeerId : peers[0];
    if (!target) {
      emit({ type: 'pong', latency: 1 });
      return true;
    }
    state.room.ping(target)
      .then((latency) => emit({ type: 'pong', latency }))
      .catch(() => emit({ type: 'pong', latency: 999 }));
    return true;
  }

  if (payload.type === 'start_game' && state.role === 'host') {
    state.started = true;
    const config = normalizeMatchConfig(payload.config);
    sendAction({ kind: 'game_started', config });
    emit({ type: 'game_started', config });
  } else if (payload.type === 'restart_game' && state.role === 'host') {
    state.started = true;
    const config = normalizeMatchConfig(payload.config);
    sendAction({ kind: 'restart_game', config });
    emit({ type: 'restart_game', config });
  } else if (payload.type === 'guest_state' && state.role === 'guest' && state.hostPeerId) {
    sendAction({ kind: 'guest_state', state: payload.state }, state.hostPeerId);
  } else if (payload.type === 'guest_damage' && state.role === 'guest' && state.hostPeerId) {
    sendAction({ kind: 'guest_damage', botId: payload.botId, damage: payload.damage }, state.hostPeerId);
  } else if (payload.type === 'pvp_hit' && state.role === 'guest' && state.hostPeerId) {
    sendAction({ kind: 'guest_pvp_hit', targetId: payload.targetId, damage: payload.damage, bulletId: payload.bulletId }, state.hostPeerId);
  } else if (payload.type === 'pvp_hit' && state.role === 'host') {
    emit({ type: 'guest_pvp_hit', playerId: selfId, targetId: payload.targetId, damage: payload.damage, bulletId: payload.bulletId });
  } else if (payload.type === 'pvp_shot' && state.role === 'guest' && state.hostPeerId) {
    sendAction({ kind: 'guest_pvp_shot', shot: payload.shot }, state.hostPeerId);
  } else if (payload.type === 'pvp_shot' && state.role === 'host') {
    sendAction({ kind: 'remote_pvp_shot', playerId: selfId, shot: payload.shot });
  } else if (payload.type === 'host_snapshot' && state.role === 'host') {
    sendAction({ kind: 'host_snapshot', snapshot: payload.snapshot });
  } else if (payload.type === 'host_game_over' && state.role === 'host') {
    state.started = false;
    sendAction({ kind: 'host_game_over', summary: payload.summary });
  } else if (payload.type === 'leave_room') {
    leave();
  } else {
    return false;
  }
  return true;
}

function leave() {
  if (state.role === 'host') sendAction({ kind: 'room_closed' });
  closeRoom();
}

window.OrbitP2P = {
  create,
  join,
  send,
  leave,
  get state() {
    return {
      connected: Boolean(state.room),
      role: state.role,
      code: state.code,
      playerId: selfId,
      peers: state.room ? Object.keys(state.room.getPeers()).length : 0,
    };
  },
};

window.dispatchEvent(new Event('orbit-transport-ready'));

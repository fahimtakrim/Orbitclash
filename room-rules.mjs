export const MAX_PLAYERS = 6;
export const PVP_KILL_TARGETS = Object.freeze([3, 5, 10]);

export function normalizeMatchConfig(value = {}) {
  const maps = ['Forest', 'Garage', 'Cyber City'];
  const difficulties = ['EASY', 'NORMAL', 'HARD'];
  const requestedTarget = Number(value.killTarget);
  return {
    map: maps.includes(value.map) ? value.map : 'Forest',
    difficulty: difficulties.includes(value.difficulty) ? value.difficulty : 'NORMAL',
    matchType: value.matchType === 'PVP' ? 'PVP' : 'COOP',
    killTarget: PVP_KILL_TARGETS.includes(requestedTarget) ? requestedTarget : 5,
  };
}

export function cleanPilotName(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16) || 'Orbit Pilot';
}

export function admitPilot(roster, candidate) {
  const current = Array.isArray(roster) ? roster : [];
  if (!candidate?.id) return { ok: false, reason: 'Invalid pilot identity.', roster: current };
  if (current.some((member) => member.id === candidate.id)) return { ok: true, roster: current, existing: true };
  if (current.length >= MAX_PLAYERS) return { ok: false, reason: 'That room already has six pilots.', roster: current };
  return {
    ok: true,
    existing: false,
    roster: [...current, { id: candidate.id, name: cleanPilotName(candidate.name), isHost: false }],
  };
}

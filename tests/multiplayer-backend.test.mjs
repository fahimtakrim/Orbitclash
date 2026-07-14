import assert from 'node:assert/strict';
import server from '../hosting/server.mjs';
import { MAX_PLAYERS, PVP_KILL_TARGETS, admitPilot, cleanPilotName, normalizeMatchConfig } from '../room-rules.mjs';

const health = await server.fetch(new Request('https://orbitclash.test/api/health'), {});
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), {
  ok: true,
  service: 'orbitclash-multiplayer',
  transport: 'encrypted-webrtc-p2p',
  maxPlayers: 6,
});

const legacySocket = await server.fetch(new Request('https://orbitclash.test/api/multiplayer'), {});
assert.equal(legacySocket.status, 410);
assert.equal((await legacySocket.json()).transport, 'webrtc');

assert.equal(MAX_PLAYERS, 6);
let roster = [{ id: 'host', name: 'Host', isHost: true }];
for (let index = 1; index <= 5; index++) {
  const result = admitPilot(roster, { id: `guest-${index}`, name: `Pilot ${index}` });
  assert.equal(result.ok, true);
  roster = result.roster;
}
assert.equal(roster.length, 6);
assert.equal(admitPilot(roster, { id: 'guest-6', name: 'Pilot 6' }).ok, false);
assert.equal(cleanPilotName('<script>Nova</script>'), 'scriptNovascript');
assert.deepEqual(PVP_KILL_TARGETS, [3, 5, 10]);
assert.deepEqual(normalizeMatchConfig({ map: 'Cyber City', difficulty: 'HARD', matchType: 'PVP', killTarget: 10 }), {
  map: 'Cyber City',
  difficulty: 'HARD',
  matchType: 'PVP',
  killTarget: 10,
});
assert.deepEqual(normalizeMatchConfig({ map: 'Fake', difficulty: 'IMPOSSIBLE', matchType: 'UNKNOWN', killTarget: 999 }), {
  map: 'Forest',
  difficulty: 'NORMAL',
  matchType: 'COOP',
  killTarget: 5,
});

console.log('Multiplayer service contract tests: PASS');

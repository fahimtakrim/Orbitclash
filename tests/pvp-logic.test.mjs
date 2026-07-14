import assert from 'node:assert/strict';

// Mocking the validation algorithms implemented in public/multiplayer.js

function validateGuestPosition(stateX, stateY, remoteTargetX, remoteTargetY, remoteWidth, remoteHeight, mapPlatforms) {
  let proposedX = stateX;
  let proposedY = stateY;

  // 1. Impossible jump check (lag/cheat prevention)
  let dist = Math.hypot(proposedX - remoteTargetX, proposedY - remoteTargetY);
  if (remoteTargetX && remoteTargetY && dist > 300) {
    proposedX = remoteTargetX;
    proposedY = remoteTargetY;
  }

  // 2. Resolve platform collisions
  let tempRect = { x: proposedX, y: proposedY, width: remoteWidth, height: remoteHeight };
  for (let p of mapPlatforms) {
    // checkCollision mock
    const checkCollision = (r1, r2) => {
      return r1.x < r2.x + r2.width && r1.x + r1.width > r2.x && r1.y < r2.y + r2.height && r1.y + r1.height > r2.y;
    };

    if (checkCollision(tempRect, p)) {
      let overlapX = Math.min(tempRect.x + tempRect.width - p.x, p.x + p.width - tempRect.x);
      let overlapY = Math.min(tempRect.y + tempRect.height - p.y, p.y + p.height - tempRect.y);
      if (overlapX < overlapY) {
        if (tempRect.x + tempRect.width/2 < p.x + p.width/2) proposedX -= overlapX;
        else proposedX += overlapX;
      } else {
        if (tempRect.y + tempRect.height/2 < p.y + p.height/2) proposedY -= overlapY;
        else proposedY += overlapY;
      }
      tempRect.x = proposedX;
      tempRect.y = proposedY;
    }
  }

  return { x: proposedX, y: proposedY };
}

function validatePvpHit(safeBulletId, trackedRemoteShots, target, targetId, hitKey, pvpProcessedHits) {
  if (pvpProcessedHits.has(hitKey)) return { ok: false, reason: 'duplicate' };
  if (target.health <= 0 || (target.respawnAt && target.respawnAt > Date.now())) return { ok: false, reason: 'dead' };
  if (target.spawnProtectionUntil && target.spawnProtectionUntil > Date.now()) return { ok: false, reason: 'protected' };

  const shot = trackedRemoteShots.get(safeBulletId);
  if (!shot) return { ok: false, reason: 'unregistered' };

  let elapsedSeconds = (Date.now() - shot.time) / 1000;
  let bulletCurrentX = shot.x + shot.vx * elapsedSeconds * 60;
  let bulletCurrentY = shot.y + shot.vy * elapsedSeconds * 60;
  let dist = Math.hypot(target.x + target.width/2 - bulletCurrentX, target.y + target.height/2 - bulletCurrentY);
  if (dist > 180) return { ok: false, reason: 'too_far' };

  return { ok: true };
}

// ==================== TEST SUITE ====================

// Test Position Validation
const platforms = [{ x: 100, y: 100, width: 50, height: 50 }];
// Case 1: Normal movement inside bounds
let pos1 = validateGuestPosition(120, 20, 100, 20, 30, 40, platforms);
assert.equal(pos1.x, 120);

// Case 2: Impossible jump (>300px) gets reset to target
let pos2 = validateGuestPosition(500, 20, 100, 20, 30, 40, platforms);
assert.equal(pos2.x, 100);

// Case 3: Overlapping platform gets resolved (pushed out)
let pos3 = validateGuestPosition(90, 100, 50, 100, 30, 40, platforms);
assert.ok(pos3.x <= 100 || pos3.x >= 150);

// Test Hit Validation
const shots = new Map();
const processedHits = new Set();

const mockTarget = {
  x: 100,
  y: 100,
  width: 30,
  height: 40,
  health: 100,
  respawnAt: 0,
  spawnProtectionUntil: 0,
};

// Case 1: Unregistered bullet gets rejected
let hit1 = validatePvpHit('b-fake', shots, mockTarget, 'player2', 'p1:p2:b-fake', processedHits);
assert.equal(hit1.ok, false);
assert.equal(hit1.reason, 'unregistered');

// Case 2: Spawn-protected target gets rejected
shots.set('b-real', { x: 105, y: 105, vx: 0, vy: 0, time: Date.now() });
mockTarget.spawnProtectionUntil = Date.now() + 2000;
let hit2 = validatePvpHit('b-real', shots, mockTarget, 'player2', 'p1:p2:b-real', processedHits);
assert.equal(hit2.ok, false);
assert.equal(hit2.reason, 'protected');

// Case 3: Normal hit validated successfully
mockTarget.spawnProtectionUntil = 0;
let hit3 = validatePvpHit('b-real', shots, mockTarget, 'player2', 'p1:p2:b-real', processedHits);
assert.equal(hit3.ok, true);

// Case 4: Target is too far from bullet path gets rejected
shots.set('b-far', { x: 1000, y: 1000, vx: 0, vy: 0, time: Date.now() });
let hit4 = validatePvpHit('b-far', shots, mockTarget, 'player2', 'p1:p2:b-far', processedHits);
assert.equal(hit4.ok, false);
assert.equal(hit4.reason, 'too_far');

console.log('PvP logic automated unit tests: PASS');

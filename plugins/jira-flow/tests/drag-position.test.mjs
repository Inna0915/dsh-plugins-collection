import test from 'node:test';
import assert from 'node:assert/strict';
import { placeTargets, keepTargetsStill } from '../dist/test-exports.js';

const size = { width: 296, height: 318 };
const bounds = { width: 1280, height: 800 };

test('drag targets sit beside the pointer and flip inward at the right edge', () => {
  const right = placeTargets({ x: 300, y: 250 }, size, bounds);
  assert.equal(right.side, 'right');
  assert.equal(right.x, 328);
  assert.equal(right.y, 202);
  const left = placeTargets({ x: 1200, y: 250 }, size, bounds);
  assert.equal(left.side, 'left');
  assert.ok(left.x + left.width < 1200);
});

test('targets stay inside the host at every edge, including a small viewport', () => {
  for (const viewport of [bounds, { width: 280, height: 240 }]) {
    for (const point of [
      { x: 0, y: 0 },
      { x: viewport.width, y: viewport.height },
      { x: 100, y: 790 },
    ]) {
      const panel = placeTargets(point, size, viewport);
      assert.ok(panel.x >= 12 && panel.y >= 12);
      assert.ok(panel.x + panel.width <= viewport.width - 12);
      assert.ok(panel.y + panel.height <= viewport.height - 12);
    }
  }
});

test('slow approach can reach every node without the menu chasing the pointer', () => {
  const anchor = { x: 300, y: 250 };
  let panel = placeTargets(anchor, size, bounds),
    previous = anchor,
    locked = false;
  const initial = { ...panel };
  for (let x = 301; x <= 480; x++) {
    const point = { x, y: 250 };
    locked = keepTargetsStill(point, previous, panel, locked);
    if (!locked) panel = placeTargets(point, size, bounds);
    previous = point;
  }
  for (let y = 251; y < panel.y + panel.height - 10; y++) {
    const point = { x: 480, y };
    assert.ok(keepTargetsStill(point, previous, panel, locked));
    previous = point;
  }
  assert.deepEqual(panel, initial);
});

test('left-side targets stay reachable and following resumes outside the corridor', () => {
  const anchor = { x: 1100, y: 300 };
  const panel = placeTargets(anchor, size, bounds);
  assert.ok(keepTargetsStill({ x: 1099, y: 300 }, anchor, panel, false));
  assert.ok(keepTargetsStill({ x: panel.x + 20, y: 400 }, anchor, panel, true));
  assert.equal(keepTargetsStill({ x: 1100, y: 700 }, anchor, panel, true), false);
  const followed = placeTargets({ x: 1100, y: 700 }, size, bounds);
  assert.notEqual(followed.y, panel.y);
});

test('moving away from targets tracks the card immediately', () => {
  const anchor = { x: 300, y: 250 };
  const panel = placeTargets(anchor, size, bounds);
  assert.equal(keepTargetsStill({ x: 299, y: 250 }, anchor, panel, false), false);
  assert.equal(keepTargetsStill({ x: 300, y: 260 }, anchor, panel, false), false);
});

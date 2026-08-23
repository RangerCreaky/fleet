const assert = require('node:assert/strict');
const test = require('node:test');

const g = require('../geometry');

// A typical laptop work area that does not start at the origin, so an
// implementation that forgets workArea.x/y shows up immediately.
const workArea = { x: 100, y: 50, width: 1400, height: 900 };

test('dockX pins to the requested screen edge', () => {
  assert.equal(g.dockX(workArea, 400, 'right'), 1100); // 100 + 1400 - 400
  assert.equal(g.dockX(workArea, 400, 'left'), 100);
  // Unknown values fall back to the default edge rather than producing NaN.
  assert.equal(g.dockX(workArea, 400, 'sideways'), g.dockX(workArea, 400, 'right'));
});

test('dockY centres on the offset ratio and clamps inside the work area', () => {
  // 0.5 of 900 = 450, minus half of a 64px handle => 50 + 450 - 32
  assert.equal(g.dockY(workArea, 64, 0.5), 468);
  // Hard against the top and bottom edges, never outside them.
  assert.equal(g.dockY(workArea, 64, 0), workArea.y);
  assert.equal(g.dockY(workArea, 64, 1), workArea.y + workArea.height - 64);
  // Out-of-range and garbage ratios still land on screen.
  assert.equal(g.dockY(workArea, 64, 5), workArea.y + workArea.height - 64);
  assert.equal(g.dockY(workArea, 64, 'nonsense'), 468);
});

test('collapsedSize distinguishes capsule from icon', () => {
  assert.deepEqual(g.collapsedSize('capsule'), { width: 16, height: 64 });
  assert.deepEqual(g.collapsedSize('icon'), { width: 40, height: 40 });
  assert.deepEqual(g.collapsedSize(undefined), { width: 16, height: 64 });
});

test('expandedSize clamps width and treats height 0 as full height', () => {
  assert.deepEqual(g.expandedSize(workArea, { expandedWidth: 500, expandedHeight: 600 }), { width: 500, height: 600 });
  // Existing installs store no height: the panel fills the work area.
  assert.equal(g.expandedSize(workArea, { expandedWidth: 400 }).height, workArea.height);
  // Min / max clamps on both axes.
  assert.equal(g.expandedSize(workArea, { expandedWidth: 50 }).width, g.MIN_EXPANDED_WIDTH);
  assert.equal(g.expandedSize(workArea, { expandedWidth: 5000 }).width, g.MAX_EXPANDED_WIDTH);
  assert.equal(g.expandedSize(workArea, { expandedWidth: 400, expandedHeight: 10 }).height, g.MIN_EXPANDED_HEIGHT);
});

test('expandedSize never exceeds a small work area', () => {
  const narrow = { x: 0, y: 0, width: 500, height: 400 };
  assert.equal(g.expandedSize(narrow, { expandedWidth: 800 }).width, 500);
  assert.equal(g.expandedSize(narrow, { expandedWidth: 400, expandedHeight: 2000 }).height, 400);
});

test('windowBounds composes edge, offset and size', () => {
  const collapsedRight = g.windowBounds(false, workArea, { dockSide: 'right', collapsedStyle: 'capsule', dockOffset: 0.5 });
  assert.deepEqual(collapsedRight, { x: 1484, y: 468, width: 16, height: 64 });

  const collapsedLeftIcon = g.windowBounds(false, workArea, { dockSide: 'left', collapsedStyle: 'icon', dockOffset: 0 });
  assert.deepEqual(collapsedLeftIcon, { x: 100, y: 50, width: 40, height: 40 });

  const expandedLeft = g.windowBounds(true, workArea, { dockSide: 'left', expandedWidth: 400, expandedHeight: 600, dockOffset: 0.5 });
  assert.equal(expandedLeft.x, 100);
  assert.equal(expandedLeft.width, 400);
  assert.equal(expandedLeft.height, 600);
});

test('windowBounds defaults match the pre-existing right-edge full-height layout', () => {
  const bounds = g.windowBounds(true, workArea, {});
  assert.equal(bounds.x, workArea.x + workArea.width - g.DEFAULT_EXPANDED_WIDTH);
  assert.equal(bounds.y, workArea.y);
  assert.equal(bounds.height, workArea.height);
});

test('dockFromPoint picks the nearer edge and a clamped offset', () => {
  assert.equal(g.dockFromPoint(workArea, 200, 400).dockSide, 'left');
  assert.equal(g.dockFromPoint(workArea, 1400, 400).dockSide, 'right');
  assert.equal(g.dockFromPoint(workArea, 200, 500).dockOffset, 0.5);
  // Dragging past the top or bottom of the work area still yields 0..1.
  assert.equal(g.dockFromPoint(workArea, 200, -999).dockOffset, 0);
  assert.equal(g.dockFromPoint(workArea, 200, 99999).dockOffset, 1);
});

'use strict';

// Pure dock geometry. Kept free of Electron imports so it can be unit tested:
// every function is a plain function of a workArea rectangle plus settings.

const COLLAPSED_WIDTH = 16;
const COLLAPSED_HEIGHT = 64;
const ICON_SIZE = 40;
const DEFAULT_EXPANDED_WIDTH = 400;
const MIN_EXPANDED_WIDTH = 260;
const MAX_EXPANDED_WIDTH = 800;
const MIN_EXPANDED_HEIGHT = 320;
const MAX_EXPANDED_HEIGHT = 2000;
const DOCK_SIDES = ['left', 'right'];
const COLLAPSED_STYLES = ['capsule', 'icon'];
const DEFAULT_DOCK_SIDE = 'right';
const DEFAULT_COLLAPSED_STYLE = 'capsule';
const DEFAULT_DOCK_OFFSET = 0.5;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeDockSide(side) {
  return DOCK_SIDES.includes(side) ? side : DEFAULT_DOCK_SIDE;
}

function normalizeCollapsedStyle(style) {
  return COLLAPSED_STYLES.includes(style) ? style : DEFAULT_COLLAPSED_STYLE;
}

function normalizeDockOffset(offset) {
  const value = Number(offset);
  return Number.isFinite(value) ? clamp(value, 0, 1) : DEFAULT_DOCK_OFFSET;
}

function dockX(workArea, width, side) {
  return normalizeDockSide(side) === 'left'
    ? workArea.x
    : workArea.x + workArea.width - width;
}

// offsetRatio addresses the centre of the window; the result is clamped so the
// handle can never end up outside the visible work area.
function dockY(workArea, height, offsetRatio) {
  const anchor = workArea.y + Math.round(normalizeDockOffset(offsetRatio) * workArea.height);
  return clamp(anchor - Math.round(height / 2), workArea.y, workArea.y + workArea.height - height);
}

function collapsedSize(style) {
  return normalizeCollapsedStyle(style) === 'icon'
    ? { width: ICON_SIZE, height: ICON_SIZE }
    : { width: COLLAPSED_WIDTH, height: COLLAPSED_HEIGHT };
}

// height 0 means "fill the work area", which is what pre-existing installs have.
function expandedSize(workArea, settings = {}) {
  const width = Number(settings.expandedWidth) || DEFAULT_EXPANDED_WIDTH;
  const height = Number(settings.expandedHeight) || 0;
  return {
    width: clamp(Math.round(width), MIN_EXPANDED_WIDTH, Math.min(MAX_EXPANDED_WIDTH, workArea.width)),
    height: height
      ? clamp(Math.round(height), MIN_EXPANDED_HEIGHT, Math.min(MAX_EXPANDED_HEIGHT, workArea.height))
      : workArea.height
  };
}

function windowBounds(expanded, workArea, settings = {}) {
  const size = expanded ? expandedSize(workArea, settings) : collapsedSize(settings.collapsedStyle);
  return {
    x: dockX(workArea, size.width, settings.dockSide),
    y: dockY(workArea, size.height, settings.dockOffset),
    width: size.width,
    height: size.height
  };
}

// Which edge a pointer at screenX belongs to, and how far down the work area it sits.
function dockFromPoint(workArea, screenX, screenY) {
  return {
    dockSide: Number(screenX) < workArea.x + workArea.width / 2 ? 'left' : 'right',
    dockOffset: clamp((Number(screenY) - workArea.y) / workArea.height, 0, 1)
  };
}

module.exports = {
  COLLAPSED_WIDTH,
  COLLAPSED_HEIGHT,
  ICON_SIZE,
  DEFAULT_EXPANDED_WIDTH,
  MIN_EXPANDED_WIDTH,
  MAX_EXPANDED_WIDTH,
  MIN_EXPANDED_HEIGHT,
  MAX_EXPANDED_HEIGHT,
  DOCK_SIDES,
  COLLAPSED_STYLES,
  DEFAULT_DOCK_SIDE,
  DEFAULT_COLLAPSED_STYLE,
  DEFAULT_DOCK_OFFSET,
  clamp,
  normalizeDockSide,
  normalizeCollapsedStyle,
  normalizeDockOffset,
  dockX,
  dockY,
  collapsedSize,
  expandedSize,
  windowBounds,
  dockFromPoint
};

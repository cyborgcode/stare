// SPDX-FileCopyrightText: 2026 Stare contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// The dynamic island's state machine and its Cairo drawing. Pure JS with no GI
// imports, so the same code runs inside GNOME Shell (island.js), under plain
// gjs (scripts/render-island.js) and under node (scripts/test-island.mjs).
//
// The look recreates Glance's pill overlay (MIT, see THIRD_PARTY_NOTICES.md).
// Pill sizes and timings are Glance's NotchGeometry and NotchOverlayController
// values. The glyph geometry and its motion were measured frame by frame from
// Glance's 432x432, 60 fps scan clips, which is why the glyph lives in a
// 432-unit box and clip times below are written in frames.

export const ACCENT = [0xe9 / 255, 0x54 / 255, 0x20 / 255]; // Ubuntu orange

// Pill geometry, in logical pixels: five sixths of Glance's pill.
const CLOSED_WIDTH = 70;
const CLOSED_HEIGHT = 21;
const OPEN_SIZE = 150;
const OPEN_RADIUS = 40;
const TOP_GAP = 3;
const OFFSCREEN_SLACK = 17;
const CONTENT_PADDING = 27;
const SHADOW_OPACITY = 0.3;
const SHADOW_SPREAD = 15;
const SHADOW_STEPS = 9;
// The canvas the pill is drawn in: its open size plus room for the shadow and
// for the opening spring's overshoot.
const SHADOW_MARGIN = 20;
const OVERSHOOT_MARGIN = 6;
export const CANVAS_WIDTH = OPEN_SIZE + 2 * (SHADOW_MARGIN + OVERSHOOT_MARGIN);
export const CANVAS_HEIGHT =
  TOP_GAP + OPEN_SIZE + SHADOW_MARGIN + 2 * OVERSHOOT_MARGIN;

// Choreography, in seconds.
const SLIDE_DURATION = 0.25;
const ENTER_EXPAND_DELAY = 0.16;
const EXIT_SLIDE_DELAY = 0.18;
const SPRING_RESPONSE = 0.45;
const OPEN_DAMPING = 0.7;
const CLOSE_DAMPING = 1;
const COLLAPSE_DURATION = 0.7;
const SUCCESS_HOLD = 1.2;
const FAILURE_HOLD = 3.5;
// Like Glance, a scan nobody resolves closes on its own. A Gaze scan lasts at
// most 12 s, so this only fires if an end signal was missed.
const SCAN_TIMEOUT = 20;
const PULSE_START_DELAY = 0.6;
const PULSE_HALF_CYCLE = 0.4;
const PULSE_HOLD = 0.05;
const PULSE_SCALE = 0.97;
const PULSE_OPACITY = 0.65;
const PULSE_SETTLE = 0.2;
const TURN_SETTLE = 0.1;

// Glance's clips are 60 fps; Stare plays them half again as fast.
const CLIP_SPEED = 1.5;
const FPS = 60 * CLIP_SPEED;
const IDLE_FRAMES = 181;
const SUCCESS_FRAMES = 73;
const FAILURE_FRAMES = 91;

// Glyph geometry in the 432-unit box.
const BOX = 432;
const CENTER = BOX / 2;
const STROKE = 22.5;
const FRAME_WIDTH = 318.5;
const FRAME_HEIGHT = 305.5;
const FRAME_RADIUS = 48;
const RING_RADIUS = 161.25;
// Distance from the middle of a side to where a bracket's arm ends.
const GAP_ALONG_WIDTH = 95.25;
const GAP_ALONG_HEIGHT = 88.75;
const NOSE_PARALLAX = 1.7;
const FAILURE_DIM = 0.42;
const LINE_ROUND = 1; // cairo's ROUND for both line caps and line joins

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = (t) => 1 - (1 - clamp01(t)) ** 2;
const easeInOut = (t) => {
  const u = clamp01(t);
  return u * u * (3 - 2 * u);
};
const radians = (degrees) => (degrees * Math.PI) / 180;

// Step response of SwiftUI's .spring(response:dampingFraction:).
const spring = (t, damping) => {
  if (t <= 0) return 0;
  const w0 = (2 * Math.PI) / SPRING_RESPONSE;
  if (damping >= 1) return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  const wd = w0 * Math.sqrt(1 - damping * damping);
  return (
    1 -
    Math.exp(-damping * w0 * t) *
      (Math.cos(wd * t) + ((damping * w0) / wd) * Math.sin(wd * t))
  );
};

// Linear interpolation through [x, value] pairs sorted by x, clamped at both ends.
const keyed = (keys, x) => {
  if (x <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [x1, v1] = keys[i];
    if (x <= x1) {
      const [x0, v0] = keys[i - 1];
      return lerp(v0, v1, (x - x0) / (x1 - x0));
    }
  }
  return keys[keys.length - 1][1];
};

// Idle: the face looks right, then left, then ahead. Eye offset every 3 frames.
const IDLE_EYE_DX = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 8, 18, 25, 29, 32, 34, 35, 36,
  36, 36, 36, 36, 36, 36, 34, 27, 8, -8, -17, -22, -26, -28, -30, -30, -30,
  -30, -30, -30, -30, -30, -29, -20, -10, -4, -2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0,
].map((dx, i) => [i * 3, dx]);

// Resolve clips: brackets close into a ring (frames 3-14), which tumbles
// (14-44); success then draws a checkmark, failure dims, reopens and shakes.
const MORPH_RADIUS = [[3, FRAME_RADIUS], [12, 115], [14, RING_RADIUS]];
const MORPH_WIDTH = [[12, FRAME_WIDTH], [14, 2 * RING_RADIUS]];
const MORPH_HEIGHT = [[12, FRAME_HEIGHT], [14, 2 * RING_RADIUS]];
const UNMORPH_RADIUS = [[42, RING_RADIUS], [44, 120], [56, FRAME_RADIUS]];
const UNMORPH_WIDTH = [[42, 2 * RING_RADIUS], [44, FRAME_WIDTH]];
const UNMORPH_HEIGHT = [[42, 2 * RING_RADIUS], [44, FRAME_HEIGHT]];
const SPIN_START = 14;
const SPIN_END = 44;
// The ring's tilt away from the screen plane and the direction of its long axis.
const SPIN_TILT = [
  [14, 0], [16, 30], [18, 55], [19, 72], [20, 85], [21, 100], [22, 112],
  [24, 132], [26, 152], [28, 180], [30, 222], [31.5, 246], [33, 236],
  [35, 219], [37, 190], [38, 180],
];
const SPIN_AXIS = [
  [14, -8], [19, -15], [20, -17], [21, -28], [22, -37], [23, -47], [24, -58],
  [25, -68], [26, -80], [27, -86], [28, -90],
];
// A dimmer second ring turning about the vertical axis gives the gyroscope look.
const ECHO_TILT = [
  [15, 20], [17, 60], [19, 78], [21, 85], [23, 70], [25, 60], [26.5, 75],
  [28, 88], [30, 76], [32, 80], [34, 72], [36, 58], [38, 45], [41, 30],
];
const ECHO_ALPHA = [[15, 0], [17, 0.5], [34, 0.5], [38, 0.3], [41, 0]];
const HAZE_ALPHA = [[14, 0], [18, 0.1], [22, 0.14], [34, 0.1], [41, 0]];
const TRAIL_SAMPLES = 5;
const TRAIL_STEP = 0.5; // frames between motion-blur samples
const TRAIL_ALPHA = 0.2;
const CHECK_START = 45;
const CHECK_PROGRESS = [
  [45, 0], [47, 0.044], [49, 0.14], [51, 0.285], [53, 0.441], [55, 0.599],
  [57, 0.734], [59, 0.84], [61, 0.916], [63, 0.965], [65, 0.992], [67, 1],
];
const CHECK_DRAWN = 67; // frame where the checkmark is complete
const CHECK_POINTS = [[159, 225], [203.5, 269.5], [281, 178.5]];
const SHAKE_DX = [
  [48, 0], [55, 20], [62, -28], [68, 11], [76, -20], [79, -11], [82, -3],
  [85, 0],
];

const bracketFrame = () => ({
  width: FRAME_WIDTH,
  height: FRAME_HEIGHT,
  radius: FRAME_RADIUS,
  gap: 1,
});

const ringFrame = () => ({
  width: 2 * RING_RADIUS,
  height: 2 * RING_RADIUS,
  radius: RING_RADIUS,
  gap: 0,
});

const idleGlyph = (seconds) => {
  const frame = (seconds * FPS) % IDLE_FRAMES;
  return {
    alpha: 1,
    dx: 0,
    outline: bracketFrame(),
    features: { alpha: 1, eyeDx: keyed(IDLE_EYE_DX, frame) },
    spin: null,
    check: 0,
  };
};

const spinAt = (frame) => {
  const rings = [];
  const add = (f, alpha, echo) => {
    const echoAlpha = keyed(ECHO_ALPHA, f);
    if (echo && echoAlpha > 0)
      rings.push({
        tilt: keyed(ECHO_TILT, f),
        axis: -90,
        alpha: alpha * echoAlpha,
      });
    rings.push({ tilt: keyed(SPIN_TILT, f), axis: keyed(SPIN_AXIS, f), alpha });
  };
  for (let i = TRAIL_SAMPLES; i >= 1; i--) {
    const f = Math.max(SPIN_START, frame - i * TRAIL_STEP);
    add(f, TRAIL_ALPHA * (1 - i / (TRAIL_SAMPLES + 1)), false);
  }
  add(frame, 1, true);
  return { rings, haze: keyed(HAZE_ALPHA, frame) };
};

// Frames 0-44 are shared by the success and failure clips.
const resolveGlyph = (frame) => {
  const glyph = {
    alpha: 1,
    dx: 0,
    outline: null,
    features: null,
    spin: null,
    check: 0,
  };
  if (frame < SPIN_START) {
    glyph.outline = {
      width: keyed(MORPH_WIDTH, frame),
      height: keyed(MORPH_HEIGHT, frame),
      radius: keyed(MORPH_RADIUS, frame),
      gap: 1 - clamp01((frame - 3) / 9),
    };
    const alpha = 1 - clamp01((frame - 3) / 8) ** 1.7;
    if (alpha > 0) glyph.features = { alpha, eyeDx: 0 };
  } else if (frame < SPIN_END) {
    glyph.spin = spinAt(frame);
  } else {
    glyph.outline = ringFrame();
  }
  return glyph;
};

const successGlyph = (frame) => {
  const glyph = resolveGlyph(frame);
  if (frame >= CHECK_START) glyph.check = keyed(CHECK_PROGRESS, frame);
  return glyph;
};

const failureGlyph = (frame) => {
  const unmorph = UNMORPH_RADIUS[0][0];
  const glyph = resolveGlyph(Math.min(frame, unmorph));
  glyph.alpha = lerp(1, FAILURE_DIM, clamp01((frame - 40) / 2.5));
  if (frame < unmorph) return glyph;

  glyph.spin = null;
  glyph.outline = {
    width: keyed(UNMORPH_WIDTH, frame),
    height: keyed(UNMORPH_HEIGHT, frame),
    radius: keyed(UNMORPH_RADIUS, frame),
    gap: 1 - (1 - clamp01((frame - 47) / 11)) ** 1.83,
  };
  const alpha = clamp01((frame - 47) / 6);
  if (alpha > 0) glyph.features = { alpha, eyeDx: 0 };
  glyph.dx = keyed(SHAKE_DX, frame);
  return glyph;
};

// 0 at full size and opacity, 1 at the dimmed end of the scan's breathing pulse.
const pulseLevel = (seconds) => {
  const t = seconds - PULSE_START_DELAY;
  if (t <= 0) return 0;
  const phase = t % (2 * (PULSE_HALF_CYCLE + PULSE_HOLD));
  if (phase < PULSE_HALF_CYCLE) return easeInOut(phase / PULSE_HALF_CYCLE);
  if (phase < PULSE_HALF_CYCLE + PULSE_HOLD) return 1;
  if (phase < 2 * PULSE_HALF_CYCLE + PULSE_HOLD)
    return (
      1 - easeInOut((phase - PULSE_HALF_CYCLE - PULSE_HOLD) / PULSE_HALF_CYCLE)
    );
  return 0;
};

// The island's lifecycle. Every method takes the current time in seconds and
// is safe to call in any state, any number of times.
//
//   closed --scan--> scanning --succeed--> success --(hold)--> collapsing --> closed
//                        |--fail--> failure --(hold, or end, or a new scan)
//                        |--end--> collapsing
export class IslandModel {
  constructor() {
    this.state = "closed";
    // Set when the desktop's animations are off: states are shown at rest.
    this.reducedMotion = false;
    this._slide = { from: 0, to: 0, start: 0 };
    this._expand = { from: 0, to: 0, start: 0, damping: CLOSE_DAMPING };
    this._scanStart = 0;
    this._scanSeen = 0;
    this._scanFromDim = false;
    this._resolveStart = 0;
    this._turnAtResolve = 0;
    this._pulseAtResolve = 0;
    this._pendingScan = false;
    this._endRequested = false;
    this._collapseStart = 0;
    this._frozen = null;
  }

  // The camera is looking for a face.
  scan(now) {
    this._update(now);
    if (this.state === "success") return;
    if (this.state === "scanning") {
      this._scanSeen = now;
      return;
    }
    if (this.state === "failure") {
      // Let the failure clip finish, then look again without closing.
      this._pendingScan = true;
      this._endRequested = false;
      return;
    }
    this._open(now);
    this._startScanning(now, false);
  }

  // The face was verified.
  succeed(now) {
    this._update(now);
    if (this.state === "success") return;
    if (this.state === "closed" || this.state === "collapsing") this._open(now);
    this._resolve(now, "success");
  }

  // The attempt ended without a match. Only meaningful while scanning.
  fail(now) {
    this._update(now);
    if (this.state === "scanning") this._resolve(now, "failure");
  }

  // Authentication finished without saying how. Used for terminal prompts,
  // where PAM only reports that the stack passed: a scan still in progress
  // can only have ended in a match, anything else just closes.
  done(now) {
    this._update(now);
    if (this.state === "scanning") this._resolve(now, "success");
    else this.end(now);
  }

  // Seconds until the success clip has drawn its checkmark, 0 otherwise.
  successRemaining(now) {
    this._update(now);
    if (this.state !== "success" || this.reducedMotion) return 0;
    const drawn = this._resolveStart + CHECK_DRAWN / FPS;
    return Math.max(0, drawn - now);
  }

  // The prompt went away. A resolve animation in flight still plays out.
  end(now) {
    this._update(now);
    if (this.state === "scanning") {
      this._collapse(now);
    } else if (this.state === "failure") {
      this._endRequested = true;
      this._pendingScan = false;
    }
  }

  // Whether there is anything to show at `now`.
  active(now) {
    this._update(now);
    return this.state !== "closed";
  }

  // What to draw at `now`, or null while closed.
  frame(now) {
    if (!this.active(now)) return null;

    const { glyph, pulse } =
      this.state === "collapsing" ? this._frozen : this._content(now);
    const expand = this._expandAt(now);
    const open = clamp01(expand);
    return {
      slide: this._slideAt(now),
      expand,
      glyph,
      contentScale: lerp(0.3, 1, expand) * lerp(1, PULSE_SCALE, pulse),
      contentOpacity: open * lerp(1, PULSE_OPACITY, pulse),
    };
  }

  _update(now) {
    if (this.state === "scanning") {
      if (now >= this._scanSeen + SCAN_TIMEOUT) this._collapse(now);
    } else if (this.state === "success") {
      if (now >= this._resolveStart + SUCCESS_HOLD) this._collapse(now);
    } else if (this.state === "failure") {
      const clipDone = now >= this._resolveStart + FAILURE_FRAMES / FPS;
      if (clipDone && this._pendingScan) this._startScanning(now, true);
      else if (
        (clipDone && this._endRequested) ||
        now >= this._resolveStart + FAILURE_HOLD
      )
        this._collapse(now);
    }
    if (
      this.state === "collapsing" &&
      (this.reducedMotion || now >= this._collapseStart + COLLAPSE_DURATION)
    )
      this.state = "closed";
  }

  _slideAt(now) {
    const { from, to, start } = this._slide;
    if (this.reducedMotion) return to;
    return lerp(from, to, easeOut((now - start) / SLIDE_DURATION));
  }

  _expandAt(now) {
    const { from, to, start, damping } = this._expand;
    if (this.reducedMotion) return to;
    return lerp(from, to, spring(now - start, damping));
  }

  _open(now) {
    const slide = this.state === "closed" ? 0 : this._slideAt(now);
    const expand = this.state === "closed" ? 0 : this._expandAt(now);
    this._slide = { from: slide, to: 1, start: now };
    // The pill grows once it has slid most of the way in.
    this._expand = {
      from: expand,
      to: 1,
      start: now + ENTER_EXPAND_DELAY * (1 - slide),
      damping: OPEN_DAMPING,
    };
  }

  _collapse(now) {
    this._frozen = this._content(now);
    this._slide = {
      from: this._slideAt(now),
      to: 0,
      start: now + EXIT_SLIDE_DELAY,
    };
    this._expand = {
      from: this._expandAt(now),
      to: 0,
      start: now,
      damping: CLOSE_DAMPING,
    };
    this._collapseStart = now;
    this._pendingScan = false;
    this._endRequested = false;
    this.state = "collapsing";
  }

  _startScanning(now, fromDim) {
    this._scanStart = now;
    this._scanSeen = now;
    this._scanFromDim = fromDim;
    this._pendingScan = false;
    this._endRequested = false;
    this.state = "scanning";
  }

  _resolve(now, state) {
    const scanning = this.state === "scanning" && !this.reducedMotion;
    const seconds = now - this._scanStart;
    this._turnAtResolve = scanning ? idleGlyph(seconds).features.eyeDx : 0;
    this._pulseAtResolve = scanning ? pulseLevel(seconds) : 0;
    this._resolveStart = now;
    this._pendingScan = false;
    this._endRequested = false;
    this.state = state;
  }

  // The glyph and pulse of the scanning, success and failure states.
  _content(now) {
    if (this.state === "scanning") {
      const seconds = this.reducedMotion ? 0 : now - this._scanStart;
      const glyph = idleGlyph(seconds);
      if (this._scanFromDim && !this.reducedMotion)
        glyph.alpha = lerp(FAILURE_DIM, 1, clamp01(seconds / PULSE_SETTLE));
      return { glyph, pulse: pulseLevel(seconds) };
    }

    const success = this.state === "success";
    const last = (success ? SUCCESS_FRAMES : FAILURE_FRAMES) - 1;
    const seconds = now - this._resolveStart;
    const frame = this.reducedMotion ? last : Math.min(seconds * FPS, last);
    const glyph = success ? successGlyph(frame) : failureGlyph(frame);
    // The clips start from a face looking ahead: ease the head back first.
    if (glyph.features && !this.reducedMotion)
      glyph.features.eyeDx +=
        this._turnAtResolve * (1 - easeOut(seconds / TURN_SETTLE));
    const pulse = this._pulseAtResolve * (1 - easeOut(seconds / PULSE_SETTLE));
    return { glyph, pulse };
  }
}

const roundedRect = (cr, x, y, width, height, radius) => {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  cr.newSubPath();
  cr.arc(x + width - r, y + r, r, -Math.PI / 2, 0);
  cr.arc(x + width - r, y + height - r, r, 0, Math.PI / 2);
  cr.arc(x + r, y + height - r, r, Math.PI / 2, Math.PI);
  cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
  cr.closePath();
};

// One quarter of the outline, centred on the origin: from the middle of the top
// side, round the top-left corner, to the middle of the left side. Only the
// stretch between `from` and `to` (distances along that path) is added.
const outlineQuarter = (cr, { width, height, radius }, from, to) => {
  const r = Math.min(radius, width / 2, height / 2);
  const top = width / 2 - r;
  const corner = (Math.PI / 2) * r;
  const end = Math.min(to, top + corner + height / 2 - r);
  if (from >= end) return;

  cr.newSubPath();
  if (from < top) {
    cr.moveTo(-from, -height / 2);
    cr.lineTo(-Math.min(end, top), -height / 2);
  }
  if (end > top && from < top + corner) {
    const a0 = (Math.max(from, top) - top) / r;
    const a1 = (Math.min(end, top + corner) - top) / r;
    cr.arcNegative(
      -width / 2 + r,
      -height / 2 + r,
      r,
      -Math.PI / 2 - a0,
      -Math.PI / 2 - a1,
    );
  }
  if (end > top + corner) {
    const start = Math.max(from, top + corner);
    if (start > top + corner)
      cr.moveTo(-width / 2, -height / 2 + r + start - top - corner);
    cr.lineTo(-width / 2, -height / 2 + r + end - top - corner);
  }
};

// The Face ID brackets (gap 1), closing into one rounded outline (gap 0).
const drawOutline = (cr, outline) => {
  const r = Math.min(outline.radius, outline.width / 2, outline.height / 2);
  const length =
    outline.width / 2 - r + (Math.PI / 2) * r + outline.height / 2 - r;
  const from = outline.gap * GAP_ALONG_WIDTH;
  const to = length - outline.gap * GAP_ALONG_HEIGHT;
  for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    cr.save();
    cr.translate(CENTER, CENTER);
    cr.scale(sx, sy);
    outlineQuarter(cr, outline, from, to);
    cr.restore();
  }
  cr.stroke();
};

const drawFeatures = (cr, { alpha, eyeDx }) => {
  const noseDx = eyeDx * NOSE_PARALLAX;
  cr.pushGroup();
  cr.setSourceRGB(...ACCENT);
  for (const x of [145, 294]) {
    cr.moveTo(x + eyeDx, 141);
    cr.lineTo(x + eyeDx, 181);
  }
  cr.moveTo(228 + noseDx, 141);
  cr.lineTo(198 + noseDx, 231);
  cr.lineTo(228 + noseDx, 231);
  cr.moveTo(140 + eyeDx, 273.5);
  cr.curveTo(171 + eyeDx, 313.5, 265.5 + eyeDx, 313.5, 297.5 + eyeDx, 273.5);
  cr.stroke();
  cr.popGroupToSource();
  cr.paintWithAlpha(alpha);
};

const drawSpin = (cr, { rings, haze }) => {
  if (haze > 0) {
    // A soft glow standing in for the clip's motion-blurred sphere.
    const steps = 6;
    cr.setSourceRGBA(...ACCENT, haze / steps);
    for (let i = 1; i <= steps; i++) {
      cr.newSubPath();
      cr.arc(CENTER, CENTER, RING_RADIUS * lerp(0.55, 1, i / steps), 0, 2 * Math.PI);
      cr.fill();
    }
  }
  for (const { tilt, axis, alpha } of rings) {
    cr.save();
    cr.translate(CENTER, CENTER);
    cr.rotate(radians(axis));
    cr.scale(1, Math.max(Math.abs(Math.cos(radians(tilt))), 0.015));
    cr.newSubPath();
    cr.arc(0, 0, RING_RADIUS, 0, 2 * Math.PI);
    cr.closePath();
    cr.restore();
    cr.setSourceRGBA(...ACCENT, alpha);
    cr.stroke();
  }
};

const drawCheck = (cr, progress) => {
  const [start, corner, end] = CHECK_POINTS;
  const first = Math.hypot(corner[0] - start[0], corner[1] - start[1]);
  const second = Math.hypot(end[0] - corner[0], end[1] - corner[1]);
  const drawn = progress * (first + second);
  cr.moveTo(...start);
  if (drawn <= first) {
    const t = Math.max(drawn, 0.01) / first;
    cr.lineTo(lerp(start[0], corner[0], t), lerp(start[1], corner[1], t));
  } else {
    const t = (drawn - first) / second;
    cr.lineTo(...corner);
    cr.lineTo(lerp(corner[0], end[0], t), lerp(corner[1], end[1], t));
  }
  cr.stroke();
};

const drawGlyph = (cr, glyph) => {
  cr.setLineWidth(STROKE);
  cr.setLineCap(LINE_ROUND);
  cr.setLineJoin(LINE_ROUND);
  cr.translate(glyph.dx, 0);
  if (glyph.spin) drawSpin(cr, glyph.spin);
  cr.setSourceRGB(...ACCENT);
  if (glyph.outline) drawOutline(cr, glyph.outline);
  if (glyph.features) drawFeatures(cr, glyph.features);
  cr.setSourceRGB(...ACCENT);
  if (glyph.check > 0) drawCheck(cr, glyph.check);
};

// Draws one frame from IslandModel.frame() into a canvas of CANVAS_WIDTH by
// CANVAS_HEIGHT logical pixels whose top edge is the top of the monitor.
export const drawIsland = (cr, frame) => {
  const { expand, slide, glyph } = frame;
  const open = clamp01(expand);
  const width = lerp(CLOSED_WIDTH, OPEN_SIZE, expand);
  const height = lerp(CLOSED_HEIGHT, OPEN_SIZE, expand);
  const radius = lerp(CLOSED_HEIGHT / 2, OPEN_RADIUS, expand);
  const x = (CANVAS_WIDTH - width) / 2;
  const y = lerp(-(CLOSED_HEIGHT + OFFSCREEN_SLACK), TOP_GAP, slide);

  if (open > 0) {
    // Stacked translucent outlines approximate a blurred drop shadow.
    cr.setSourceRGBA(0, 0, 0, 1 - (1 - SHADOW_OPACITY * open) ** (1 / SHADOW_STEPS));
    for (let i = 1; i <= SHADOW_STEPS; i++) {
      const grow = (SHADOW_SPREAD * i) / SHADOW_STEPS;
      roundedRect(cr, x - grow, y - grow, width + 2 * grow, height + 2 * grow, radius + grow);
      cr.fill();
    }
  }

  roundedRect(cr, x, y, width, height, radius);
  cr.setSourceRGB(0, 0, 0);
  cr.fillPreserve();
  if (frame.contentOpacity <= 0) {
    cr.newPath();
    return;
  }

  cr.save();
  cr.clip();
  cr.translate(x + width / 2, y + height / 2);
  const scale = (frame.contentScale * (OPEN_SIZE - 2 * CONTENT_PADDING)) / BOX;
  cr.scale(scale, scale);
  cr.translate(-CENTER, -CENTER);
  cr.pushGroup();
  drawGlyph(cr, glyph);
  cr.popGroupToSource();
  cr.paintWithAlpha(frame.contentOpacity * glyph.alpha);
  cr.restore();
};

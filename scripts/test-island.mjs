// SPDX-FileCopyrightText: 2026 Stare contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Run with: node scripts/test-island.mjs
// Exercises the island's state machine and drawing maths without GNOME Shell.
// The real Cairo output is covered by scripts/render-island.js.
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {IslandModel, drawIsland} from '../integrations/gnome-shell/islandDrawing.js';

const FAILURE_CLIP = 91 / 60;
const SUCCESS_HOLD = 1.7;
const FAILURE_HOLD = 5;
const COLLAPSE = 0.7;

// A cairo context that accepts any call but rejects non-finite arguments.
function fakeCairo() {
    const calls = [];
    const cr = new Proxy({}, {
        get: (_, name) => (...args) => {
            for (const arg of args)
                assert.ok(Number.isFinite(arg), `${String(name)}(${args}) at call ${calls.length}`);
            calls.push(name);
        },
    });
    return {cr, calls};
}

test('closed until asked to scan', () => {
    const model = new IslandModel();
    assert.equal(model.frame(0), null);
    model.fail(0);
    model.end(0);
    assert.equal(model.frame(1), null);
});

test('scan slides in, then expands into the face glyph', () => {
    const model = new IslandModel();
    model.scan(10);
    const first = model.frame(10);
    assert.equal(first.slide, 0);
    assert.equal(first.expand, 0);
    const open = model.frame(11.5);
    assert.equal(open.slide, 1);
    assert.ok(Math.abs(open.expand - 1) < 0.01, `expand ${open.expand}`);
    assert.equal(open.glyph.outline.gap, 1);
    assert.equal(open.glyph.features.alpha, 1);
    assert.equal(model.state, 'scanning');
});

test('repeated scans do not restart the scan', () => {
    const model = new IslandModel();
    model.scan(0);
    const before = model.frame(2).glyph.features.eyeDx;
    model.scan(2);
    assert.equal(model.frame(2).glyph.features.eyeDx, before);
});

test('a scan nobody resolves closes on its own', () => {
    const model = new IslandModel();
    model.scan(0);
    assert.equal(model.active(19.9), true);
    assert.equal(model.state, 'scanning');
    model.active(20.1);
    assert.equal(model.state, 'collapsing');

    const kept = new IslandModel();
    kept.scan(0);
    kept.scan(15); // Gaze reported scan progress
    kept.active(25);
    assert.equal(kept.state, 'scanning');
});

test('success draws the check, holds, then closes', () => {
    const model = new IslandModel();
    model.scan(0);
    model.succeed(2);
    assert.equal(model.frame(2 + 0.5).glyph.spin !== null, true, 'ring is spinning');
    const done = model.frame(2 + 1.3).glyph;
    assert.equal(done.check, 1);
    assert.equal(done.outline.gap, 0);
    model.end(2 + 1.3);
    assert.equal(model.state, 'success', 'end lets the success play out');
    assert.equal(model.active(2 + SUCCESS_HOLD - 0.01), true);
    assert.equal(model.active(2 + SUCCESS_HOLD + 0.01), true);
    assert.equal(model.state, 'collapsing');
    assert.equal(model.active(2 + SUCCESS_HOLD + COLLAPSE + 0.05), false);
});

test('done turns a scan into a success and closes anything else', () => {
    const scanning = new IslandModel();
    scanning.scan(0);
    scanning.done(2);
    assert.equal(scanning.state, 'success');

    const failed = new IslandModel();
    failed.scan(0);
    failed.fail(2);
    failed.done(3); // the password was accepted after the face failed
    assert.equal(failed.state, 'failure');
    failed.active(2 + FAILURE_CLIP + 0.01);
    assert.equal(failed.state, 'collapsing');

    const closed = new IslandModel();
    closed.done(0);
    assert.equal(closed.state, 'closed');
});

test('successRemaining counts down to the finished checkmark', () => {
    const model = new IslandModel();
    assert.equal(model.successRemaining(0), 0);
    model.scan(0);
    assert.equal(model.successRemaining(1), 0);
    model.succeed(1);
    assert.ok(Math.abs(model.successRemaining(1) - 67 / 60) < 1e-9);
    assert.equal(model.frame(1 + 67 / 60).glyph.check, 1);
    assert.equal(model.successRemaining(1 + 67 / 60), 0);

    const reduced = new IslandModel();
    reduced.reducedMotion = true;
    reduced.succeed(0);
    assert.equal(reduced.successRemaining(0), 0);
});

test('success is shown even if the scan was never announced', () => {
    const model = new IslandModel();
    model.succeed(0);
    assert.equal(model.state, 'success');
    assert.equal(model.frame(1.3).glyph.check, 1);
});

test('failure dims, shakes, holds, then closes', () => {
    const model = new IslandModel();
    model.scan(0);
    model.fail(2);
    const shaking = model.frame(2 + 55 / 60).glyph;
    assert.ok(shaking.dx > 15, `shake ${shaking.dx}`);
    const rest = model.frame(2 + 2).glyph;
    assert.equal(rest.dx, 0);
    assert.ok(Math.abs(rest.alpha - 0.42) < 1e-9, `alpha ${rest.alpha}`);
    assert.equal(rest.outline.gap, 1);
    assert.equal(model.active(2 + FAILURE_HOLD - 0.01), true);
    assert.equal(model.state, 'failure');
    assert.equal(model.active(2 + FAILURE_HOLD + 0.01), true);
    assert.equal(model.state, 'collapsing');
    assert.equal(model.active(2 + FAILURE_HOLD + COLLAPSE + 0.05), false);
});

test('fail is ignored unless scanning', () => {
    const model = new IslandModel();
    model.scan(0);
    model.succeed(1);
    model.fail(1.1);
    assert.equal(model.state, 'success');
});

test('a retry during the failure clip resumes scanning without closing', () => {
    const model = new IslandModel();
    model.scan(0);
    model.fail(2);
    model.scan(2.5);
    assert.equal(model.state, 'failure', 'the clip finishes first');
    const frame = model.frame(2 + FAILURE_CLIP + 0.01);
    assert.equal(model.state, 'scanning');
    assert.equal(frame.expand > 0.99, true);
    assert.ok(frame.glyph.alpha < 0.5, 'brightens from the dimmed glyph');
    assert.equal(model.frame(2 + FAILURE_CLIP + 0.3).glyph.alpha, 1);
});

test('end closes a scan at once and a failure after its clip', () => {
    const scanning = new IslandModel();
    scanning.scan(0);
    scanning.end(2);
    assert.equal(scanning.state, 'collapsing');
    assert.equal(scanning.active(2 + COLLAPSE + 0.05), false);

    const failed = new IslandModel();
    failed.scan(0);
    failed.fail(2);
    failed.end(2.1);
    assert.equal(failed.active(2 + FAILURE_CLIP - 0.01), true);
    assert.equal(failed.state, 'failure');
    failed.active(2 + FAILURE_CLIP + 0.01);
    assert.equal(failed.state, 'collapsing');
});

test('a scan while collapsing reopens from where the pill is', () => {
    const model = new IslandModel();
    model.scan(0);
    model.end(2);
    const mid = model.frame(2.1).expand;
    assert.ok(mid > 0 && mid < 1, `expand ${mid}`);
    model.scan(2.1);
    assert.equal(model.state, 'scanning');
    assert.ok(Math.abs(model.frame(2.1).expand - mid) < 1e-9);
    assert.ok(Math.abs(model.frame(3.5).expand - 1) < 0.01);
});

test('reduced motion shows each state at rest', () => {
    const model = new IslandModel();
    model.reducedMotion = true;
    model.scan(0);
    const scanning = model.frame(0);
    assert.equal(scanning.expand, 1);
    assert.equal(scanning.slide, 1);
    assert.equal(scanning.glyph.features.eyeDx, 0);
    assert.equal(model.frame(7).glyph.features.eyeDx, 0);
    model.succeed(1);
    assert.equal(model.frame(1).glyph.check, 1);
    assert.equal(model.active(1 + SUCCESS_HOLD + 0.01), false);
});

test('every frame of a full session is drawable', () => {
    const model = new IslandModel();
    const script = [[0.2, 'scan'], [2.6, 'fail'], [4.9, 'scan'], [7.3, 'succeed'], [7.4, 'end']];
    let frames = 0;
    for (let i = 0; i < 60 * 12; i++) {
        const now = i / 60;
        while (script.length && script[0][0] <= now) model[script.shift()[1]](now);
        const frame = model.frame(now);
        if (!frame) continue;
        frames++;
        assert.ok(frame.expand > -0.05 && frame.expand < 1.1, `expand ${frame.expand} at ${now}`);
        assert.ok(frame.contentOpacity >= 0 && frame.contentOpacity <= 1);
        const {cr, calls} = fakeCairo();
        drawIsland(cr, frame);
        assert.ok(calls.includes('fillPreserve'), 'the pill is drawn');
        assert.equal(calls.filter(c => c === 'save').length, calls.filter(c => c === 'restore').length);
        assert.equal(calls.filter(c => c === 'pushGroup').length,
            calls.filter(c => c === 'popGroupToSource').length);
    }
    assert.ok(frames > 500, `${frames} frames`);
    assert.equal(model.state, 'closed');
});

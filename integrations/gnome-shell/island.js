// SPDX-FileCopyrightText: 2026 Stare contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import St from "gi://St";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  IslandModel,
  drawIsland,
} from "./islandDrawing.js";

// The longest step the animation clock takes between two frames. When the
// shell stalls (an unlock enables every other extension at once), the island
// slows down instead of jumping ahead and skipping part of its animation.
const MAX_STEP = 1 / 20;

// The on-screen island: a click-through canvas at the top centre of the
// primary monitor, above the lock screen, the panel and modal dialogs. It is
// only visible, and only repaints, while the model has something to show.
export class Island {
  constructor() {
    this._model = new IslandModel();
    this._clock = 0;
    this._lastTick = null;
    this._area = new St.DrawingArea({ reactive: false, visible: false });
    this._area.connect("repaint", () => this._repaint());
    Main.uiGroup.add_child(this._area);

    // The duration is irrelevant: the timeline is only a per-frame tick.
    this._timeline = new Clutter.Timeline({
      actor: this._area,
      duration: 1000,
      repeat_count: -1,
    });
    this._timeline.connect("new-frame", () => this._sync());
  }

  scan() {
    this._drive("scan");
  }

  succeed() {
    this._drive("succeed");
  }

  fail() {
    this._drive("fail");
  }

  end() {
    this._drive("end");
  }

  done() {
    this._drive("done");
  }

  // Seconds until a success animation has drawn its checkmark.
  successRemaining() {
    return this._model.successRemaining(this._now());
  }

  destroy() {
    this._timeline.stop();
    this._timeline = null;
    this._area.destroy();
    this._area = null;
  }

  _now() {
    const real = GLib.get_monotonic_time() / 1e6;
    if (this._lastTick !== null)
      this._clock += Math.min(Math.max(real - this._lastTick, 0), MAX_STEP);
    this._lastTick = real;
    return this._clock;
  }

  _drive(event) {
    this._model.reducedMotion = !St.Settings.get().enable_animations;
    this._model[event](this._now());
    this._sync();
  }

  _sync() {
    if (!this._model.active(this._now())) {
      this._timeline.stop();
      this._area.hide();
      return;
    }

    if (!this._area.visible) {
      this._place();
      Main.uiGroup.set_child_above_sibling(this._area, null);
      this._area.show();
    }
    if (!this._timeline.is_playing()) this._timeline.start();
    this._area.queue_repaint();
  }

  _place() {
    const monitor = Main.layoutManager.primaryMonitor;
    if (!monitor) return;

    const { scale_factor: scale } = St.ThemeContext.get_for_stage(global.stage);
    const width = CANVAS_WIDTH * scale;
    this._area.set_size(width, CANVAS_HEIGHT * scale);
    this._area.set_position(
      monitor.x + Math.round((monitor.width - width) / 2),
      monitor.y,
    );
  }

  _repaint() {
    const cr = this._area.get_context();
    try {
      const frame = this._model.frame(this._now());
      if (!frame) return;

      const [width] = this._area.get_surface_size();
      cr.scale(width / CANVAS_WIDTH, width / CANVAS_WIDTH);
      drawIsland(cr, frame);
    } finally {
      cr.$dispose();
    }
  }
}

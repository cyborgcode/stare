// SPDX-FileCopyrightText: 2026 Stare contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Run with: gjs -m scripts/render-island.js <out-dir> [device-scale]
// Renders the island through a scan, a failed attempt, a retry and a success
// to <out-dir>/f_0000.png onwards at 60 fps, without needing GNOME Shell.
// Turn the frames into a video with, for example:
//   ffmpeg -framerate 60 -i <out-dir>/f_%04d.png -pix_fmt yuv420p island.mp4
import Cairo from "cairo";
import GLib from "gi://GLib";

import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  IslandModel,
  drawIsland,
} from "../integrations/gnome-shell/islandDrawing.js";

const FPS = 60;
const BACKDROP = [0.17, 0.0, 0.12]; // Ubuntu aubergine, so the black pill shows
const SCRIPT = [
  [0.2, "scan"],
  [2.6, "fail"],
  [4.9, "scan"],
  [7.3, "succeed"],
];

const [outDir, scaleArg] = ARGV;
if (!outDir) {
  printerr("usage: gjs -m scripts/render-island.js <out-dir> [device-scale]");
  imports.system.exit(2);
}
const scale = Number(scaleArg ?? 2);
GLib.mkdir_with_parents(outDir, 0o755);

const model = new IslandModel();
const pending = [...SCRIPT];
let count = 0;
for (let i = 0; ; i++) {
  const now = i / FPS;
  while (pending.length && pending[0][0] <= now) model[pending.shift()[1]](now);
  const frame = model.frame(now);
  if (!frame && !pending.length) break;

  const surface = new Cairo.ImageSurface(
    Cairo.Format.ARGB32,
    Math.ceil(CANVAS_WIDTH * scale),
    Math.ceil(CANVAS_HEIGHT * scale),
  );
  const cr = new Cairo.Context(surface);
  cr.scale(scale, scale);
  cr.setSourceRGB(...BACKDROP);
  cr.paint();
  if (frame) drawIsland(cr, frame);
  cr.$dispose();
  surface.writeToPNG(`${outDir}/f_${String(i).padStart(4, "0")}.png`);
  count++;
}
print(`rendered ${count} frames to ${outDir}`);

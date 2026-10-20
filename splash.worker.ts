// The CLI splash, drawn on a thread of its own: the first read of huge sessions blocks the main thread for seconds
// at a time, and the streak across the logo should keep its pace all the same. The main thread posts what it is
// doing ({ doing, done, total }); this draws a frame every 33 ms while the streak sweeps, and when the words change.
// Told to finish, it lets the sweep run to its end, says "done", and the main thread takes the screen back.
import * as fs from "node:fs";
import { shineAt, splashScreen } from "./fleet.ts";

declare const self: Worker;
let from = Date.now(), cols = 140, rows = 45, doing = "starting", done = 0, total = 0, finishing = false, drawn = "";
self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === "start") ({ from, cols, rows } = m);
  else if (m.type === "state") ({ doing, done, total } = m);
  else if (m.type === "finish") finishing = true;
};
const tick = setInterval(() => {
  const shine = shineAt(Date.now() - from);
  if (finishing && shine === undefined) {
    clearInterval(tick);
    postMessage("done");
    return;
  }
  const frame = splashScreen(cols, rows, doing, done, total, shine).map((l) => l + "\x1b[K").join("\r\n");
  if (frame === drawn) return; // between sweeps, only a change of words is drawn
  drawn = frame;
  try {
    fs.writeSync(1, "\x1b[H" + frame);
  } catch {}
}, 33);
postMessage("ready");

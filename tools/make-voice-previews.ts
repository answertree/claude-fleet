#!/usr/bin/env bun
// Makes the voice previews that come with fleet: voices/<voice>.m4a, each GPT-Live voice saying hello in its own
// language, so the picker plays them at once. They are the API's output, made with your key (OpenAI's terms make
// output yours), and AI-generated. Needs OPENAI_API_KEY (or fleet's .env), and macOS for afconvert. Four voices at a
// time, a few seconds of GPT-Live each. Existing previews are kept unless --force.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as F from "../fleet.ts";

const force = process.argv.includes("--force");
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const todo = (only.length ? only : F.LIVE_VOICES).filter((v) => force || !fs.existsSync(F.voicePreviewFile(v)));
if (!F.openAIKey()) throw new Error("no OpenAI key: put OPENAI_API_KEY in fleet's .env");
fs.mkdirSync(path.dirname(F.voicePreviewFile("x")), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-voices-"));
const make = async (v: string) => {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let said = "";
    const pcm = await F.recordVoice(v, F.voiceHello(v), F.openAIKey(), (t) => (said = t));
    if (!pcm) continue;
    const wav = path.join(tmp, `${v}.wav`);
    fs.writeFileSync(wav, F.pcmToWav(pcm));
    const out = spawnSync("afconvert", ["-f", "m4af", "-d", "aac", "-b", "48000", wav, F.voicePreviewFile(v)]);
    if (out.status === 0) return void process.stdout.write(`${v}: ${(pcm.length / 48_000).toFixed(1)} s, ${fs.statSync(F.voicePreviewFile(v)).size} bytes: "${said}"\n`);
  }
  process.stdout.write(`${v}: could not make a preview\n`);
};
for (let i = 0; i < todo.length; i += 4) await Promise.all(todo.slice(i, i + 4).map(make));
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);

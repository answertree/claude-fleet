// Starts the background commands fleet asks for (git, gh, ps, vm_stat, tailscale), on a thread of its own. When the
// Mac is heavily loaded, starting a program can take a second, and the thread that starts it waits all that time; here
// that thread is this one, so the page and the bot are never held by it. Each request: { id, cmd, args, timeoutMs };
// each answer: { id, code, out } (code null when it could not run, or was stopped at its time).
declare const self: Worker;
const LIMIT = 4 << 20;
self.onmessage = async (e: MessageEvent) => {
  const { id, cmd, args, timeoutMs } = e.data as { id: number; cmd: string; args: string[]; timeoutMs: number };
  try {
    const p = Bun.spawn([cmd, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    let killed = false;
    const timer = setTimeout(() => ((killed = true), p.kill()), timeoutMs);
    const out = await new Response(p.stdout).text();
    const code = await p.exited;
    clearTimeout(timer);
    postMessage({ id, code: killed ? null : code, out: out.length > LIMIT ? out.slice(0, LIMIT) : out });
  } catch {
    postMessage({ id, code: null, out: "" });
  }
};

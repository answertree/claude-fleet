// The background service's scan, on a thread of its own: reading transcripts can take seconds (a cold start, a loaded
// Mac, a session with thousands of agents), and the thread that answers the phone page and the Telegram bot must never
// wait on it. Asked { now, budget, opt }, it scans and answers { text, pending, justRead }: the sessions as other
// machines get them (Maps written out), less the remote stamp, since they are this machine's own.
import { encodeSessions, opt, scan, scanPending, setScanBudget, takeJustRead } from "./fleet.ts";

declare const self: Worker;
self.onmessage = (e: MessageEvent) => {
  const { now, budget, options, env } = e.data as { now: number; budget: number; options: Partial<typeof opt>; env: Record<string, string> };
  Object.assign(process.env, env); // as the fleet's thread has it now
  Object.assign(opt, options);
  setScanBudget(budget);
  const list = scan(now);
  postMessage({ text: encodeSessions(list, now, false), pending: scanPending, justRead: [...takeJustRead()] });
};

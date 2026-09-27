// Running programs inside VMs through the QEMU guest agent.

import { pve, sleep } from './pve.js';

// Answers that mean "the agent is busy or briefly unreachable", not "the command
// failed", e.g. "VM 102 qga command 'guest-exec-status' failed - got timeout".
// The agent stalls for a moment while the guest is busy (installers adding
// network adapters, heavy disk I/O, Windows setup); the command keeps running.
const TRANSIENT = /got timeout|timed? ?out|guest agent is not running|not running/i;

// How long the agent may stay silent before a command is given up.
const graceMs = () => Number(process.env.AGENT_UNRESPONSIVE_SECONDS || 180) * 1000;

/**
 * Runs a program inside the guest and waits for it to exit.
 * `input` is passed on stdin ("input-data"), so secrets never appear on a command line.
 */
export async function agentExec(path, command, timeoutMs = 120_000, input = undefined) {
  const { pid } = await pve.post(`${path}/agent/exec`, { command, 'input-data': input });

  // A silent agent doesn't eat into the command's own time budget.
  let end = Date.now() + timeoutMs;
  let silentSince = null;
  let lastError = null;
  let delay = 1500;

  for (;;) {
    await sleep(delay);
    let status;
    try {
      status = await pve.get(`${path}/agent/exec-status`, { pid });
    } catch (err) {
      if (!TRANSIENT.test(err.message)) throw err;
      lastError = err;
      silentSince ??= Date.now();
      if (Date.now() - silentSince > graceMs()) {
        throw new Error('The QEMU guest agent in the server stopped responding '
          + `(${lastError.message}). Check that the server isn't overloaded or hung, then try again.`);
      }
      delay = Math.min(delay * 1.5, 10_000); // back off while it's busy
      continue;
    }
    if (silentSince) {
      end += Date.now() - silentSince;
      silentSince = null;
      delay = 1500;
    }
    if (status.exited) {
      return { code: status.exitcode ?? 0, out: status['out-data'] ?? '', err: status['err-data'] ?? '' };
    }
    if (Date.now() > end) throw new Error('A command inside the VM did not finish in time');
  }
}

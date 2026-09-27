// Running programs inside VMs through the QEMU guest agent.

import { pve, sleep } from './pve.js';

// Answers that mean "the agent is busy or briefly unreachable", not "the command
// failed", e.g. "VM 102 qga command 'guest-exec-status' failed - got timeout".
// The agent stalls for a moment while the guest is busy (installers adding
// network adapters, heavy disk I/O, Windows setup); the command keeps running.
const TRANSIENT = /got timeout|timed? ?out|guest agent is not running|not running/i;

// The agent reports a finished process only ONCE and then forgets it. If that one
// answer arrived too late at Proxmox (reported as a timeout above), the next
// question gets "PID … does not exist" (Windows agents print a literal "PID lld").
// The command did run; only its result is lost.
const LOST = /PID\s+\S+\s+does not exist/i;

// How long the agent may stay silent before a command is given up.
const graceMs = () => Number(process.env.AGENT_UNRESPONSIVE_SECONDS || 180) * 1000;

/** The command ran, but its exit code and output are unknown. */
export class AgentResultLost extends Error {
  constructor() {
    super('The command inside the server finished, but the QEMU guest agent lost its result');
    this.name = 'AgentResultLost';
  }
}

async function runOnce(path, command, timeoutMs, input) {
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
      if (LOST.test(err.message)) throw new AgentResultLost();
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

/**
 * Runs a program inside the guest and waits for it to exit.
 *
 * retryIfLost (default true): if the agent lost the result, run the command once
 * more and use that result. Only for commands that are safe to repeat (checks,
 * idempotent installs, writing a file). Pass false for one-shot commands (e.g.
 * using up a one-time key); they get AgentResultLost and must check the state
 * themselves.
 */
export async function agentExec(path, command, timeoutMs = 120_000, input = undefined, { retryIfLost = true } = {}) {
  try {
    return await runOnce(path, command, timeoutMs, input);
  } catch (err) {
    if (!(err instanceof AgentResultLost) || !retryIfLost) throw err;
    return runOnce(path, command, timeoutMs, input); // a second loss propagates
  }
}

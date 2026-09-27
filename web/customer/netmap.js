// The customer's network drawn as a map: their private network is the hub,
// servers are nodes around it (coloured by status), the VPN sits on top.
// Returns an SVG string; nodes carry data-vmid / data-open for click handling.

import { esc } from '/shared/ui.js';

const W = 720, H = 330, CX = 360, CY = 172, RX = 262, RY = 104;
const MAX_NODES = 11;

// Neutral glyph paths inside a 24x24 box (same shapes as icons.js).
const GLYPH = {
  windows: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M3 9h18M6 6.8h.01M8.5 6.8h.01"/>',
  linux: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7 10l2.5 2L7 14M11.5 14.5H16"/>',
  server: '<rect x="3.5" y="4" width="17" height="7" rx="2"/><rect x="3.5" y="13" width="17" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  shield: '<path d="M12 3l7 3v5.5c0 4.2-2.9 7.9-7 9-4.1-1.1-7-4.8-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
  more: '<path d="M6 12h.01M12 12h.01M18 12h.01"/>',
};

const glyph = (name, x, y, size = 20) =>
  `<svg x="${x - size / 2}" y="${y - size / 2}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${GLYPH[name]}</svg>`;

const short = (s, n = 16) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function statusOf(vm, busy) {
  if (vm.state === 'failed') return 'failed';
  if (vm.state !== 'ready' || busy.has(vm.vmid)) return 'busy';
  return vm.status === 'running' ? 'running' : 'stopped';
}

const STATUS_WORD = { running: 'running', stopped: 'stopped', busy: 'working', failed: 'setup failed' };

/**
 * @param {object} p
 * @param {Array} p.vms           server summaries from /api/vms
 * @param {object|null} p.network { subnet } or null
 * @param {object|null} p.vpn     { enabled, devices:[{lastHandshake}] } or null
 * @param {Set} p.busy            vmids with a running action
 * @param {boolean} p.animate     play the one-time draw-in
 */
export function netMap({ vms, network, vpn, busy, animate }) {
  const shown = vms.slice(0, vms.length > MAX_NODES + 1 ? MAX_NODES : MAX_NODES + 1);
  const extra = vms.length - shown.length;
  const count = shown.length + (extra > 0 ? 1 : 0);
  const withVpn = !!vpn?.enabled;

  // Spread nodes around the hub; leave the top free for the VPN node.
  const start = withVpn ? -55 : -90, span = withVpn ? 290 : 360;
  const pos = (i) => {
    const deg = withVpn ? start + (span * (i + 0.5)) / count : start + (span * i) / count;
    const rad = (deg * Math.PI) / 180;
    return { x: CX + RX * Math.cos(rad), y: CY + RY * Math.sin(rad) };
  };

  const edges = [];
  const nodes = [];

  shown.forEach((vm, i) => {
    const p = pos(i);
    const st = statusOf(vm, busy);
    edges.push(`<line class="edge edge-${st}" x1="${CX}" y1="${CY}" x2="${p.x.toFixed(1)}" y2="${p.y.toFixed(1)}" style="--i:${i}"/>`);
    nodes.push(`
      <g class="map-node node-${st}" data-vmid="${vm.vmid}" tabindex="0" role="button" style="--i:${i}"
         aria-label="${esc(vm.name)}, ${STATUS_WORD[st]}. Open server.">
        <circle class="halo" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="29"/>
        <circle class="disc" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="23"/>
        <g class="glyph">${glyph(vm.os === 'windows' ? 'windows' : vm.os === 'linux' ? 'linux' : 'server', p.x, p.y)}</g>
        <circle class="dot" cx="${(p.x + 16).toFixed(1)}" cy="${(p.y - 16).toFixed(1)}" r="5.5"/>
        <text class="node-name" x="${p.x.toFixed(1)}" y="${(p.y + 44).toFixed(1)}" text-anchor="middle">${esc(short(vm.name))}</text>
      </g>`);
  });

  if (extra > 0) {
    const p = pos(shown.length);
    edges.push(`<line class="edge edge-stopped" x1="${CX}" y1="${CY}" x2="${p.x.toFixed(1)}" y2="${p.y.toFixed(1)}"/>`);
    nodes.push(`
      <g class="map-node node-more">
        <circle class="disc" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="23"/>
        <text class="node-name" x="${p.x.toFixed(1)}" y="${(p.y + 5).toFixed(1)}" text-anchor="middle">+${extra}</text>
      </g>`);
  }

  let vpnNode = '';
  if (withVpn) {
    const devices = vpn.devices ?? [];
    const online = devices.filter((d) => d.lastHandshake && Date.now() / 1000 - d.lastHandshake < 180).length;
    const label = devices.length
      ? `${devices.length} device${devices.length === 1 ? '' : 's'}${online ? `, ${online} connected` : ''}`
      : 'no devices yet';
    edges.push(`<line class="edge edge-vpn" x1="${CX}" y1="${CY - 28}" x2="${CX}" y2="58"/>`);
    vpnNode = `
      <g class="map-node node-vpn" data-open="vpn" tabindex="0" role="button" aria-label="VPN access, ${label}. Open VPN access.">
        <rect class="disc" x="${CX - 96}" y="14" width="192" height="46" rx="23"/>
        <g class="glyph">${glyph('shield', CX - 68, 37, 18)}</g>
        <text class="vpn-name" x="${CX - 50}" y="33">VPN access</text>
        <text class="vpn-sub" x="${CX - 50}" y="49">${esc(label)}</text>
      </g>`;
  }

  const hub = `
    <g class="hub">
      <rect x="${CX - 96}" y="${CY - 30}" width="192" height="60" rx="30"/>
      <text class="hub-name" x="${CX}" y="${CY - 4}" text-anchor="middle">${network ? 'Private network' : 'Your servers'}</text>
      <text class="hub-sub" x="${CX}" y="${CY + 15}" text-anchor="middle">${network ? esc(network.subnet) : `${vms.length} server${vms.length === 1 ? '' : 's'}`}</text>
    </g>`;

  return `
    <svg class="netmap${animate ? ' animate' : ''}" viewBox="0 0 ${W} ${H}" role="group"
         aria-label="Map of your network: ${vms.length} servers${withVpn ? ' and VPN access' : ''}">
      <g class="edges">${edges.join('')}</g>
      ${vpnNode}
      ${hub}
      ${nodes.join('')}
    </svg>`;
}

import RFB from '/novnc/core/rfb.js';

const vmid = Number(new URLSearchParams(location.search).get('vmid'));
const title = document.getElementById('console-title');
const led = document.getElementById('console-led');
const cad = document.getElementById('cad');
const paste = document.getElementById('paste');
let rfb;

function setState(text, cls = '') {
  title.textContent = text;
  led.className = `led ${cls}`;
}

async function connect() {
  setState('Connecting…', 'busy');
  const res = await fetch(`/api/vms/${vmid}/console`, { method: 'POST', credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return setState(data.error || 'Could not open the console');

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  rfb = new RFB(document.getElementById('screen'), `${proto}://${location.host}/api/console/${data.session}`, {
    credentials: { password: data.password },
  });
  rfb.scaleViewport = true;
  rfb.resizeSession = false;

  rfb.addEventListener('connect', () => {
    setState(data.name || `Server ${vmid}`, 'running');
    document.title = `Console – ${data.name || vmid}`;
    cad.disabled = false;
    paste.disabled = !navigator.clipboard?.readText;
    rfb.focus();
  });
  rfb.addEventListener('disconnect', (e) => {
    setState(e.detail.clean ? 'Disconnected. Reload to reconnect.' : 'Connection lost. Reload to reconnect.');
    cad.disabled = paste.disabled = true;
  });
  rfb.addEventListener('credentialsrequired', () => rfb.sendCredentials({ password: data.password }));
}

cad.addEventListener('click', () => rfb?.sendCtrlAltDel());

// Types clipboard text key by key; useful for pasting passwords into a login prompt.
paste.addEventListener('click', async () => {
  const text = await navigator.clipboard.readText().catch(() => '');
  for (const ch of text.slice(0, 2000)) {
    const cp = ch.codePointAt(0);
    const keysym = ch === '\n' ? 0xff0d : cp < 0x100 ? cp : 0x01000000 + cp;
    rfb.sendKey(keysym);
  }
  rfb.focus();
});

document.getElementById('fullscreen').addEventListener('click', () => {
  document.documentElement.requestFullscreen?.();
});

connect().catch((err) => setState(err.message));

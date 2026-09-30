// Which version is running, and is there a newer release?
//
// The version is stamped into the image at build time by the GitHub workflow
// (build args -> PANEL_VERSION, PANEL_COMMIT, PANEL_BUILD_DATE). Without them
// (running from source) it falls back to package.json + "-dev".

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const repoUrl = (process.env.PANEL_REPO_URL
  || String(pkg.repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '')).replace(/\/+$/, '');
const repoPath = /github\.com\/([^/]+\/[^/]+)/.exec(repoUrl)?.[1] ?? 'sebastianflint/pve-panel';

const stamped = process.env.PANEL_VERSION && process.env.PANEL_VERSION !== 'dev';
const commit = process.env.PANEL_COMMIT && process.env.PANEL_COMMIT !== 'unknown' ? process.env.PANEL_COMMIT : null;
const startedAt = new Date();

export const versionInfo = {
  version: (stamped ? process.env.PANEL_VERSION : pkg.version).replace(/-dev$/, ''),
  isRelease: true,
  commit,
  buildDate: process.env.PANEL_BUILD_DATE || null,
  repoUrl: repoUrl || 'https://github.com/sebastianflint/pve-panel',
  commitUrl: repoUrl && commit ? `${repoUrl}/commit/${commit}` : null,
  releaseUrl: repoUrl && stamped ? `${repoUrl}/releases/tag/v${process.env.PANEL_VERSION}` : null,
  node: process.version,
  startedAt: startedAt.toISOString(),
};

// ---- Update check -------------------------------------------------------------------

const CHECK_EVERY = 6 * 3600 * 1000;
const enabled = process.env.UPDATE_CHECK !== 'false';
const upstreamRepo = process.env.UPSTREAM_REPO || 'sebastianflint/pve-panel';
const url = process.env.UPDATE_CHECK_URL || `https://api.github.com/repos/${upstreamRepo}/releases/latest`;
let cache = { at: 0, result: null };

/** "1.10.2" > "1.9.9"; pre-release/dev suffixes are compared by their base version. */
export function compareVersions(a, b) {
  const parse = (v) => String(v).replace(/^v/, '').split(/[-+]/)[0].split('.').map((n) => Number(n) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? 1 : -1;
  }
  return 0;
}

/**
 * Latest published GitHub release, cached for 6 hours. Never throws: returns
 * { checked:false, reason } when disabled or GitHub can't be reached.
 */
export async function updateStatus({ force = false } = {}) {
  if (!enabled) return { checked: false, reason: process.env.UPDATE_CHECK === 'false' ? 'disabled' : 'no repository' };
  if (!force && cache.result && Date.now() - cache.at < CHECK_EVERY) return cache.result;

  let result;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'pve-panel-update-check' },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) {
      result = { checked: true, latest: null, reason: 'no releases published yet (or the repository is private)' };
    } else if (!res.ok) {
      result = { checked: false, reason: `GitHub answered ${res.status}` };
    } else {
      const r = await res.json();
      const latest = String(r.tag_name ?? '').replace(/^v/, '');
      const current = versionInfo.version;
      const cmp = compareVersions(latest, current);
      result = {
        checked: true,
        latest: { version: latest, url: r.html_url, publishedAt: r.published_at, name: r.name || `v${latest}` },
        // Only prompt update if the upstream release has a strictly higher semver
        updateAvailable: cmp > 0,
      };
    }
  } catch (err) {
    result = { checked: false, reason: `GitHub not reachable (${err.name === 'TimeoutError' ? 'timeout' : err.message})` };
  }
  cache = { at: Date.now(), result: { ...result, checkedAt: new Date().toISOString() } };
  return cache.result;
}

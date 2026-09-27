// Single sign-on with OpenID Connect.
//
// Current best practice for a confidential server-side client (OAuth 2.0
// Security BCP, RFC 9700; OpenID Connect Core):
//   - Authorization Code flow only, with PKCE (S256), state and nonce
//   - Pushed Authorization Requests (RFC 9126) when the provider supports them
//   - endpoints and signing keys from the provider's discovery document
//   - ID token fully validated by openid-client (signature via JWKS, iss, aud,
//     azp, exp/iat with 30 s tolerance, nonce); issuer in the authorization
//     response checked when the provider sends it (RFC 9207)
//   - exact redirect URI per portal; login transaction in a short-lived,
//     httpOnly cookie; nothing about it in the URL
//   - accounts linked by issuer + subject (stable), first link by verified email

import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import * as client from 'openid-client';
import { db } from './db.js';
import { config } from './config.js';

const o = config.oidc;

export function oidcEnabledFor(scope) {
  return o.enabled && o.portals.includes(scope);
}

export const redirectUri = (scope) => `${o.publicUrl[scope]}/api/auth/oidc/callback`;

// ---- Provider configuration (discovery, cached; retried after failures) --------

let configPromise = null;
function provider() {
  if (!configPromise) {
    configPromise = client.discovery(
      new URL(o.issuer),
      o.clientId,
      { [client.clockTolerance]: 30 },
      o.clientSecret ? client.ClientSecretBasic(o.clientSecret) : client.None(),
      o.allowInsecureHttp ? { execute: [client.allowInsecureRequests] } : undefined,
    ).catch((err) => {
      configPromise = null;
      throw err;
    });
  }
  return configPromise;
}

// ---- Start -------------------------------------------------------------------------

/**
 * Builds the authorization request. Returns the URL to send the browser to and
 * the transaction (PKCE verifier, state, nonce) to keep in a cookie until the callback.
 */
export async function startLogin(scope) {
  const cfg = await provider();
  const meta = cfg.serverMetadata();
  // PKCE is always sent. Only refuse when the provider explicitly lists its
  // methods without S256 (some providers support it without advertising it).
  const methods = meta.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes('S256')) {
    throw new Error('The identity provider does not support PKCE with S256');
  }
  const tx = {
    verifier: client.randomPKCECodeVerifier(),
    state: client.randomState(),
    nonce: client.randomNonce(),
  };
  const params = {
    redirect_uri: redirectUri(scope),
    scope: o.scopes,
    response_type: 'code',
    code_challenge: await client.calculatePKCECodeChallenge(tx.verifier),
    code_challenge_method: 'S256',
    state: tx.state,
    nonce: tx.nonce,
  };
  const usePar = o.par === 'always'
    || (o.par === 'auto' && (meta.pushed_authorization_request_endpoint || meta.require_pushed_authorization_requests));
  const url = usePar
    ? await client.buildAuthorizationUrlWithPAR(cfg, params)
    : client.buildAuthorizationUrl(cfg, params);
  return { url: url.href, tx };
}

// ---- Callback ------------------------------------------------------------------------

export class SsoError extends Error {
  constructor(code, detail) {
    super(detail ?? code);
    this.code = code; // shown to the user as a friendly message by code
  }
}

/** Exchanges the code (checking state, PKCE, nonce) and returns the validated ID token claims. */
export async function finishLogin(scope, query, tx) {
  const cfg = await provider();
  const current = new URL(redirectUri(scope));
  current.search = new URLSearchParams(query).toString();
  const tokens = await client.authorizationCodeGrant(cfg, current, {
    pkceCodeVerifier: tx.verifier,
    expectedState: tx.state,
    expectedNonce: tx.nonce,
    idTokenExpected: true,
  });
  const claims = { ...tokens.claims() };
  if (!claims?.sub) throw new SsoError('failed', 'No ID token subject');

  // Some providers put email only in UserInfo (spec-compliant). Fetch it then;
  // openid-client refuses a UserInfo answer whose sub differs from the ID token.
  if (!claims.email && cfg.serverMetadata().userinfo_endpoint && tokens.access_token) {
    const info = await client.fetchUserInfo(cfg, tokens.access_token, claims.sub);
    for (const k of ['email', 'email_verified', 'name']) {
      if (info[k] !== undefined && claims[k] === undefined) claims[k] = info[k];
    }
  }
  return claims; // iss, sub, amr etc. always from the validated ID token
}

/** Did the provider confirm a multi-factor sign-in? (amr, RFC 8176) */
export function idpUsedMfa(claims) {
  const amr = new Set(Array.isArray(claims.amr) ? claims.amr.map(String) : []);
  // "mfa" stated, two different methods (e.g. pwd + otp), or a hardware key / smart card
  return amr.has('mfa') || amr.size >= 2 || amr.has('hwk') || amr.has('sc');
}

const byIdentity = db.prepare('SELECT * FROM users WHERE oidc_issuer = ? AND oidc_subject = ?');
const byEmail = db.prepare('SELECT * FROM users WHERE email = ?');

/**
 * Finds the panel account for an identity:
 *   1. already linked (issuer + subject)
 *   2. otherwise by email, only if the provider says it's verified (and in an
 *      allowed domain); the account is then linked for good
 *   3. otherwise created as a customer when OIDC_AUTO_CREATE is on
 */
export function resolveAccount(claims, { adminOnly }) {
  let user = byIdentity.get(claims.iss, claims.sub);
  let linked = false;
  let created = false;

  if (!user) {
    const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
    if (!email) throw new SsoError('no_email');
    if (o.requireVerifiedEmail && claims.email_verified !== true) throw new SsoError('email_unverified');
    const domain = email.split('@')[1] ?? '';
    if (o.allowedDomains.length && !o.allowedDomains.includes(domain)) throw new SsoError('domain');

    user = byEmail.get(email);
    if (user) {
      if (user.oidc_subject) throw new SsoError('linked_other'); // already bound to another identity
      db.prepare('UPDATE users SET oidc_issuer = ?, oidc_subject = ? WHERE id = ?').run(claims.iss, claims.sub, user.id);
      linked = true;
    } else if (o.autoCreate && !adminOnly) {
      // No usable password: this account signs in through the provider.
      const unusable = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 12);
      const { lastInsertRowid } = db.prepare(
        'INSERT INTO users (email, password_hash, is_admin, oidc_issuer, oidc_subject) VALUES (?, ?, 0, ?, ?)',
      ).run(email, unusable, claims.iss, claims.sub);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(lastInsertRowid));
      created = true;
    } else {
      throw new SsoError('not_found');
    }
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  }

  if (user.deleting) throw new SsoError('not_found');
  if (adminOnly && !user.is_admin) throw new SsoError('not_admin');
  return { user, linked, created };
}

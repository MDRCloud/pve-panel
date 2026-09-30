import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { db, audit } from './db.js';
import * as totp from './totp.js';
import * as oidc from './oidc.js';
import { checkInvitation, acceptInvitation } from './invite.js';
import { authenticateAD } from './ad.js';

const SESSION_HOURS = 8;
// Compared against when the email is unknown, so response time
// doesn't reveal which accounts exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

const findByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const findById = db.prepare(`
  SELECT id, email, is_admin, can_create, max_servers, max_cores, max_memory_mb, max_disk_gb, deleting
  FROM users WHERE id = ?
`);

/**
 * Registered once per server with its own scope:
 *   customer: cookie "panel_session",       any user may sign in
 *   admin:    cookie "panel_admin_session", administrators only
 * Browsers send cookies to every port of a host, so each scope uses its own
 * cookie name, its own signing key and a scope claim that is checked on
 * every request. A customer session is useless on the admin port.
 */
async function authPlugin(app, { scope }) {
  const adminOnly = scope === 'admin';
  const cookieName = adminOnly ? 'panel_admin_session' : 'panel_session';

  await app.register(jwt, {
    secret: adminOnly ? `${config.jwtSecret}:admin` : config.jwtSecret,
    cookie: { cookieName, signed: false },
    sign: { expiresIn: `${SESSION_HOURS}h` },
  });

  app.decorateRequest('account', null);

  app.decorate('authenticate', async (req, reply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'Sign in to continue' });
    }
    if (req.user.scope !== scope) return reply.code(401).send({ error: 'Sign in to continue' });
    // Re-check the database so deleted users and revoked admins lose access immediately.
    const account = findById.get(req.user.sub);
    if (!account || account.deleting || (adminOnly && !account.is_admin)) {
      return reply.code(401).send({ error: 'Sign in to continue' });
    }
    req.account = account;
  });

  app.decorate('requireAdmin', app.authenticate);

  const cookieOpts = (req, maxAge) => {
    const isHttps = req ? (req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https') : false;
    return {
      path: '/',
      httpOnly: true,
      secure: config.cookieSecure ? isHttps : false,
      sameSite: 'lax',
      maxAge,
    };
  };
  const pendingCookie = `${cookieName}_2fa`;
  const me = (u) => ({ id: u.id, email: u.email, isAdmin: !!u.is_admin });

  async function startSession(req, reply, user, how) {
    const token = await reply.jwtSign({ sub: user.id, scope });
    req.account = user;
    audit(req, null, adminOnly ? 'admin_login' : 'login', how ? { twoFactor: how } : null);
    return reply
      .clearCookie(pendingCookie, { path: '/' })
      .setCookie(cookieName, token, cookieOpts(req, SESSION_HOURS * 3600))
      .send(me(user));
  }

  /** Password was right; the second step is pending for 5 minutes. */
  function pending(req, reply, user, stage) {
    const token = app.jwt.sign({ sub: user.id, scope: `${scope}:2fa`, stage }, { expiresIn: '5m' });
    return reply.setCookie(pendingCookie, token, cookieOpts(req, 300)).send({ twoFactor: stage });
  }

  function pendingUser(req, stage) {
    try {
      const claim = app.jwt.verify(req.cookies[pendingCookie] ?? '');
      if (claim.scope !== `${scope}:2fa` || claim.stage !== stage) return null;
      const user = findByEmail.get(db.prepare('SELECT email FROM users WHERE id = ?').get(claim.sub)?.email ?? '');
      if (!user || user.deleting || (adminOnly && !user.is_admin)) return null;
      return user;
    } catch {
      return null;
    }
  }
  const expired = (reply) => reply.code(401).send({ error: 'The sign-in took too long. Please start again.', restart: true });

  app.post('/api/auth/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', maxLength: 254 },
          password: { type: 'string', maxLength: 200 },
        },
      },
    },
  }, async (req, reply) => {
    if (!config.auth.password[scope]) {
      return reply.code(403).send({ error: 'Signing in with a password is turned off. Use single sign-on.' });
    }
    const { email, password } = req.body;
    let user = findByEmail.get(email.trim().toLowerCase());

    // 1. Try Active Directory authentication if enabled
    let adResult = null;
    if (config.ad?.enabled) {
      try {
        adResult = await authenticateAD(email, password);
      } catch (err) {
        req.log.warn({ err }, 'AD authentication error');
      }
    }

    let ok = false;
    if (adResult?.ok) {
      user = findByEmail.get(adResult.email.toLowerCase());
      if (!user) {
        // Auto-provision user in SQLite database from Active Directory
        const info = db.prepare('INSERT INTO users (email, password_hash, is_admin) VALUES (?, ?, ?)')
          .run(adResult.email.toLowerCase(), '*ACTIVE_DIRECTORY*', adResult.isAdmin ? 1 : 0);
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
      } else {
        // Keep admin flag in sync if AD grants admin
        if (adResult.isAdmin && !user.is_admin) {
          db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user.id);
          user.is_admin = 1;
        }
      }
      ok = true;
    } else {
      // Fallback: check local SQLite password
      ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
    }

    // Non-admins get the same answer as a wrong password on the admin port.
    if (!user || !ok || user.deleting || (adminOnly && !user.is_admin)) {
      audit(req, null, adminOnly ? 'admin_login_failed' : 'login_failed', { email });
      return reply.code(401).send({ error: 'Email or password is incorrect' });
    }
    if (user.totp_enabled) return pending(req, reply, user, 'verify');
    if (user.totp_required) return pending(req, reply, user, 'setup');
    return startSession(req, reply, user, null);
  });

  // Second step: authenticator code or recovery code
  app.post('/api/auth/2fa/verify', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { body: { type: 'object', required: ['code'], properties: { code: { type: 'string', maxLength: 20 } } } },
  }, async (req, reply) => {
    const user = pendingUser(req, 'verify');
    if (!user) return expired(reply);
    const how = totp.verify(user.id, req.body.code);
    if (!how) {
      audit({ account: user, ip: req.ip }, null, adminOnly ? 'admin_login_failed' : 'login_failed', { email: user.email, twoFactor: true });
      return reply.code(401).send({ error: 'That code is not correct. Check the time on your phone and try the newest code.' });
    }
    return startSession(req, reply, user, how);
  });

  // Required 2FA not set up yet: enrol before the first session
  app.post('/api/auth/2fa/setup', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const user = pendingUser(req, 'setup');
    if (!user) return expired(reply);
    return totp.beginSetup(user.id);
  });

  app.post('/api/auth/2fa/activate', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { body: { type: 'object', required: ['code'], properties: { code: { type: 'string', maxLength: 10 } } } },
  }, async (req, reply) => {
    const user = pendingUser(req, 'setup');
    if (!user) return expired(reply);
    const codes = totp.activate(user.id, String(req.body.code).replace(/\s/g, ''));
    if (!codes) return reply.code(400).send({ error: 'That code is not correct. Enter the 6-digit code your app shows now.' });
    audit({ account: user, ip: req.ip }, null, 'twofa_enabled');
    const token = await reply.jwtSign({ sub: user.id, scope });
    req.account = user;
    audit(req, null, adminOnly ? 'admin_login' : 'login', { twoFactor: 'setup' });
    return reply
      .clearCookie(pendingCookie, { path: '/' })
      .setCookie(cookieName, token, cookieOpts(SESSION_HOURS * 3600))
      .send({ ...me(user), recoveryCodes: codes });
  });

  // ---- Invitations: set your own password (customer portal) -------------------
  if (!adminOnly) {
    const tokenBody = { type: 'string', minLength: 40, maxLength: 60, pattern: '^[A-Za-z0-9_-]+$' };
    app.post('/api/invite/check', {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: { body: { type: 'object', required: ['token'], properties: { token: tokenBody } } },
    }, async (req) => checkInvitation(req.body.token));

    app.post('/api/invite/accept', {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['token', 'password'],
          properties: { token: tokenBody, password: { type: 'string', minLength: 12, maxLength: 200 } },
        },
      },
    }, async (req) => acceptInvitation(req, req.body.token, req.body.password));
  }

  // ---- Sign-in options + OIDC ---------------------------------------------------
  const ssoHere = oidc.oidcEnabledFor(scope);

  app.get('/api/auth/options', async () => ({
    password: config.auth.password[scope],
    oidc: ssoHere
      ? { enabled: true, label: config.oidc.label, startUrl: `${config.oidc.publicUrl[scope]}/api/auth/oidc/start` }
      : { enabled: false },
  }));

  // Which second step is waiting (after single sign-on redirected back)
  app.get('/api/auth/2fa/pending', async (req, reply) => {
    for (const stage of ['verify', 'setup']) {
      const user = pendingUser(req, stage);
      if (user) return { stage, email: user.email };
    }
    return expired(reply);
  });

  if (ssoHere) {
    const txCookie = `${cookieName}_oidc`;
    // Lax, not Strict: the provider sends the browser back cross-site, and the
    // transaction cookie must come along. It lives 10 minutes and is used once.
    const txOpts = {
      path: '/api/auth/oidc', httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', maxAge: 600,
    };

    // Continue on our own site with a same-site navigation, so the Strict
    // session cookie is sent (it isn't on a redirect chain started elsewhere).
    const continueTo = (reply, target) => reply
      .header('Cache-Control', 'no-store')
      .type('text/html')
      .send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="0;url=${target}"><title>Signing in…</title></head>
<body style="font-family:system-ui,sans-serif;padding:40px">Signing in… <a href="${target}">Continue</a></body></html>`);

    const fail = (req, reply, code, detail) => {
      req.log.warn({ code, detail }, 'single sign-on failed');
      audit(req, null, adminOnly ? 'admin_sso_login_failed' : 'sso_login_failed', { reason: code, detail: String(detail ?? '').slice(0, 300) });
      return continueTo(reply.clearCookie(txCookie, { path: txOpts.path }), `/?sso_error=${encodeURIComponent(code)}`);
    };

    const publicOrigin = new URL(config.oidc.publicUrl[scope]).origin;

    app.get('/api/auth/oidc/start', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
      // The sign-in cookie must be set on the same address the provider sends
      // the browser back to. If the panel was opened under another address
      // (IP instead of name, other port, tunnel), start again on the right one.
      const here = `${req.protocol}://${req.host}`;
      if (here.toLowerCase() !== publicOrigin.toLowerCase()) {
        req.log.info({ here, publicOrigin }, 'single sign-on started on another address; moving to the configured one');
        return reply.redirect(`${publicOrigin}/api/auth/oidc/start`);
      }
      try {
        const { url, tx } = await oidc.startLogin(scope);
        const token = app.jwt.sign({ scope: `${scope}:oidc`, ...tx }, { expiresIn: '10m' });
        return reply.header('Cache-Control', 'no-store').setCookie(txCookie, token, txOpts).redirect(url);
      } catch (err) {
        return fail(req, reply, 'unavailable', err.message);
      }
    });

    app.get('/api/auth/oidc/callback', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
      let tx;
      const raw = req.cookies[txCookie];
      try {
        tx = app.jwt.verify(raw ?? '');
        if (tx.scope !== `${scope}:oidc`) throw new Error('wrong scope');
      } catch (err) {
        // Say precisely why, for the activity log and the panel log.
        const why = !raw
          ? `the browser brought no sign-in cookie to ${req.protocol}://${req.host}. Usual causes: the sign-in `
            + 'was started under another address than the configured public URL, the browser blocks cookies, '
            + `or COOKIE_SECURE=true on a plain-http address other than localhost`
          : /expired/i.test(err.message) ? 'the sign-in took longer than 10 minutes'
          : `the sign-in cookie was not valid (${err.message})`;
        return fail(req, reply, 'expired', why);
      }
      reply.clearCookie(txCookie, { path: txOpts.path });

      if (req.query.error) {
        return fail(req, reply, req.query.error === 'access_denied' ? 'denied' : 'failed',
          `${req.query.error}: ${req.query.error_description ?? ''}`);
      }

      let claims;
      try {
        claims = await oidc.finishLogin(scope, req.query, tx);
      } catch (err) {
        return fail(req, reply, 'failed', err.message);
      }

      let result;
      try {
        result = oidc.resolveAccount(claims, { adminOnly });
      } catch (err) {
        return fail(req, reply, err.code ?? 'failed', `${err.message} (sub ${claims.sub}, email ${claims.email ?? '-'})`);
      }
      const { user, linked, created } = result;
      const actor = { account: user, ip: req.ip };
      if (created) audit(actor, null, 'sso_account_created', { email: user.email, issuer: claims.iss });
      if (linked) audit(actor, null, 'sso_account_linked', { email: user.email, issuer: claims.iss });

      // The panel's own 2FA still applies, unless the provider confirmed MFA.
      const idpMfa = config.oidc.trustIdpMfa && oidc.idpUsedMfa(claims);
      if (!idpMfa && (user.totp_enabled || user.totp_required)) {
        const stage = user.totp_enabled ? 'verify' : 'setup';
        const token = app.jwt.sign({ sub: user.id, scope: `${scope}:2fa`, stage }, { expiresIn: '5m' });
        reply.setCookie(pendingCookie, token, cookieOpts(300));
        return continueTo(reply, '/?sso=2fa');
      }

      const session = await reply.jwtSign({ sub: user.id, scope });
      req.account = user;
      audit(req, null, adminOnly ? 'admin_login' : 'login', { sso: true, idpMfa: oidc.idpUsedMfa(claims) });
      reply.clearCookie(pendingCookie, { path: '/' }).setCookie(cookieName, session, cookieOpts(SESSION_HOURS * 3600));
      return continueTo(reply, '/');
    });
  }

  // ---- Own account: manage 2FA ------------------------------------------------
  app.get('/api/account/2fa', { preHandler: app.authenticate }, async (req) => totp.twoFactorState(req.account.id));

  app.post('/api/account/2fa/setup', { preHandler: app.authenticate }, async (req, reply) => {
    if (totp.twoFactorState(req.account.id).enabled) return reply.code(409).send({ error: 'Two-factor authentication is already on' });
    return totp.beginSetup(req.account.id);
  });

  app.post('/api/account/2fa/activate', {
    preHandler: app.authenticate,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { body: { type: 'object', required: ['code'], properties: { code: { type: 'string', maxLength: 10 } } } },
  }, async (req, reply) => {
    const codes = totp.activate(req.account.id, String(req.body.code).replace(/\s/g, ''));
    if (!codes) return reply.code(400).send({ error: 'That code is not correct. Enter the 6-digit code your app shows now.' });
    audit(req, null, 'twofa_enabled');
    return { recoveryCodes: codes };
  });

  const codeBody = { body: { type: 'object', required: ['code'], properties: { code: { type: 'string', maxLength: 20 } } } };

  app.post('/api/account/2fa/disable', {
    preHandler: app.authenticate, config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: codeBody,
  }, async (req, reply) => {
    const state = totp.twoFactorState(req.account.id);
    if (state.required) return reply.code(403).send({ error: 'Your provider requires two-factor authentication for your account' });
    if (!totp.verify(req.account.id, req.body.code)) return reply.code(400).send({ error: 'That code is not correct' });
    totp.reset(req.account.id);
    audit(req, null, 'twofa_disabled');
    return { enabled: false };
  });

  app.post('/api/account/2fa/recovery-codes', {
    preHandler: app.authenticate, config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: codeBody,
  }, async (req, reply) => {
    if (!totp.verify(req.account.id, req.body.code)) return reply.code(400).send({ error: 'That code is not correct' });
    audit(req, null, 'twofa_recovery_codes');
    return { recoveryCodes: totp.newRecoveryCodesFor(req.account.id) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    return reply.clearCookie(cookieName, { path: '/' }).clearCookie(pendingCookie, { path: '/' }).code(204).send();
  });

  app.get('/api/auth/me', { preHandler: app.authenticate }, async (req) => ({
    id: req.account.id,
    email: req.account.email,
    isAdmin: !!req.account.is_admin,
  }));
}

export default fp(authPlugin);

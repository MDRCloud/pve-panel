import { Client } from 'ldapts';
import { config } from './config.js';

function escapeFilter(str) {
  return String(str).replace(/([\\*()/\0])/g, (match) => `\\${match.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/**
 * Authenticates a user against Active Directory via LDAP.
 * Supports sAMAccountName (e.g. jsmith), userPrincipalName (e.g. jsmith@mdrcloud.net), or mail.
 * Returns { ok: true, email, name, sAMAccountName, isAdmin } on success,
 * { ok: false, error: 'invalid_credentials' } on wrong password,
 * or null if AD is disabled or user not found in AD.
 */
export async function authenticateAD(usernameOrEmail, password) {
  if (!config.ad?.enabled) return null;
  if (!usernameOrEmail || !password) return null;

  const raw = usernameOrEmail.trim();
  const isEmail = raw.includes('@');
  const accountName = isEmail ? raw.split('@')[0] : raw;
  const userPrincipal = isEmail ? raw : `${raw}@${config.ad.domain || 'mdrcloud.net'}`;

  const client = new Client({
    url: config.ad.url,
    timeout: 5000,
  });

  try {
    await client.bind(config.ad.bindDn, config.ad.bindPassword);

    const filter = `(&(objectClass=user)(!(objectClass=computer))(|(sAMAccountName=${escapeFilter(accountName)})(userPrincipalName=${escapeFilter(userPrincipal)})(mail=${escapeFilter(raw)})))`;

    const res = await client.search(config.ad.baseDn, {
      scope: 'sub',
      filter,
      attributes: ['dn', 'sAMAccountName', 'userPrincipalName', 'mail', 'displayName', 'memberOf'],
    });

    if (!res.searchEntries || res.searchEntries.length === 0) {
      return null; // Not found in AD; allows falling back to local database
    }

    const userEntry = res.searchEntries[0];
    const userDn = userEntry.dn;
    const email = (userEntry.userPrincipalName || userEntry.mail || `${userEntry.sAMAccountName}@${config.ad.domain || 'mdrcloud.net'}`).toLowerCase();
    const name = userEntry.displayName || userEntry.sAMAccountName;

    // Verify user credentials by attempting to bind with their user DN
    const userClient = new Client({
      url: config.ad.url,
      timeout: 5000,
    });

    try {
      await userClient.bind(userDn, password);
      await userClient.unbind();
    } catch {
      return { ok: false, error: 'invalid_credentials' };
    }

    // Check group memberships for admin privileges
    const memberOf = Array.isArray(userEntry.memberOf)
      ? userEntry.memberOf
      : (userEntry.memberOf ? [userEntry.memberOf] : []);

    const adminGroups = (config.ad.adminGroups || ['Domain Admins', 'Administrators']).map((g) => g.toLowerCase());
    const isAdmin = memberOf.some((dn) => {
      const lower = String(dn).toLowerCase();
      return adminGroups.some((ag) => lower.includes(`cn=${ag},`) || lower.endsWith(`cn=${ag}`));
    });

    return {
      ok: true,
      email,
      name,
      sAMAccountName: String(userEntry.sAMAccountName),
      isAdmin,
    };
  } catch (err) {
    console.error('Active Directory LDAP error:', err.message);
    return null;
  } finally {
    try { await client.unbind(); } catch {}
  }
}

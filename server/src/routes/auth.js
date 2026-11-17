// Cuentas: registro, entrar con contraseña o con código, recuperar contraseña y sesiones.
// Las respuestas tienen la misma forma que las de Supabase Auth para que la app funcione igual con ambos.
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { config } from '../config.js';
import { ApiError, fail, nowIso, rateLimit, requireUser, tooMany } from '../http.js';
import { sendConfirmMail, sendOtpMail, sendRecoveryMail } from '../mailer.js';
import { burnPasswordCheck, checkPassword, hashPassword, randomCode, randomToken, sha256, signAccessToken } from '../security.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_CODE_ATTEMPTS = 5;

export function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    created_at: row.created_at,
    updated_at: row.updated_at,
    email_confirmed_at: row.email_confirmed_at || null,
    user_metadata: { avatar_url: row.avatar_url || null },
    identities: [{ provider: 'email' }],
  };
}

const cleanEmail = (value) => {
  const email = String(value || '').trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL.test(email)) fail(400, 'email_address_invalid', 'Ese correo no es válido.');
  return email;
};

const checkNewPassword = (value) => {
  if (typeof value !== 'string' || value.length < 6) fail(422, 'weak_password', 'La contraseña debe tener al menos 6 caracteres.');
  if (value.length > 200) fail(422, 'weak_password', 'La contraseña es demasiado larga.');
  return value;
};

// Dirección pública de este servidor (para los enlaces de los correos).
// Solo se deduce de la petición en tu PC o red local: en internet alguien podría mandar otro "Host"
// y hacer que el enlace del correo apunte a su sitio, así que ahí hace falta PUBLIC_URL.
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/i;
function serverOrigin(req) {
  if (config.publicUrl) return config.publicUrl;
  const host = req.get('host') || '';
  if (!LOCAL_HOST.test(host)) fail(500, 'public_url_missing', 'Falta configurar PUBLIC_URL en el servidor.');
  return `${req.protocol}://${host}`;
}

// Los enlaces solo pueden volver a páginas conocidas (evita que alguien los use para redirigir a otro sitio).
function safeRedirect(req, value) {
  const allowed = config.siteUrls.map((site) => { try { return new URL(site); } catch { return null; } }).filter(Boolean);
  if (config.serveWeb) allowed.push(new URL(`${serverOrigin(req)}/`));
  try {
    const target = new URL(String(value || ''));
    const ok = allowed.some((site) => site.origin === target.origin && target.pathname.startsWith(site.pathname));
    if (ok) return `${target.origin}${target.pathname}`;
  } catch { /* se usa la de por defecto */ }
  return allowed.length ? allowed[0].href : `${serverOrigin(req)}/`;
}

export function authRoutes(db) {
  const router = Router();

  const userByEmail = (email) => db.get('SELECT * FROM users WHERE email = ?', [email]);
  const userById = (id) => db.get('SELECT * FROM users WHERE id = ?', [id]);

  async function createSession(user) {
    const refresh = randomToken();
    const { token, expiresAt } = signAccessToken(user.id);
    await db.run('INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
      [randomUUID(), user.id, sha256(refresh), Date.now() + config.refreshTtl * 1000, nowIso()]);
    return {
      access_token: token,
      token_type: 'bearer',
      expires_in: config.accessTtl,
      expires_at: expiresAt,
      refresh_token: refresh,
      user: publicUser(user),
    };
  }

  // Un correo cada cierto tiempo por persona y tipo (código, recuperación, confirmación).
  async function issueCode(user, kind, value) {
    const last = await db.get('SELECT created_at FROM auth_codes WHERE user_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1', [user.id, kind]);
    if (last && Date.now() - Date.parse(last.created_at) < config.emailCooldown * 1000) {
      fail(429, 'over_email_send_rate_limit', 'Ya se envió un correo hace poco. Espera un minuto.');
    }
    await db.run('DELETE FROM auth_codes WHERE user_id = ? AND kind = ?', [user.id, kind]);
    const ttl = kind === 'otp' ? config.otpTtl : config.linkTtl;
    await db.run('INSERT INTO auth_codes (id, user_id, kind, code_hash, attempts, expires_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
      [randomUUID(), user.id, kind, sha256(kind === 'otp' ? `${user.id}:${value}` : value), Date.now() + ttl * 1000, nowIso()]);
  }

  // Comprueba un enlace del correo (recovery / signup). Se borra al usarlo: solo sirve una vez.
  async function consumeLink(kind, token) {
    const row = await db.get('SELECT * FROM auth_codes WHERE kind = ? AND code_hash = ?', [kind, sha256(token)]);
    if (!row) return null;
    await db.run('DELETE FROM auth_codes WHERE id = ?', [row.id]);
    if (Number(row.expires_at) < Date.now()) return null;
    return userById(row.user_id);
  }

  async function sendConfirmation(req, user, redirectTo) {
    const token = randomToken();
    await issueCode(user, 'signup', token);
    const link = `${serverOrigin(req)}/api/auth/verify?type=signup&token=${token}&redirect_to=${encodeURIComponent(safeRedirect(req, redirectTo))}`;
    await sendConfirmMail(user.email, link);
  }

  const authLimit = rateLimit('auth', 30, 300);

  router.post('/signup', authLimit, async (req, res) => {
    if (!config.allowSignup) fail(422, 'signup_disabled', 'El registro de cuentas nuevas está cerrado.');
    const email = cleanEmail(req.body.email);
    const password = checkNewPassword(req.body.password);
    const existing = await userByEmail(email);
    if (existing) {
      if (!config.emailConfirm) fail(422, 'user_already_exists', 'Ese correo ya tiene cuenta.');
      // Como Supabase: no se dice si el correo existe; si no estaba confirmado se reenvía la confirmación.
      if (!existing.email_confirmed_at) await sendConfirmation(req, existing, req.body.redirect_to).catch(() => {});
      return res.json({ user: { ...publicUser(existing), identities: existing.email_confirmed_at ? [] : [{ provider: 'email' }] }, session: null });
    }
    const now = nowIso();
    const user = { id: randomUUID(), email, password_hash: await hashPassword(password), email_confirmed_at: config.emailConfirm ? null : now, avatar_url: null, created_at: now, updated_at: now };
    await db.run('INSERT INTO users (id, email, password_hash, email_confirmed_at, avatar_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [user.id, user.email, user.password_hash, user.email_confirmed_at, null, now, now]);
    if (config.emailConfirm) {
      await sendConfirmation(req, user, req.body.redirect_to);
      return res.json({ user: publicUser(user), session: null });
    }
    const session = await createSession(user);
    res.json({ user: session.user, session });
  });

  router.post('/token', authLimit, async (req, res) => {
    const email = cleanEmail(req.body.email);
    const password = String(req.body.password || '');
    if (tooMany(`login:${email}`, 10, 900)) fail(429, 'over_request_rate_limit', 'Demasiados intentos. Espera un rato.');
    const user = await userByEmail(email);
    if (!user || !user.password_hash) {
      await burnPasswordCheck(password);
      fail(400, 'invalid_credentials', 'Correo o contraseña incorrectos.');
    }
    if (!(await checkPassword(password, user.password_hash))) fail(400, 'invalid_credentials', 'Correo o contraseña incorrectos.');
    if (!user.email_confirmed_at) fail(400, 'email_not_confirmed', 'Primero confirma tu correo.');
    res.json(await createSession(user));
  });

  // Renueva la sesión: el refresh token viejo deja de servir y se entrega uno nuevo.
  router.post('/token/refresh', rateLimit('refresh', 60, 300), async (req, res) => {
    const hash = sha256(String(req.body.refresh_token || ''));
    const row = await db.get('SELECT * FROM sessions WHERE token_hash = ?', [hash]);
    if (!row) fail(400, 'refresh_token_not_found', 'La sesión ya no es válida.');
    await db.run('DELETE FROM sessions WHERE id = ?', [row.id]);
    if (Number(row.expires_at) < Date.now()) fail(400, 'refresh_token_expired', 'La sesión caducó.');
    const user = await userById(row.user_id);
    if (!user) fail(400, 'user_not_found', 'La cuenta ya no existe.');
    res.json(await createSession(user));
  });

  router.post('/logout', async (req, res) => {
    const token = String(req.body.refresh_token || '');
    if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
    res.status(204).end();
  });

  // Código de 6 dígitos por correo. Solo para cuentas que ya existen, pero la respuesta es la misma en ambos casos.
  router.post('/otp', authLimit, async (req, res) => {
    const email = cleanEmail(req.body.email);
    const user = await userByEmail(email);
    if (user) {
      const code = randomCode(config.otpLength);
      await issueCode(user, 'otp', code);
      await sendOtpMail(email, code).catch((error) => { console.error('[correo]', error.message); fail(500, 'email_send_failed', 'No se pudo enviar el correo.'); });
    } else {
      // A la app se le responde igual (no revela qué correos tienen cuenta); aquí sí se avisa.
      console.log(`[correo] No se envió el código: ${email} no tiene cuenta en este servidor.`);
    }
    res.json({});
  });

  router.post('/verify', authLimit, async (req, res) => {
    const email = cleanEmail(req.body.email);
    const token = String(req.body.token || '').replace(/\D/g, '');
    const user = await userByEmail(email);
    const row = user && await db.get('SELECT * FROM auth_codes WHERE user_id = ? AND kind = ?', [user.id, 'otp']);
    const invalid = () => fail(403, 'otp_expired', 'El código no es correcto o ya caducó.');
    if (!row) invalid();
    if (Number(row.expires_at) < Date.now() || Number(row.attempts) >= MAX_CODE_ATTEMPTS) {
      await db.run('DELETE FROM auth_codes WHERE id = ?', [row.id]);
      invalid();
    }
    if (sha256(`${user.id}:${token}`) !== row.code_hash) {
      await db.run('UPDATE auth_codes SET attempts = attempts + 1 WHERE id = ?', [row.id]);
      invalid();
    }
    await db.run('DELETE FROM auth_codes WHERE id = ?', [row.id]);
    // Recibir el código demuestra que el correo es suyo.
    if (!user.email_confirmed_at) {
      user.email_confirmed_at = nowIso();
      await db.run('UPDATE users SET email_confirmed_at = ?, updated_at = ? WHERE id = ?', [user.email_confirmed_at, user.email_confirmed_at, user.id]);
    }
    const session = await createSession(user);
    res.json({ user: session.user, session });
  });

  router.post('/recover', authLimit, async (req, res) => {
    const email = cleanEmail(req.body.email);
    const user = await userByEmail(email);
    if (user) {
      const token = randomToken();
      await issueCode(user, 'recovery', token);
      const link = `${serverOrigin(req)}/api/auth/verify?type=recovery&token=${token}&redirect_to=${encodeURIComponent(safeRedirect(req, req.body.redirect_to))}`;
      await sendRecoveryMail(email, link).catch((error) => { console.error('[correo]', error.message); fail(500, 'email_send_failed', 'No se pudo enviar el correo.'); });
    } else {
      console.log(`[correo] No se envió el enlace: ${email} no tiene cuenta en este servidor.`);
    }
    res.json({});
  });

  // El enlace del correo pasa por aquí y vuelve a la app con la sesión en el "#", igual que Supabase.
  router.get('/verify', rateLimit('verify-link', 30, 300), async (req, res) => {
    const type = req.query.type === 'signup' ? 'signup' : 'recovery';
    const target = safeRedirect(req, req.query.redirect_to);
    const user = await consumeLink(type, String(req.query.token || ''));
    if (!user) {
      const params = new URLSearchParams({ error: 'access_denied', error_code: 'otp_expired', error_description: 'El enlace no es válido o caducó' });
      return res.redirect(303, `${target}#${params}`);
    }
    if (!user.email_confirmed_at) {
      user.email_confirmed_at = nowIso();
      await db.run('UPDATE users SET email_confirmed_at = ?, updated_at = ? WHERE id = ?', [user.email_confirmed_at, user.email_confirmed_at, user.id]);
    }
    const session = await createSession(user);
    const params = new URLSearchParams({
      access_token: session.access_token,
      expires_at: String(session.expires_at),
      expires_in: String(session.expires_in),
      refresh_token: session.refresh_token,
      token_type: 'bearer',
      type,
    });
    res.set('Referrer-Policy', 'no-referrer');
    res.redirect(303, `${target}#${params}`);
  });

  router.get('/user', requireUser, async (req, res) => {
    const user = await userById(req.userId);
    if (!user) fail(401, 'user_not_found', 'La cuenta ya no existe.');
    res.json(publicUser(user));
  });

  // Cambiar contraseña y/o la foto (user_metadata.avatar_url), como updateUser de Supabase.
  router.put('/user', requireUser, async (req, res) => {
    const user = await userById(req.userId);
    if (!user) fail(401, 'user_not_found', 'La cuenta ya no existe.');
    const now = nowIso();
    if (req.body.password !== undefined) {
      const password = checkNewPassword(req.body.password);
      if (user.password_hash && await checkPassword(password, user.password_hash)) fail(422, 'same_password', 'Esa ya es tu contraseña actual.');
      user.password_hash = await hashPassword(password);
      await db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [user.password_hash, now, user.id]);
    }
    const data = req.body.data;
    if (data && typeof data === 'object' && 'avatar_url' in data) {
      const url = data.avatar_url;
      if (url !== null && (typeof url !== 'string' || url.length > 1000 || !/^https?:\/\//i.test(url))) fail(400, 'validation_failed', 'avatar_url no es válido.');
      user.avatar_url = url;
      await db.run('UPDATE users SET avatar_url = ?, updated_at = ? WHERE id = ?', [url, now, user.id]);
    }
    user.updated_at = now;
    res.json(publicUser(user));
  });

  return router;
}

export { ApiError };

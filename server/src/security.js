// Contraseñas (scrypt), tokens de sesión (JWT HS256) y códigos de un solo uso, solo con node:crypto.
import { createHash, createHmac, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';

const scryptAsync = promisify(scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1 };

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function checkPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64url');
  const key = await scryptAsync(password, Buffer.from(salt, 'base64url'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return timingSafeEqual(key, expected);
}

// Para que comprobar un correo inexistente tarde lo mismo que uno existente.
let dummyHash;
export async function burnPasswordCheck(password) {
  dummyHash ||= await hashPassword('videotk-dummy-password');
  await checkPassword(password, dummyHash);
}

export const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');
export const randomCode = (length) => String(randomInt(0, 10 ** length)).padStart(length, '0');

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const sign = (data) => createHmac('sha256', config.jwtSecret).update(data).digest('base64url');

export function signAccessToken(userId) {
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: userId, iat: now, exp: now + config.accessTtl, aud: 'videotk' })}`;
  return { token: `${data}.${sign(data)}`, expiresAt: now + config.accessTtl };
}

// Devuelve el id del usuario o null si el token no es válido o caducó.
export function verifyAccessToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`));
  const given = Buffer.from(parts[2]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (header.alg !== 'HS256' || payload.aud !== 'videotk') return null;
    if (typeof payload.sub !== 'string' || !(payload.exp > Date.now() / 1000)) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

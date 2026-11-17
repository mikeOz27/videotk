// Utilidades HTTP: errores con código, límite de intentos y comprobación de sesión.
import { verifyAccessToken } from './security.js';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

export const fail = (status, code, message) => { throw new ApiError(status, code, message); };

// Límite de intentos en memoria (por IP o por correo). Suficiente para un solo servidor.
const hits = new Map();
export function tooMany(key, max, windowSeconds) {
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || entry.reset <= now) {
    hits.set(key, { count: 1, reset: now + windowSeconds * 1000 });
    return false;
  }
  entry.count += 1;
  return entry.count > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of hits) if (entry.reset <= now) hits.delete(key);
}, 60_000).unref();

export function rateLimit(name, max, windowSeconds) {
  return (req, _res, next) => {
    if (tooMany(`${name}:${req.ip}`, max, windowSeconds)) return next(new ApiError(429, 'over_request_rate_limit', 'Demasiados intentos. Espera un momento.'));
    next();
  };
}

export function requireUser(req, _res, next) {
  const header = req.get('authorization') || '';
  const userId = verifyAccessToken(header.startsWith('Bearer ') ? header.slice(7) : '');
  if (!userId) return next(new ApiError(401, 'bad_jwt', 'Sesión no válida o caducada.'));
  req.userId = userId;
  next();
}

export const nowIso = () => new Date().toISOString();
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Capa de base de datos intercambiable: SQLite (archivo local), PostgreSQL o MySQL.
// El resto del código solo usa all/get/run con marcadores "?" y las pocas diferencias
// entre motores (tipos de columna, "insertar si no existe", códigos de error) se resuelven aquí.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

const TYPES = {
  sqlite: { id: 'TEXT', key: 'TEXT', text: 'TEXT', ts: 'TEXT', num: 'REAL', big: 'INTEGER', blob: 'BLOB', table: '' },
  postgres: { id: 'TEXT', key: 'TEXT', text: 'TEXT', ts: 'TEXT', num: 'DOUBLE PRECISION', big: 'BIGINT', blob: 'BYTEA', table: '' },
  mysql: { id: 'VARCHAR(36)', key: 'VARCHAR(255)', text: 'TEXT', ts: 'VARCHAR(32)', num: 'DOUBLE', big: 'BIGINT', blob: 'MEDIUMBLOB', table: ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin' },
};

// url_key y name_key guardan el link (hash) y el nombre en minúsculas: así los índices únicos
// funcionan igual en los tres motores (MySQL no indexa columnas TEXT largas).
function schema(t) {
  return [
    `CREATE TABLE IF NOT EXISTS users (
      id ${t.id} PRIMARY KEY,
      email ${t.key} NOT NULL UNIQUE,
      password_hash ${t.text},
      email_confirmed_at ${t.ts},
      avatar_url ${t.text},
      created_at ${t.ts} NOT NULL,
      updated_at ${t.ts} NOT NULL
    )${t.table}`,
    `CREATE TABLE IF NOT EXISTS sessions (
      id ${t.id} PRIMARY KEY,
      user_id ${t.id} NOT NULL,
      token_hash ${t.key} NOT NULL UNIQUE,
      expires_at ${t.big} NOT NULL,
      created_at ${t.ts} NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )${t.table}`,
    `CREATE TABLE IF NOT EXISTS auth_codes (
      id ${t.id} PRIMARY KEY,
      user_id ${t.id} NOT NULL,
      kind ${t.key} NOT NULL,
      code_hash ${t.key} NOT NULL,
      attempts ${t.big} NOT NULL,
      expires_at ${t.big} NOT NULL,
      created_at ${t.ts} NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )${t.table}`,
    `CREATE TABLE IF NOT EXISTS categories (
      id ${t.id} PRIMARY KEY,
      user_id ${t.id} NOT NULL,
      name ${t.key} NOT NULL,
      name_key ${t.key} NOT NULL,
      created_at ${t.ts} NOT NULL,
      UNIQUE (id, user_id),
      UNIQUE (user_id, name_key),
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )${t.table}`,
    `CREATE TABLE IF NOT EXISTS videos (
      id ${t.id} PRIMARY KEY,
      user_id ${t.id} NOT NULL,
      url ${t.text} NOT NULL,
      url_key ${t.key} NOT NULL,
      title ${t.text} NOT NULL,
      source ${t.text} NOT NULL,
      thumbnail ${t.text} NOT NULL,
      description ${t.text} NOT NULL,
      category_id ${t.id},
      position ${t.num} NOT NULL,
      created_at ${t.ts} NOT NULL,
      UNIQUE (user_id, url_key),
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
      FOREIGN KEY (category_id, user_id) REFERENCES categories (id, user_id)
    )${t.table}`,
    `CREATE TABLE IF NOT EXISTS avatars (
      user_id ${t.id} PRIMARY KEY,
      mime ${t.key} NOT NULL,
      data ${t.blob} NOT NULL,
      updated_at ${t.ts} NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )${t.table}`,
  ];
}

const INDEXES = [
  ['videos_user_position_idx', 'videos (user_id, position)'],
  ['videos_category_idx', 'videos (category_id)'],
  ['sessions_user_idx', 'sessions (user_id)'],
  ['auth_codes_user_idx', 'auth_codes (user_id, kind)'],
];

const clean = (params) => params.map((value) => (value === undefined ? null : value));

async function openSqlite() {
  const { DatabaseSync } = await import('node:sqlite');
  mkdirSync(dirname(config.db.sqliteFile), { recursive: true });
  const db = new DatabaseSync(config.db.sqliteFile);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  return {
    async all(sql, params = []) { return db.prepare(sql).all(...clean(params)); },
    async get(sql, params = []) { return db.prepare(sql).get(...clean(params)); },
    async run(sql, params = []) { return { changes: Number(db.prepare(sql).run(...clean(params)).changes) }; },
    async exec(sql) { db.exec(sql); },
    insertIgnore: (rest) => `INSERT OR IGNORE INTO ${rest}`,
    async close() { db.close(); },
  };
}

async function openPostgres() {
  const { default: pg } = await import('pg');
  // BIGINT llega como texto en pg: se convierte a número (los valores caben de sobra).
  pg.types.setTypeParser(20, (value) => Number(value));
  pg.types.setTypeParser(701, (value) => Number(value));
  const pool = new pg.Pool({
    connectionString: config.db.url,
    ssl: config.db.ssl ? { rejectUnauthorized: false } : undefined,
    max: config.db.poolMax,
  });
  const numbered = (sql) => { let n = 0; return sql.replace(/\?/g, () => `$${++n}`); };
  return {
    async all(sql, params = []) { return (await pool.query(numbered(sql), clean(params))).rows; },
    async get(sql, params = []) { return (await pool.query(numbered(sql), clean(params))).rows[0]; },
    async run(sql, params = []) { return { changes: (await pool.query(numbered(sql), clean(params))).rowCount }; },
    async exec(sql) { await pool.query(sql); },
    insertIgnore: (rest) => `INSERT INTO ${rest} ON CONFLICT DO NOTHING`,
    async close() { await pool.end(); },
  };
}

async function openMysql() {
  const { default: mysql } = await import('mysql2/promise');
  const pool = mysql.createPool({
    uri: config.db.url,
    ssl: config.db.ssl ? { rejectUnauthorized: false } : undefined,
    connectionLimit: config.db.poolMax,
    supportBigNumbers: true,
  });
  return {
    async all(sql, params = []) { return (await pool.execute(sql, clean(params)))[0]; },
    async get(sql, params = []) { return (await pool.execute(sql, clean(params)))[0][0]; },
    async run(sql, params = []) { return { changes: (await pool.execute(sql, clean(params)))[0].affectedRows }; },
    async exec(sql) { await pool.query(sql); },
    insertIgnore: (rest) => `INSERT IGNORE INTO ${rest}`,
    async close() { await pool.end(); },
  };
}

// Índice único repetido / referencia rota, sea cual sea el motor.
export const isUniqueError = (error) => error && (error.code === '23505' || error.errno === 1062 || error.errcode === 2067 || error.errcode === 1555 || /UNIQUE constraint failed/.test(error.message || ''));
export const isForeignKeyError = (error) => error && (error.code === '23503' || error.errno === 1451 || error.errno === 1452 || error.errcode === 787 || /FOREIGN KEY constraint failed/.test(error.message || ''));

export async function openDatabase() {
  const open = { sqlite: openSqlite, postgres: openPostgres, mysql: openMysql }[config.db.client];
  const db = await open();
  for (const statement of schema(TYPES[config.db.client])) await db.exec(statement);
  for (const [name, target] of INDEXES) {
    if (config.db.client === 'mysql') {
      const table = target.split(' ')[0];
      const exists = await db.get('SELECT 1 AS ok FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1', [table, name]);
      if (!exists) await db.exec(`CREATE INDEX ${name} ON ${target}`);
    } else {
      await db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${target}`);
    }
  }
  db.client = config.db.client;
  return db;
}

const { Pool } = require('pg')
const crypto = require('crypto')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway.internal') ? false : { rejectUnauthorized: false }
})

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      email TEXT NOT NULL,
      name TEXT,
      avatar TEXT,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (provider, provider_id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY,
      admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
  `)
}

async function seedAdmin(username, password) {
  if (!username || !password) return
  const existing = await pool.query('SELECT id FROM admins WHERE username = $1', [username])
  if (existing.rows.length) return
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, 64).toString('hex')
  await pool.query(
    'INSERT INTO admins (username, password_hash) VALUES ($1, $2)',
    [username, `${salt}:${hash}`]
  )
  console.log(`Admin "${username}" seeded`)
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex')
}

async function verifyAdmin(username, password) {
  const result = await pool.query('SELECT * FROM admins WHERE username = $1', [username])
  if (!result.rows.length) return null
  const admin = result.rows[0]
  const [salt, hash] = admin.password_hash.split(':')
  const candidate = hashPassword(password, salt)
  if (candidate !== hash) return null
  return { id: admin.id, username: admin.username }
}

async function createAdminSession(adminId) {
  const token = crypto.randomBytes(32).toString('hex')
  await pool.query(
    "INSERT INTO admin_sessions (token, admin_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '7 days')",
    [token, adminId]
  )
  return token
}

async function getAdminBySession(token) {
  if (!token) return null
  const result = await pool.query(
    `SELECT a.id, a.username
     FROM admin_sessions s
     JOIN admins a ON a.id = s.admin_id
     WHERE s.token = $1 AND s.expires_at > NOW()`,
    [token]
  )
  return result.rows[0] || null
}

async function deleteAdminSession(token) {
  if (!token) return
  await pool.query('DELETE FROM admin_sessions WHERE token = $1', [token])
}

async function upsertUser({ provider, providerId, email, name, avatar }) {
  const result = await pool.query(
    `INSERT INTO users (provider, provider_id, email, name, avatar)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (provider, provider_id)
     DO UPDATE SET
       email = EXCLUDED.email,
       name = COALESCE(EXCLUDED.name, users.name),
       avatar = COALESCE(EXCLUDED.avatar, users.avatar)
     RETURNING id, provider, email, name, avatar, is_admin`,
    [provider, providerId, email, name, avatar]
  )
  return result.rows[0]
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex')
  await pool.query(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')",
    [token, userId]
  )
  return token
}

async function getUserBySession(token) {
  if (!token) return null
  const result = await pool.query(
    `SELECT u.id, u.provider, u.email, u.name, u.avatar, u.is_admin
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > NOW()`,
    [token]
  )
  return result.rows[0] || null
}

async function deleteSession(token) {
  if (!token) return
  await pool.query('DELETE FROM sessions WHERE token = $1', [token])
}

async function listUsers() {
  const result = await pool.query(
    'SELECT id, provider, email, name, avatar, is_admin, created_at FROM users ORDER BY created_at DESC'
  )
  return result.rows
}

module.exports = {
  pool, initSchema, seedAdmin, verifyAdmin, createAdminSession, getAdminBySession, deleteAdminSession,
  upsertUser, createSession, getUserBySession, deleteSession, listUsers
}
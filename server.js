const express = require('express')
const cookieParser = require('cookie-parser')
const crypto = require('crypto')
const db = require('./db')

const app = express()
app.use(cookieParser())
app.use(express.json())

const PORT = process.env.PORT || 3000
const FRONTEND = process.env.PUBLIC_FRONTEND || 'https://restaurant-luxe.pp.ua'
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me'
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || ''
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || ''
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || ''
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''
const COOKIE = 'luxe_session'
const ADMIN_COOKIE = 'luxe_admin'
const STATE_COOKIE = 'luxe_oauth_state'

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', FRONTEND)
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

const redirectUri = () => `${reqProtocol()}://${reqHost()}/api/auth/google/callback`

function reqProtocol() {
  return process.env.NODE_ENV === 'production' ? 'https' : 'http'
}

function reqHost() {
  return 'auth.restaurant-luxe.pp.ua'
}

function jsonError(res, status, message) {
  res.status(status).json({ error: message })
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true })
})

app.get('/api/auth/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return jsonError(res, 503, 'Google OAuth не настроен. Добавьте GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET на сервере.')
  }
  const state = crypto.randomBytes(24).toString('hex')
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    prompt: 'select_account',
    state
  })
  res.cookie(STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: 10 * 60 * 1000
  })
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)
})

app.get('/api/auth/google/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query
    if (error) return res.redirect(`${FRONTEND}/auth.html?error=${encodeURIComponent(error)}`)
    if (!code || !state || state !== req.cookies[STATE_COOKIE]) {
      return res.redirect(`${FRONTEND}/auth.html?error=invalid_state`)
    }
    res.clearCookie(STATE_COOKIE, { httpOnly: true, secure: true, sameSite: 'none' })

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri(),
        grant_type: 'authorization_code'
      })
    })
    if (!tokenRes.ok) {
      console.error('token exchange failed', tokenRes.status, await tokenRes.text())
      return res.redirect(`${FRONTEND}/auth.html?error=token_exchange`)
    }
    const tokens = await tokenRes.json()

    const userRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    })
    if (!userRes.ok) {
      console.error('userinfo failed', userRes.status, await userRes.text())
      return res.redirect(`${FRONTEND}/auth.html?error=userinfo`)
    }
    const profile = await userRes.json()

    const user = await db.upsertUser({
      provider: 'google',
      providerId: profile.sub,
      email: profile.email || '',
      name: profile.name || null,
      avatar: profile.picture || null
    })

    const sessionToken = await db.createSession(user.id)
    res.cookie(COOKIE, sessionToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      maxAge: 30 * 24 * 60 * 60 * 1000
    })
    res.redirect(`${FRONTEND}/dashboard.html`)
  } catch (err) {
    console.error('google callback error', err)
    res.redirect(`${FRONTEND}/auth.html?error=server_error`)
  }
})

const googleKeysCache = { keys: null, at: 0 }

async function getGoogleKeys() {
  if (googleKeysCache.keys && Date.now() - googleKeysCache.at < 3600 * 1000) {
    return googleKeysCache.keys
  }
  const res = await fetch('https://www.googleapis.com/oauth2/v3/certs')
  if (!res.ok) throw new Error(`jwks fetch failed: ${res.status}`)
  const data = await res.json()
  googleKeysCache.keys = data.keys
  googleKeysCache.at = Date.now()
  return data.keys
}

function verifyGoogleToken(token, keys) {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [h, p, s] = parts
  let header, payload
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString())
    payload = JSON.parse(Buffer.from(p, 'base64url').toString())
  } catch {
    return null
  }
  const key = keys.find(k => k.kid === header.kid && k.use === 'sig')
  if (!key) return null
  let publicKey
  try {
    publicKey = crypto.createPublicKey({ key: { kty: 'RSA', n: key.n, e: key.e }, format: 'jwk' })
  } catch {
    return null
  }
  const valid = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url'))
  if (!valid) return null
  const now = Math.floor(Date.now() / 1000)
  if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') return null
  if (payload.aud !== GOOGLE_CLIENT_ID) return null
  if (!payload.exp || payload.exp < now) return null
  return payload
}

app.post('/api/auth/google/token', async (req, res) => {
  try {
    const { token } = req.body || {}
    if (!token) return jsonError(res, 400, 'Токен не передан')
    const keys = await getGoogleKeys()
    const profile = verifyGoogleToken(String(token), keys)
    if (!profile) return jsonError(res, 401, 'Недействительный токен Google')

    const user = await db.upsertUser({
      provider: 'google',
      providerId: profile.sub,
      email: profile.email || '',
      name: profile.name || null,
      avatar: profile.picture || null
    })

    const sessionToken = await db.createSession(user.id)
    res.cookie(COOKIE, sessionToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      maxAge: 30 * 24 * 60 * 60 * 1000
    })
    res.json({ ok: true, user })
  } catch (err) {
    console.error('google token error', err)
    jsonError(res, 500, 'Внутренняя ошибка сервера')
  }
})

app.get('/api/auth/me', async (req, res) => {
  const user = await db.getUserBySession(req.cookies[COOKIE])
  if (!user) return jsonError(res, 401, 'Не авторизован')
  res.json({ user })
})

app.post('/api/auth/logout', async (req, res) => {
  await db.deleteSession(req.cookies[COOKIE])
  res.clearCookie(COOKIE, { httpOnly: true, secure: true, sameSite: 'none' })
  res.json({ ok: true })
})

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body || {}
  if (!username || !password) return jsonError(res, 400, 'Укажите логин и пароль')
  const admin = await db.verifyAdmin(String(username), String(password))
  if (!admin) return jsonError(res, 401, 'Неверный логин или пароль')
  const token = await db.createAdminSession(admin.id)
  res.cookie(ADMIN_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: 7 * 24 * 60 * 60 * 1000
  })
  res.json({ ok: true, admin })
})

app.get('/api/admin/check', async (req, res) => {
  const admin = await db.getAdminBySession(req.cookies[ADMIN_COOKIE])
  if (!admin) return jsonError(res, 401, 'Не авторизован')
  res.json({ admin })
})

app.post('/api/admin/logout', async (req, res) => {
  await db.deleteAdminSession(req.cookies[ADMIN_COOKIE])
  res.clearCookie(ADMIN_COOKIE, { httpOnly: true, secure: true, sameSite: 'none' })
  res.json({ ok: true })
})

app.get('/api/admin/users', async (req, res) => {
  const admin = await db.getAdminBySession(req.cookies[ADMIN_COOKIE])
  if (!admin) return jsonError(res, 401, 'Не авторизован')
  const users = await db.listUsers()
  res.json({ users })
})

app.use((err, req, res, next) => {
  console.error(err)
  jsonError(res, 500, 'Внутренняя ошибка сервера')
})

db.initSchema()
  .then(() => db.seedAdmin(ADMIN_USERNAME, ADMIN_PASSWORD))
  .then(() => {
    app.listen(PORT, () => console.log(`LUXE API listening on port ${PORT}`))
  })
  .catch((err) => {
    console.error('Failed to init database', err)
    process.exit(1)
  })
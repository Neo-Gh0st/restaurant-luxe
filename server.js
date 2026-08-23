const express = require('express')
const cookieParser = require('cookie-parser')
const crypto = require('crypto')
const db = require('./db')
const telegram = require('./telegram')

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
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
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

/* ---- Public Booking APIs ---- */

const HALL_ALIASES = {
  'Основной зал': 'Основний зал',
  'Терраса': 'Тераса'
}

function normalizeHall(hall) {
  if (!hall) return 'Основний зал'
  return HALL_ALIASES[hall] || hall
}

app.post('/api/bookings', async (req, res) => {
  try {
    // Бронювання доступне лише авторизованим клієнтам
    const user = await db.getUserBySession(req.cookies[COOKIE])
    if (!user) {
      return jsonError(res, 401, 'Увійдіть через Google, щоб забронювати столик')
    }

    const { guest_name, phone, booking_date, booking_time, guests_count, hall, table_num, notes } = req.body || {}
    if (!booking_date || !booking_time) {
      return jsonError(res, 400, 'Вкажіть дату та час бронювання')
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(booking_date)) || isNaN(Date.parse(booking_date))) {
      return jsonError(res, 400, 'Некоректна дата бронювання')
    }
    const bookingDay = new Date(booking_date)
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const maxDay = new Date(today)
    maxDay.setFullYear(maxDay.getFullYear() + 1)
    if (bookingDay < today || bookingDay > maxDay) {
      return jsonError(res, 400, 'Дата має бути від сьогодні до одного року вперед')
    }
    if (!/^\d{1,2}:\d{2}$/.test(String(booking_time))) {
      return jsonError(res, 400, 'Некоректний час бронювання')
    }

    const normalizedHall = normalizeHall(hall)

    let booking = await db.createBooking({
      user_id: user.id,
      guest_name: guest_name || user.name || user.email,
      phone,
      booking_date,
      booking_time,
      guests_count: parseInt(guests_count) || 2,
      hall: normalizedHall,
      table_num: table_num ? parseInt(table_num) : null,
      notes
    })

    // Автоматично закріплюємо вільний столик у обраному залі
    const table = await db.findFreeTable(normalizedHall, guests_count)
    if (table) {
      await db.updateTableStatus(table.id, 'reserved')
      booking = await db.assignBookingTable(booking.id, table.number)
    }

    const botUsername = 'LUXE_Restaurant_bot'
    const telegramUrl = `https://t.me/${botUsername}?start=${booking.booking_code}`

    res.json({
      ok: true,
      booking,
      telegramUrl,
      table: table ? { number: table.number, hall: table.hall, capacity: table.capacity } : null
    })
  } catch (err) {
    console.error('Error creating booking:', err)
    jsonError(res, 500, 'Не вдалося створити бронювання')
  }
})

app.get('/api/bookings/:code/status', async (req, res) => {
  try {
    const booking = await db.getBookingByCode(req.params.code)
    if (!booking) return jsonError(res, 404, 'Бронювання не знайдено')
    res.json({ ok: true, booking })
  } catch (err) {
    jsonError(res, 500, 'Помилка отримання статусу')
  }
})

app.get('/api/my/bookings', async (req, res) => {
  try {
    const user = await db.getUserBySession(req.cookies[COOKIE])
    if (!user) return jsonError(res, 401, 'Не авторизовано')
    const bookings = await db.listUserBookings(user.id)
    res.json({ ok: true, bookings })
  } catch (err) {
    console.error('Error listing user bookings:', err)
    jsonError(res, 500, 'Помилка отримання бронювань')
  }
})

/* ---- Google OAuth ---- */

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
    if (!token) return jsonError(res, 400, 'Токен не передано')
    const keys = await getGoogleKeys()
    const profile = verifyGoogleToken(String(token), keys)
    if (!profile) return jsonError(res, 401, 'Недійсний токен Google')

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
    jsonError(res, 500, 'Внутрішня помилка сервера')
  }
})

app.get('/api/auth/me', async (req, res) => {
  const user = await db.getUserBySession(req.cookies[COOKIE])
  if (!user) return jsonError(res, 401, 'Не авторизовано')
  res.json({ user })
})

app.post('/api/auth/logout', async (req, res) => {
  await db.deleteSession(req.cookies[COOKIE])
  res.clearCookie(COOKIE, { httpOnly: true, secure: true, sameSite: 'none' })
  res.json({ ok: true })
})

/* ---- Admin Auth & Management ---- */

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body || {}
  if (!username || !password) return jsonError(res, 400, 'Вкажіть логін та пароль')
  const admin = await db.verifyAdmin(String(username), String(password))
  if (!admin) return jsonError(res, 401, 'Невірний логін або пароль')
  const token = await db.createAdminSession(admin.id)
  res.cookie(ADMIN_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: 7 * 24 * 60 * 60 * 1000
  })
  res.json({ ok: true, admin })
})

async function requireAdmin(req, res, next) {
  const admin = await db.getAdminBySession(req.cookies[ADMIN_COOKIE])
  if (!admin) return jsonError(res, 401, 'Не авторизовано як адміністратор')
  req.admin = admin
  next()
}

app.get('/api/admin/check', requireAdmin, (req, res) => {
  res.json({ admin: req.admin })
})

app.post('/api/admin/logout', async (req, res) => {
  await db.deleteAdminSession(req.cookies[ADMIN_COOKIE])
  res.clearCookie(ADMIN_COOKIE, { httpOnly: true, secure: true, sameSite: 'none' })
  res.json({ ok: true })
})

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const users = await db.listUsers()
  res.json({ users })
})

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const deleted = await db.deleteUser(req.params.id)
    if (!deleted) return jsonError(res, 404, 'Користувача не знайдено')
    console.log(`User deleted by admin: id=${deleted.id} email=${deleted.email}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting user:', err)
    jsonError(res, 500, 'Помилка видалення користувача')
  }
})

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const stats = await db.getAdminStats()
    res.json({ ok: true, stats })
  } catch (err) {
    jsonError(res, 500, 'Помилка отримання статистики')
  }
})

/* ---- Admin: Bookings ---- */

app.get('/api/admin/bookings', requireAdmin, async (req, res) => {
  try {
    const status = req.query.status || 'all'
    const bookings = await db.listBookings(status)
    res.json({ ok: true, bookings })
  } catch (err) {
    jsonError(res, 500, 'Помилка отримання бронювань')
  }
})

app.patch('/api/admin/bookings/:id', requireAdmin, async (req, res) => {
  try {
    const { status, table_num } = req.body || {}
    const updated = await db.updateBookingStatus(req.params.id, status, table_num)
    if (!updated) return jsonError(res, 404, 'Бронювання не знайдено')
    if (status === 'cancelled' || status === 'completed') {
      await db.releaseBookingTable(updated.hall, updated.table_num)
    }
    res.json({ ok: true, booking: updated })
  } catch (err) {
    jsonError(res, 500, 'Помилка оновлення бронювання')
  }
})

app.delete('/api/admin/bookings/:id', requireAdmin, async (req, res) => {
  try {
    const booking = await db.getBookingById(req.params.id)
    await db.deleteBooking(req.params.id)
    if (booking) {
      await db.releaseBookingTable(booking.hall, booking.table_num)
    }
    res.json({ ok: true })
  } catch (err) {
    jsonError(res, 500, 'Помилка видалення бронювання')
  }
})

/* ---- Public: Halls (для форми бронювання) ---- */

app.get('/api/halls', async (req, res) => {
  try {
    const halls = await db.listHalls()
    res.json({ ok: true, halls })
  } catch (err) {
    jsonError(res, 500, 'Помилка отримання залів')
  }
})

/* ---- Admin: Tables ---- */

app.get('/api/admin/tables', requireAdmin, async (req, res) => {
  try {
    const tables = await db.listTables()
    res.json({ ok: true, tables })
  } catch (err) {
    jsonError(res, 500, 'Помилка отримання столиків')
  }
})

app.post('/api/admin/tables', requireAdmin, async (req, res) => {
  try {
    const { hall, capacity } = req.body || {}
    const hallName = String(hall || '').trim()
    if (!hallName) return jsonError(res, 400, 'Оберіть зал для нового столика')
    const table = await db.createTable({ hall: hallName, capacity })
    res.json({ ok: true, table })
  } catch (err) {
    console.error('Error creating table:', err)
    jsonError(res, 500, 'Помилка додавання столика')
  }
})

app.patch('/api/admin/tables/:id', requireAdmin, async (req, res) => {
  try {
    const { status } = req.body || {}
    const updated = await db.updateTableStatus(req.params.id, status)
    if (!updated) return jsonError(res, 404, 'Столик не знайдено')
    res.json({ ok: true, table: updated })
  } catch (err) {
    jsonError(res, 500, 'Помилка оновлення столика')
  }
})

app.delete('/api/admin/tables/:id', requireAdmin, async (req, res) => {
  try {
    await db.deleteTable(req.params.id)
    res.json({ ok: true })
  } catch (err) {
    jsonError(res, 500, 'Помилка видалення столика')
  }
})

/* ---- Admin: Halls ---- */

app.get('/api/admin/halls', requireAdmin, async (req, res) => {
  try {
    res.json({ ok: true, halls: await db.listHalls() })
  } catch (err) {
    jsonError(res, 500, 'Помилка отримання залів')
  }
})

app.post('/api/admin/halls', requireAdmin, async (req, res) => {
  try {
    const name = String((req.body || {}).name || '').trim()
    if (!name) return jsonError(res, 400, 'Вкажіть назву залу')
    if (name.length > 50) return jsonError(res, 400, 'Назва залу задовга (максимум 50 символів)')
    const hall = await db.createHall(name)
    res.json({ ok: true, hall })
  } catch (err) {
    console.error('Error creating hall:', err)
    jsonError(res, 500, 'Помилка додавання залу')
  }
})

app.delete('/api/admin/halls/:id', requireAdmin, async (req, res) => {
  try {
    const result = await db.deleteHall(req.params.id)
    if (result && result.error) return jsonError(res, 400, result.error)
    res.json({ ok: true })
  } catch (err) {
    jsonError(res, 500, 'Помилка видалення залу')
  }
})

/* ---- Admin: Staff ---- */

app.get('/api/admin/staff', requireAdmin, async (req, res) => {
  try {
    const staff = await db.listStaff()
    res.json({ ok: true, staff })
  } catch (err) {
    jsonError(res, 500, 'Помилка отримання персоналу')
  }
})

app.post('/api/admin/staff', requireAdmin, async (req, res) => {
  try {
    const { name, role, phone, shift_status, notes } = req.body || {}
    if (!name || !role) return jsonError(res, 400, 'Вкажіть ім\'я та посаду')
    const created = await db.createStaff({ name, role, phone, shift_status, notes })
    res.json({ ok: true, staff: created })
  } catch (err) {
    jsonError(res, 500, 'Помилка додавання співробітника')
  }
})

app.patch('/api/admin/staff/:id', requireAdmin, async (req, res) => {
  try {
    const { shift_status } = req.body || {}
    const updated = await db.updateStaffShift(req.params.id, shift_status)
    if (!updated) return jsonError(res, 404, 'Співробітника не знайдено')
    res.json({ ok: true, staff: updated })
  } catch (err) {
    jsonError(res, 500, 'Помилка зміни статусу співробітника')
  }
})

app.delete('/api/admin/staff/:id', requireAdmin, async (req, res) => {
  try {
    await db.deleteStaff(req.params.id)
    res.json({ ok: true })
  } catch (err) {
    jsonError(res, 500, 'Помилка видалення співробітника')
  }
})

/* ---- Admin: Stop List ---- */

app.get('/api/admin/stop-list', requireAdmin, async (req, res) => {
  try {
    const items = await db.listStopList()
    res.json({ ok: true, items })
  } catch (err) {
    jsonError(res, 500, 'Помилка отримання стоп-листа')
  }
})

app.patch('/api/admin/stop-list/:id', requireAdmin, async (req, res) => {
  try {
    const { is_stopped } = req.body || {}
    const updated = await db.toggleStopListItem(req.params.id, is_stopped)
    if (!updated) return jsonError(res, 404, 'Блюдо не найдено')
    res.json({ ok: true, item: updated })
  } catch (err) {
    jsonError(res, 500, 'Ошибка изменения стоп-листа')
  }
})

app.post('/api/admin/stop-list', requireAdmin, async (req, res) => {
  try {
    const { item_name, category } = req.body || {}
    const name = String(item_name || '').trim()
    if (!name) return jsonError(res, 400, 'Вкажіть назву страви')
    if (name.length > 120) return jsonError(res, 400, 'Назва задовга (максимум 120 символів)')
    const item = await db.createStopListItem({
      item_name: name,
      category: String(category || '').trim()
    })
    res.json({ ok: true, item })
  } catch (err) {
    if (err && err.code === '23505') return jsonError(res, 400, 'Така страва вже є у стоп-листі')
    console.error('Error creating stop-list item:', err)
    jsonError(res, 500, 'Помилка додавання страви')
  }
})

app.delete('/api/admin/stop-list/:id', requireAdmin, async (req, res) => {
  try {
    await db.deleteStopListItem(req.params.id)
    res.json({ ok: true })
  } catch (err) {
    jsonError(res, 500, 'Помилка видалення страви')
  }
})

app.use((err, req, res, next) => {
  console.error(err)
  jsonError(res, 500, 'Внутренняя ошибка сервера')
})

db.initSchema()
  .then(() => db.seedAdmin(ADMIN_USERNAME, ADMIN_PASSWORD))
  .then(() => {
    telegram.startTelegramBot()
    app.listen(PORT, () => console.log(`LUXE API listening on port ${PORT}`))
  })
  .catch((err) => {
    console.error('Failed to init database', err)
    process.exit(1)
  })
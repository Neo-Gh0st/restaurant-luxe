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

    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      booking_code TEXT NOT NULL UNIQUE,
      guest_name TEXT NOT NULL,
      phone TEXT,
      telegram_chat_id BIGINT,
      telegram_username TEXT,
      is_phone_verified BOOLEAN NOT NULL DEFAULT FALSE,
      booking_date DATE NOT NULL,
      booking_time TEXT NOT NULL,
      guests_count INTEGER NOT NULL DEFAULT 2,
      hall TEXT NOT NULL DEFAULT 'Основной зал',
      table_num INTEGER,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tables (
      id SERIAL PRIMARY KEY,
      number INTEGER NOT NULL,
      hall TEXT NOT NULL,
      capacity INTEGER NOT NULL DEFAULT 4,
      status TEXT NOT NULL DEFAULT 'free',
      UNIQUE (number, hall)
    );

    CREATE TABLE IF NOT EXISTS staff (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      phone TEXT,
      shift_status TEXT NOT NULL DEFAULT 'off',
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS stop_list (
      id SERIAL PRIMARY KEY,
      item_name TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      is_stopped BOOLEAN NOT NULL DEFAULT FALSE
    );

    UPDATE bookings SET hall = 'Тераса' WHERE hall = 'Терраса';
    UPDATE bookings SET hall = 'Основний зал' WHERE hall = 'Основной зал';
    UPDATE tables SET hall = 'Тераса' WHERE hall = 'Терраса';
    UPDATE tables SET hall = 'Основний зал' WHERE hall = 'Основной зал';

    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id);

    CREATE TABLE IF NOT EXISTS halls (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );
  `)

  await seedTables()
  await seedStaff()
  await seedStopList()
  await seedHalls()
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

async function seedTables() {
  const count = await pool.query('SELECT COUNT(*) FROM tables')
  if (parseInt(count.rows[0].count) > 0) return

  const defaultTables = [
    { number: 1, hall: 'Основний зал', capacity: 2, status: 'free' },
    { number: 2, hall: 'Основний зал', capacity: 4, status: 'free' },
    { number: 3, hall: 'Основний зал', capacity: 4, status: 'free' },
    { number: 4, hall: 'Основний зал', capacity: 6, status: 'free' },
    { number: 5, hall: 'Основний зал', capacity: 8, status: 'free' },
    { number: 6, hall: 'VIP-зона', capacity: 6, status: 'free' },
    { number: 7, hall: 'VIP-зона', capacity: 10, status: 'free' },
    { number: 8, hall: 'VIP-зона', capacity: 12, status: 'free' },
    { number: 9, hall: 'Тераса', capacity: 2, status: 'free' },
    { number: 10, hall: 'Тераса', capacity: 4, status: 'free' },
    { number: 11, hall: 'Тераса', capacity: 4, status: 'free' },
    { number: 12, hall: 'Тераса', capacity: 6, status: 'free' }
  ]

  for (const t of defaultTables) {
    await pool.query(
      'INSERT INTO tables (number, hall, capacity, status) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
      [t.number, t.hall, t.capacity, t.status]
    )
  }
  console.log('Default tables seeded')
}

async function seedStaff() {
  const count = await pool.query('SELECT COUNT(*) FROM staff')
  if (parseInt(count.rows[0].count) > 0) return

  const defaultStaff = [
    { name: 'Олександр Шевченко', role: 'Шеф-кухар', phone: '+380 (50) 111-22-33', shift_status: 'on', notes: 'Головна зміна кухні' },
    { name: 'Олена Ковальчук', role: 'Хостес', phone: '+380 (67) 222-33-44', shift_status: 'on', notes: 'Зустріч гостей, броні' },
    { name: 'Максим Григор’єв', role: 'Старший офіціант', phone: '+380 (93) 333-44-55', shift_status: 'on', notes: 'Основний зал' },
    { name: 'Дмитро Мельник', role: 'Сомельє / Бармен', phone: '+380 (50) 444-55-66', shift_status: 'on', notes: 'Винна карта та авторські коктейлі' },
    { name: 'Анна Ткаченко', role: 'Офіціант VIP', phone: '+380 (68) 555-66-77', shift_status: 'off', notes: 'VIP обслуговування' }
  ]

  for (const s of defaultStaff) {
    await pool.query(
      'INSERT INTO staff (name, role, phone, shift_status, notes) VALUES ($1, $2, $3, $4, $5)',
      [s.name, s.role, s.phone, s.shift_status, s.notes]
    )
  }
  console.log('Default staff seeded')
}

async function seedStopList() {
  const count = await pool.query('SELECT COUNT(*) FROM stop_list')
  if (parseInt(count.rows[0].count) > 0) return
  const defaultItems = [
    { item_name: 'Тартар із мармурової яловичини з трюфелем', category: 'Закуски', is_stopped: false },
    { item_name: 'Севіче з дикого сибаса з манго', category: 'Закуски', is_stopped: false },
    { item_name: 'Стейк Рібай Black Angus (Prime)', category: 'Основні страви', is_stopped: false },
    { item_name: 'Качина грудка Магре з вишневим соусом', category: 'Основні страви', is_stopped: false },
    { item_name: 'Філе чилійського сибаса з шафрановим різотто', category: 'Основні страви', is_stopped: false },
    { item_name: 'Шоколадний фондан із золотим листком', category: 'Десерти', is_stopped: false },
    { item_name: 'Коктейль Royal Gold 24k', category: 'Бар', is_stopped: false }
  ]

  for (const item of defaultItems) {
    await pool.query(
      'INSERT INTO stop_list (item_name, category, is_stopped) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [item.item_name, item.category, item.is_stopped]
    )
  }
  console.log('Default stop list seeded')
}

async function seedHalls() {
  const count = await pool.query('SELECT COUNT(*) FROM halls')
  if (parseInt(count.rows[0].count) > 0) return

  const distinct = await pool.query('SELECT DISTINCT hall FROM tables ORDER BY hall')
  for (const row of distinct.rows) {
    await pool.query('INSERT INTO halls (name) VALUES ($1) ON CONFLICT DO NOTHING', [row.hall])
  }
  console.log('Halls seeded from existing tables')
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

async function deleteUser(id) {
  // sessions мають ON DELETE CASCADE, тому всі сесії авторизації клієнта зникають автоматично
  const result = await pool.query(
    'DELETE FROM users WHERE id = $1 RETURNING id, email, name',
    [id]
  )
  return result.rows[0] || null
}

/* ---- Bookings ---- */

function generateBookingCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)]
  }
  return `LUXE-${code}`
}

async function createBooking({ user_id, guest_name, phone, booking_date, booking_time, guests_count, hall, table_num, notes }) {
  const booking_code = generateBookingCode()
  const result = await pool.query(
    `INSERT INTO bookings (booking_code, user_id, guest_name, phone, booking_date, booking_time, guests_count, hall, table_num, notes, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
     RETURNING *`,
    [booking_code, user_id || null, guest_name || 'Гість', phone || null, booking_date, booking_time, guests_count || 2, hall || 'Основний зал', table_num || null, notes || '']
  )
  return result.rows[0]
}

async function getBookingByCode(booking_code) {
  const result = await pool.query('SELECT * FROM bookings WHERE booking_code = $1', [booking_code])
  return result.rows[0] || null
}

async function getBookingById(id) {
  const result = await pool.query('SELECT * FROM bookings WHERE id = $1', [id])
  return result.rows[0] || null
}

async function verifyBookingWithTelegram(booking_code, verifiedPhone, chatId, username) {
  const result = await pool.query(
    `UPDATE bookings
     SET phone = COALESCE($1, phone),
         telegram_chat_id = $2,
         telegram_username = $3,
         is_phone_verified = TRUE,
         status = 'confirmed'
     WHERE booking_code = $4
     RETURNING *`,
    [verifiedPhone, chatId, username, booking_code]
  )
  return result.rows[0] || null
}

async function listBookings(statusFilter) {
  let query = `SELECT b.*, u.email AS user_email, u.name AS user_name, u.avatar AS user_avatar
               FROM bookings b LEFT JOIN users u ON u.id = b.user_id`
  const params = []
  if (statusFilter && statusFilter !== 'all') {
    query += ' WHERE b.status = $1'
    params.push(statusFilter)
  }
  query += ' ORDER BY b.booking_date ASC, b.booking_time ASC, b.id DESC'
  const result = await pool.query(query, params)
  return result.rows
}

async function updateBookingStatus(id, status, table_num) {
  let query = 'UPDATE bookings SET status = $1'
  const params = [status]
  if (table_num !== undefined && table_num !== null) {
    params.push(table_num)
    query += `, table_num = $${params.length}`
  }
  params.push(id)
  query += ` WHERE id = $${params.length} RETURNING *`
  const result = await pool.query(query, params)
  return result.rows[0] || null
}

async function deleteBooking(id) {
  await pool.query('DELETE FROM bookings WHERE id = $1', [id])
}

async function listUserBookings(userId) {
  const result = await pool.query(
    'SELECT * FROM bookings WHERE user_id = $1 ORDER BY booking_date DESC, booking_time DESC, id DESC',
    [userId]
  )
  return result.rows
}

/* ---- Tables ---- */

async function listTables() {
  const result = await pool.query('SELECT * FROM tables ORDER BY hall, number')
  return result.rows
}

async function updateTableStatus(id, status) {
  const result = await pool.query(
    'UPDATE tables SET status = $1 WHERE id = $2 RETURNING *',
    [status, id]
  )
  return result.rows[0] || null
}

async function createTable({ hall, capacity }) {
  const max = await pool.query(
    'SELECT COALESCE(MAX(number), 0) as m FROM tables WHERE hall = $1',
    [hall]
  )
  const number = parseInt(max.rows[0].m) + 1
  let cap = parseInt(capacity)
  if (isNaN(cap) || cap < 1) cap = 4
  if (cap > 30) cap = 30
  const result = await pool.query(
    "INSERT INTO tables (number, hall, capacity, status) VALUES ($1, $2, $3, 'free') RETURNING *",
    [number, hall, cap]
  )
  return result.rows[0]
}

async function deleteTable(id) {
  await pool.query('DELETE FROM tables WHERE id = $1', [id])
}

/* ---- Halls ---- */

async function listHalls() {
  const result = await pool.query('SELECT * FROM halls ORDER BY id ASC')
  return result.rows
}

async function createHall(name) {
  const result = await pool.query(
    'INSERT INTO halls (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING *',
    [name]
  )
  return result.rows[0]
}

async function deleteHall(id) {
  const found = await pool.query('SELECT * FROM halls WHERE id = $1', [id])
  if (!found.rows.length) return { error: 'Зал не знайдено' }
  const hall = found.rows[0]
  const used = await pool.query('SELECT COUNT(*) as c FROM tables WHERE hall = $1', [hall.name])
  if (parseInt(used.rows[0].c) > 0) {
    return { error: `У залі «${hall.name}» ще є столики (${used.rows[0].c}) — спочатку видаліть їх` }
  }
  await pool.query('DELETE FROM halls WHERE id = $1', [id])
  return { ok: true }
}

async function findFreeTable(hall, guestsCount) {
  let guests = parseInt(guestsCount)
  if (isNaN(guests) || guests < 1 || guests > 20) guests = 2
  const params = [guests]
  let query = "SELECT * FROM tables WHERE status = 'free' AND capacity >= $1"
  if (hall) {
    params.push(hall)
    query += ` AND hall = $${params.length}`
  }
  query += ' ORDER BY capacity ASC, number ASC LIMIT 1'
  const result = await pool.query(query, params)
  return result.rows[0] || null
}

async function assignBookingTable(bookingId, tableNum) {
  const result = await pool.query(
    'UPDATE bookings SET table_num = $1 WHERE id = $2 RETURNING *',
    [tableNum, bookingId]
  )
  return result.rows[0] || null
}

async function releaseBookingTable(hall, tableNum) {
  if (!hall || !tableNum) return
  await pool.query(
    "UPDATE tables SET status = 'free' WHERE hall = $1 AND number = $2 AND status = 'reserved'",
    [hall, tableNum]
  )
}

/* ---- Staff ---- */

async function listStaff() {
  const result = await pool.query('SELECT * FROM staff ORDER BY id ASC')
  return result.rows
}

async function createStaff({ name, role, phone, shift_status, notes }) {
  const result = await pool.query(
    'INSERT INTO staff (name, role, phone, shift_status, notes) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [name, role, phone || null, shift_status || 'off', notes || '']
  )
  return result.rows[0]
}

async function updateStaffShift(id, shift_status) {
  const result = await pool.query(
    'UPDATE staff SET shift_status = $1 WHERE id = $2 RETURNING *',
    [shift_status, id]
  )
  return result.rows[0] || null
}

async function deleteStaff(id) {
  await pool.query('DELETE FROM staff WHERE id = $1', [id])
}

/* ---- Stop List ---- */

async function listStopList() {
  const result = await pool.query('SELECT * FROM stop_list ORDER BY category, id')
  return result.rows
}

async function toggleStopListItem(id, is_stopped) {
  const result = await pool.query(
    'UPDATE stop_list SET is_stopped = $1 WHERE id = $2 RETURNING *',
    [is_stopped, id]
  )
  return result.rows[0] || null
}

async function createStopListItem({ item_name, category }) {
  const result = await pool.query(
    "INSERT INTO stop_list (item_name, category, is_stopped) VALUES ($1, $2, FALSE) RETURNING *",
    [item_name, category || 'Інше']
  )
  return result.rows[0]
}

async function deleteStopListItem(id) {
  await pool.query('DELETE FROM stop_list WHERE id = $1', [id])
}

/* ---- Stats ---- */

async function getAdminStats() {
  const today = new Date().toISOString().split('T')[0]

  const todayBookings = await pool.query(
    'SELECT COUNT(*) as count, COALESCE(SUM(guests_count), 0) as guests FROM bookings WHERE booking_date = $1',
    [today]
  )

  const pendingBookings = await pool.query(
    "SELECT COUNT(*) as count FROM bookings WHERE status = 'pending'"
  )

  const tablesOccupied = await pool.query(
    "SELECT COUNT(*) as count, (SELECT COUNT(*) FROM tables) as total FROM tables WHERE status != 'free'"
  )

  const staffOnShift = await pool.query(
    "SELECT COUNT(*) as count, (SELECT COUNT(*) FROM staff) as total FROM staff WHERE shift_status = 'on'"
  )

  return {
    today_bookings: parseInt(todayBookings.rows[0].count),
    today_guests: parseInt(todayBookings.rows[0].guests),
    pending_bookings: parseInt(pendingBookings.rows[0].count),
    occupied_tables: parseInt(tablesOccupied.rows[0].count),
    total_tables: parseInt(tablesOccupied.rows[0].total),
    staff_on_shift: parseInt(staffOnShift.rows[0].count),
    total_staff: parseInt(staffOnShift.rows[0].total)
  }
}

module.exports = {
  pool,
  initSchema,
  seedAdmin,
  verifyAdmin,
  createAdminSession,
  getAdminBySession,
  deleteAdminSession,
  upsertUser,
  createSession,
  getUserBySession,
  deleteSession,
  listUsers,
  deleteUser,
  createBooking,
  getBookingByCode,
  getBookingById,
  verifyBookingWithTelegram,
  listBookings,
  listUserBookings,
  updateBookingStatus,
  deleteBooking,
  listTables,
  updateTableStatus,
  createTable,
  deleteTable,
  listHalls,
  createHall,
  deleteHall,
  findFreeTable,
  assignBookingTable,
  releaseBookingTable,
  listStaff,
  createStaff,
  updateStaffShift,
  deleteStaff,
  listStopList,
  toggleStopListItem,
  createStopListItem,
  deleteStopListItem,
  getAdminStats
}
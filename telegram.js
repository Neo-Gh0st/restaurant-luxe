const db = require('./db')

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8725631050:AAGeQTNPxt_tlA9VxiZiZNHpGamj-2eUfxs'
const pendingVerifications = new Map() // chatId -> bookingCode

let isPolling = false
let lastUpdateId = 0

async function tgApi(method, body = {}) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    return await res.json()
  } catch (err) {
    console.error(`Telegram API error (${method}):`, err.message)
    return { ok: false }
  }
}

async function handleMessage(msg) {
  if (!msg || !msg.chat) return
  const chatId = msg.chat.id
  const text = (msg.text || '').trim()
  const username = msg.from ? (msg.from.username || msg.from.first_name || '') : ''

  // /start command with code: /start LUXE-XXXX or /start book_LUXE-XXXX
  if (text.startsWith('/start')) {
    const parts = text.split(' ')
    let code = (parts[1] || '').trim()
    if (code.startsWith('book_')) {
      code = code.replace('book_', '')
    }

    if (!code) {
      return tgApi('sendMessage', {
        chat_id: chatId,
        text: 'Ласкаво просимо до бота ресторану LUXE! ✨\n\nДля підтвердження бронювання перейдіть за посиланням зі сторінки бронювання на нашому сайті: https://restaurant-luxe.pp.ua/booking.html'
      })
    }

    const booking = await db.getBookingByCode(code)
    if (!booking) {
      return tgApi('sendMessage', {
        chat_id: chatId,
        text: `⚠️ Бронювання з кодом "${code}" не знайдено або застаріло. Будь ласка, перевірте посилання на сайті.`
      })
    }

    pendingVerifications.set(chatId, booking.booking_code)

    const dateStr = new Date(booking.booking_date).toLocaleDateString('uk-UA')
    const msgText = `Вітаємо, ${booking.guest_name || 'Гість'}! 🥂\n\n` +
      `Ви оформлюєте бронювання в ресторані LUXE:\n` +
      `📅 Дата: ${dateStr}\n` +
      `⏰ Час: ${booking.booking_time}\n` +
      `👥 Гостей: ${booking.guests_count}\n` +
      `🏛 Зал: ${booking.hall}\n` +
      `🔖 Код: ${booking.booking_code}\n\n` +
      `Щоб завершити підтвердження та закріпити за вами столик, натисніть кнопку нижче ⬇️`

    return tgApi('sendMessage', {
      chat_id: chatId,
      text: msgText,
      reply_markup: {
        keyboard: [
          [
            {
              text: '📱 Поділитися номером телефону для підтвердження',
              request_contact: true
            }
          ]
        ],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    })
  }

  // Handle Contact message
  if (msg.contact && msg.contact.phone_number) {
    const rawPhone = msg.contact.phone_number
    const formattedPhone = rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`
    const bookingCode = pendingVerifications.get(chatId)

    if (!bookingCode) {
      return tgApi('sendMessage', {
        chat_id: chatId,
        text: 'Дякуємо за контакт! Якщо ви оформлюєте бронь, перейдіть за посиланням з сайту.',
        reply_markup: { remove_keyboard: true }
      })
    }

    const updated = await db.verifyBookingWithTelegram(bookingCode, formattedPhone, chatId, username)
    pendingVerifications.delete(chatId)

    if (updated) {
      const dateStr = new Date(updated.booking_date).toLocaleDateString('uk-UA')
      const tableLine = updated.table_num
        ? `🍽️ Столик: №${updated.table_num} (${updated.hall})\n`
        : ''
      return tgApi('sendMessage', {
        chat_id: chatId,
        text: `✅ Бронювання успішно підтверджено!\n\n` +
          `🍽️ Ресторан LUXE чекає на вас!\n` +
          `📅 Дата: ${dateStr}\n` +
          `⏰ Час: ${updated.booking_time}\n` +
          `👥 Гостей: ${updated.guests_count}\n` +
          `🏛 Зал: ${updated.hall}\n` +
          tableLine +
          `📱 Телефон: ${formattedPhone}\n` +
          `🔖 Код: ${updated.booking_code}\n\n` +
          `До зустрічі! ✨`,
        reply_markup: { remove_keyboard: true }
      })
    } else {
      return tgApi('sendMessage', {
        chat_id: chatId,
        text: 'Не вдалося оновити статус броні. Будь ласка, зверніться до адміністратора ресторану.',
        reply_markup: { remove_keyboard: true }
      })
    }
  }

  // Default response for other messages
  if (text) {
    return tgApi('sendMessage', {
      chat_id: chatId,
      text: 'Для бронювання столиків відвідайте наш сайт: https://restaurant-luxe.pp.ua\nКонтакти: +380 (44) 123-45-67'
    })
  }
}

async function pollUpdates() {
  if (!isPolling) return

  try {
    const res = await tgApi('getUpdates', {
      offset: lastUpdateId + 1,
      timeout: 25,
      allowed_updates: ['message']
    })

    if (res.ok && Array.isArray(res.result)) {
      for (const update of res.result) {
        lastUpdateId = update.update_id
        if (update.message) {
          await handleMessage(update.message)
        }
      }
    }
  } catch (err) {
    console.error('Telegram polling error:', err.message)
  }

  if (isPolling) {
    setTimeout(pollUpdates, 1000)
  }
}

function startTelegramBot() {
  if (isPolling) return
  isPolling = true
  console.log('Starting Telegram Bot polling for @LUXE_Restaurant_bot...')
  pollUpdates()
}

function stopTelegramBot() {
  isPolling = false
}

module.exports = {
  startTelegramBot,
  stopTelegramBot,
  tgApi
}

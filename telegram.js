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
        text: 'Добро пожаловать в бот ресторана LUXE! ✨\n\nДля подтверждения бронирования перейдите по ссылке со страницы бронирования на нашем сайте: https://restaurant-luxe.pp.ua/booking.html'
      })
    }

    const booking = await db.getBookingByCode(code)
    if (!booking) {
      return tgApi('sendMessage', {
        chat_id: chatId,
        text: `⚠️ Бронирование с кодом "${code}" не найдено или устарело. Пожалуйста, проверьте ссылку на сайте.`
      })
    }

    pendingVerifications.set(chatId, booking.booking_code)

    const dateStr = new Date(booking.booking_date).toLocaleDateString('ru-RU')
    const msgText = `Здравствуйте, ${booking.guest_name || 'Гость'}! 🥂\n\n` +
      `Вы оформляете бронирование в ресторане LUXE:\n` +
      `📅 Дата: ${dateStr}\n` +
      `⏰ Время: ${booking.booking_time}\n` +
      `👥 Гостей: ${booking.guests_count}\n` +
      `🏛 Зал: ${booking.hall}\n` +
      `🔖 Код: ${booking.booking_code}\n\n` +
      `Чтобы завершить подтверждение и закрепить за вами столик, нажмите кнопку ниже ⬇️`

    return tgApi('sendMessage', {
      chat_id: chatId,
      text: msgText,
      reply_markup: {
        keyboard: [
          [
            {
              text: '📱 Поделиться номером телефона для подтверждения',
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
        text: 'Спасибо за контакт! Если вы оформляете бронь, перейдите по ссылке с сайта.',
        reply_markup: { remove_keyboard: true }
      })
    }

    const updated = await db.verifyBookingWithTelegram(bookingCode, formattedPhone, chatId, username)
    pendingVerifications.delete(chatId)

    if (updated) {
      const dateStr = new Date(updated.booking_date).toLocaleDateString('ru-RU')
      return tgApi('sendMessage', {
        chat_id: chatId,
        text: `✅ Бронирование успешно подтверждено!\n\n` +
          `🍽️ Ресторан LUXE ждет вас!\n` +
          `📅 Дата: ${dateStr}\n` +
          `⏰ Время: ${updated.booking_time}\n` +
          `👥 Гостей: ${updated.guests_count}\n` +
          `🏛 Зал: ${updated.hall}\n` +
          `📱 Телефон: ${formattedPhone}\n` +
          `🔖 Код: ${updated.booking_code}\n\n` +
          `Администратор подготовит лучший столик к вашему визиту. До встречи! ✨`,
        reply_markup: { remove_keyboard: true }
      })
    } else {
      return tgApi('sendMessage', {
        chat_id: chatId,
        text: 'Не удалось обновить статус брони. Пожалуйста, обратитесь к администратору ресторана.',
        reply_markup: { remove_keyboard: true }
      })
    }
  }

  // Default response for other messages
  if (text) {
    return tgApi('sendMessage', {
      chat_id: chatId,
      text: 'Для бронирования столиков посетите наш сайт: https://restaurant-luxe.pp.ua\nКонтакты: +380 (44) 123-45-67'
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

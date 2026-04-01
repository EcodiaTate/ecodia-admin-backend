const db = require('../../config/db')

async function createNotification({ type, message, link, metadata }) {
  const [notif] = await db`
    INSERT INTO notifications (type, message, link, metadata)
    VALUES (${type}, ${message}, ${link || null}, ${metadata || {}})
    RETURNING *
  `
  return notif
}

async function getUnreadNotifications(limit = 50) {
  return db`
    SELECT * FROM notifications
    WHERE read = false
    ORDER BY created_at DESC
    LIMIT ${limit}
  `
}

async function markNotificationRead(id) {
  return db`UPDATE notifications SET read = true WHERE id = ${id}`
}

async function markAllNotificationsRead() {
  return db`UPDATE notifications SET read = true WHERE read = false`
}

module.exports = { createNotification, getUnreadNotifications, markNotificationRead, markAllNotificationsRead }

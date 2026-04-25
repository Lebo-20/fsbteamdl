const Database = require('better-sqlite3');
const db = new Database('C:/BOT TEAM DL/fsub_bot/bot_database.db');
try {
  console.log('User count:', db.prepare('SELECT COUNT(*) as count FROM users').get());
  console.log('Video count:', db.prepare('SELECT COUNT(*) as count FROM videos').get());
  console.log('Pending payments:', db.prepare('SELECT COUNT(*) as count FROM payments WHERE status = "PENDING"').get());
  console.log('VIP active:', db.prepare("SELECT COUNT(*) as count FROM users WHERE vip_until > datetime('now')").get());
} catch (err) {
  console.error('FAILED QUERY:', err.message);
}

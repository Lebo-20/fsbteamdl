const Database = require('better-sqlite3');
const db = new Database('C:/BOT TEAM DL/fsub_bot/bot_database.db');
try {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log('Tables:', tables);
  
  for (const table of tables) {
    const columns = db.prepare(`PRAGMA table_info(${table.name})`).all();
    console.log(`Columns for ${table.name}:`, columns.map(c => c.name));
  }
} catch (err) {
  console.error(err);
}

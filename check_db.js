import Database from 'better-sqlite3';
const db = new Database('economy.db');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
for (const t of tables) {
  console.log(t.name, db.prepare(`SELECT count(*) as c FROM ${t.name}`).get().c);
}

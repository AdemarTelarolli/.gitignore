const Database = require("better-sqlite3");
const db = new Database("data.sqlite");

db.exec(`
CREATE TABLE IF NOT EXISTS verified_users (
  user_id TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at INTEGER,
  verified_at INTEGER NOT NULL
);
`);

module.exports = {
  upsert(u) {
    db.prepare(`
      INSERT INTO verified_users (user_id, access_token, refresh_token, expires_at, verified_at)
      VALUES (@user_id, @access_token, @refresh_token, @expires_at, @verified_at)
      ON CONFLICT(user_id) DO UPDATE SET
        access_token=excluded.access_token,
        refresh_token=excluded.refresh_token,
        expires_at=excluded.expires_at,
        verified_at=excluded.verified_at
    `).run(u);
  },
  all() {
    return db.prepare(`SELECT * FROM verified_users`).all();
  }
};

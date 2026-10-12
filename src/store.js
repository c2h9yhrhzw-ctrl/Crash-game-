
const Database = require("better-sqlite3");
const fs = require("node:fs");
const path = require("node:path");

const dataDir = path.join(process.cwd(), "data");
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "app.db"));

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    type TEXT NOT NULL,
    reference TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    round_id TEXT NOT NULL,
    stake INTEGER NOT NULL CHECK (stake > 0),
    status TEXT NOT NULL DEFAULT 'active',
    payout INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_ledger_user
    ON ledger(user_id);

  CREATE INDEX IF NOT EXISTS idx_bets_round
    ON bets(round_id);

  CREATE INDEX IF NOT EXISTS idx_bets_user
    ON bets(user_id);
`);

const STARTING_CREDITS = Math.max(
  0,
  Number.parseInt(process.env.STARTING_VIRTUAL_CREDITS || "1000", 10) || 1000
);

const createUserTransaction = db.transaction((email, passwordHash) => {
  const result = db.prepare(`
    INSERT INTO users (email, password_hash)
    VALUES (?, ?)
  `).run(email, passwordHash);

  const userId = Number(result.lastInsertRowid);

  if (STARTING_CREDITS > 0) {
    db.prepare(`
      INSERT INTO ledger (user_id, amount, type, reference)
      VALUES (?, ?, 'signup_bonus', 'initial_virtual_credits')
    `).run(userId, STARTING_CREDITS);
  }

  return userId;
});

function createUser(email, passwordHash) {
  return createUserTransaction(email, passwordHash);
}

function findUserByEmail(email) {
  return db.prepare(`
    SELECT id, email, password_hash, created_at
    FROM users
    WHERE email = ?
  `).get(email);
}

function getUserById(userId) {
  return db.prepare(`
    SELECT id, email, created_at
    FROM users
    WHERE id = ?
  `).get(userId);
}

function getBalance(userId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS balance
    FROM ledger
    WHERE user_id = ?
  `).get(userId);

  return row.balance;
}

const placeBetTransaction = db.transaction(
  (userId, roundId, stake) => {
    if (!Number.isSafeInteger(stake) || stake <= 0) {
      throw new Error("Invalid stake amount.");
    }

    const user = db.prepare(
      "SELECT id FROM users WHERE id = ?"
    ).get(userId);

    if (!user) {
      throw new Error("User not found.");
    }

    const balance = getBalance(userId);

    if (balance < stake) {
      throw new Error("Insufficient virtual credits.");
    }

    const bet = db.prepare(`
      INSERT INTO bets (user_id, round_id, stake, status)
      VALUES (?, ?, ?, 'active')
    `).run(userId, roundId, stake);

    db.prepare(`
      INSERT INTO ledger (user_id, amount, type, reference)
      VALUES (?, ?, 'bet_stake', ?)
    `).run(userId, -stake, String(bet.lastInsertRowid));

    return {
      betId: Number(bet.lastInsertRowid),
      balance: getBalance(userId)
    };
  }
);

function placeBet(userId, roundId, stake) {
  return placeBetTransaction(userId, roundId, stake);
}

function getBetsForRound(roundId) {
  return db.prepare(`
    SELECT id, user_id, round_id, stake, status, payout, created_at
    FROM bets
    WHERE round_id = ?
    ORDER BY id ASC
  `).all(roundId);
}

function getBetsForUser(userId, limit = 20) {
  const safeLimit = Math.min(
    100,
    Math.max(1, Number.parseInt(limit, 10) || 20)
  );

  return db.prepare(`
    SELECT id, round_id, stake, status, payout, created_at
    FROM bets
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(userId, safeLimit);
}

const settleBetTransaction = db.transaction(
  (betId, status, payout) => {
    if (!["won", "lost", "cancelled"].includes(status)) {
      throw new Error("Invalid bet status.");
    }

    if (!Number.isSafeInteger(payout) || payout < 0) {
      throw new Error("Invalid payout.");
    }

    if (status === "lost" && payout !== 0) {
      throw new Error("A lost bet cannot have a payout.");
    }

    const bet = db.prepare(`
      SELECT id, user_id, stake, status
      FROM bets
      WHERE id = ?
    `).get(betId);

    if (!bet) {
      throw new Error("Bet not found.");
    }

    if (bet.status !== "active") {
      throw new Error("Bet has already been settled.");
    }

    if (status === "cancelled" && payout !== bet.stake) {
      throw new Error("Cancelled bets must return the original stake.");
    }

    db.prepare(`
      UPDATE bets
      SET status = ?, payout = ?
      WHERE id = ? AND status = 'active'
    `).run(status, payout, betId);

    if (payout > 0) {
      db.prepare(`
        INSERT INTO ledger (user_id, amount, type, reference)
        VALUES (?, ?, ?, ?)
      `).run(
        bet.user_id,
        payout,
        status === "cancelled" ? "bet_refund" : "bet_payout",
        String(betId)
      );
    }

    return {
      betId,
      status,
      payout,
      balance: getBalance(bet.user_id)
    };
  }
);

function settleBet(betId, status, payout = 0) {
  return settleBetTransaction(betId, status, payout);
}

module.exports = {
  db,
  createUser,
  findUserByEmail,
  getUserById,
  getBalance,
  placeBet,
  getBetsForRound,
  getBetsForUser,
  settleBet
};

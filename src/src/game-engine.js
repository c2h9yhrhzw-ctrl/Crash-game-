
const crypto = require("node:crypto");
const EventEmitter = require("node:events");
const store = require("./store");

const events = new EventEmitter();

const BETTING_MS = Math.max(
  3000,
  Number.parseInt(process.env.ROUND_BETTING_MS || "8000", 10) || 8000
);

const TICK_MS = Math.max(
  100,
  Number.parseInt(process.env.ROUND_TICK_MS || "100", 10) || 100
);

const HOUSE_EDGE = 0.03;
const MAX_MULTIPLIER = 1000;

let currentRound = null;
let roundCounter = 0;
let timer = null;

function randomCrashPoint() {
  const bytes = crypto.randomBytes(4);
  const number = bytes.readUInt32BE(0);

  // Educational virtual-credit model; not independently audited
  // and not suitable for real-money gambling.
  const r = (number + 1) / 4294967297;
  const raw = (1 - HOUSE_EDGE) / r;

  return Math.max(1, Math.min(MAX_MULTIPLIER, Math.floor(raw * 100) / 100));
}

function publicRound() {
  if (!currentRound) return null;

  return {
    id: currentRound.id,
    status: currentRound.status,
    bettingEndsAt: currentRound.bettingEndsAt,
    startedAt: currentRound.startedAt,
    multiplier: currentRound.status === "running"
      ? currentMultiplier()
      : 1,
    crashPoint: currentRound.status === "crashed"
      ? currentRound.crashPoint
      : undefined
  };
}

function currentMultiplier() {
  if (!currentRound || currentRound.status !== "running") return 1;

  const elapsed = Math.max(0, Date.now() - currentRound.startedAt);

  // Smooth, exponential-style growth.
  return Math.floor(Math.exp(elapsed / 10000) * 100) / 100;
}

function startRound() {
  roundCounter += 1;

  currentRound = {
    id: `round-${Date.now()}-${roundCounter}`,
    status: "betting",
    bettingEndsAt: Date.now() + BETTING_MS,
    startedAt: null,
    crashPoint: null,
    cashedOut: new Set()
  };

  events.emit("round", publicRound());

  timer = setTimeout(beginRunning, BETTING_MS);
}

function beginRunning() {
  if (!currentRound || currentRound.status !== "betting") return;

  currentRound.status = "running";
  currentRound.startedAt = Date.now();
  currentRound.crashPoint = randomCrashPoint();

  events.emit("round", publicRound());

  timer = setInterval(tick, TICK_MS);
}

function tick() {
  if (!currentRound || currentRound.status !== "running") return;

  const multiplier = currentMultiplier();

  events.emit("tick", {
    roundId: currentRound.id,
    multiplier
  });

  if (multiplier >= currentRound.crashPoint) {
    crashRound();
  }
}

function crashRound() {
  if (!currentRound || currentRound.status !== "running") return;

  clearInterval(timer);

  currentRound.status = "crashed";

  // Settle every active bet as lost. A cashout must already have
  // been settled and marked before this point.
  const bets = store.getBetsForRound(currentRound.id);

  for (const bet of bets) {
    if (bet.status === "active") {
      try {
        store.settleBet(bet.id, "lost", 0);
      } catch (error) {
        events.emit("error", error);
      }
    }
  }

  events.emit("crash", {
    roundId: currentRound.id,
    crashPoint: currentRound.crashPoint
  });

  timer = setTimeout(startRound, 3000);
}

function getCurrentRound() {
  return publicRound();
}

function placeBet(userId, stake) {
  if (!currentRound || currentRound.status !== "betting") {
    throw new Error("Betting is closed for this round.");
  }

  if (Date.now() >= currentRound.bettingEndsAt) {
    throw new Error("Betting time has ended.");
  }

  const result = store.placeBet(userId, currentRound.id, stake);

  events.emit("bet", {
    roundId: currentRound.id,
    userId,
    stake
  });

  return {
    ...result,
    roundId: currentRound.id
  };
}

function cashOut(userId) {
  if (!currentRound || currentRound.status !== "running") {
    throw new Error("There is no running round.");
  }

  const multiplier = currentMultiplier();

  if (multiplier >= currentRound.crashPoint) {
    throw new Error("The round has already crashed.");
  }

  const bets = store.getBetsForRound(currentRound.id);
  const bet = bets.find(
    item => item.user_id === userId && item.status === "active"
  );

  if (!bet) {
    throw new Error("No active bet to cash out.");
  }

  const payout = Math.floor(bet.stake * multiplier);

  const result = store.settleBet(bet.id, "won", payout);

  events.emit("cashout", {
    roundId: currentRound.id,
    userId,
    multiplier,
    payout
  });

  return {
    ...result,
    multiplier
  };
}

function subscribe(eventName, listener) {
  events.on(eventName, listener);

  return () => events.off(eventName, listener);
}

function start() {
  if (timer) return;

  startRound();
}

function stop() {
  if (timer) {
    clearTimeout(timer);
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  start,
  stop,
  getCurrentRound,
  placeBet,
  cashOut,
  subscribe
};

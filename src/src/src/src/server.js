
require("dotenv").config();

const path = require("node:path");
const express = require("express");
const http = require("node:http");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const WebSocket = require("ws");

const auth = require("./auth");
const store = require("./store");
const game = require("./game-engine");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "10kb" }));
app.use(cookieParser());

app.use("/api/auth", rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false
}));

app.use("/api", rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false
}));

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return null;
  return header.slice(7);
}

function requireAuth(req, res, next) {
  try {
    req.user = auth.authenticateToken(getBearerToken(req));
    next();
  } catch {
    res.status(401).json({ error: "Please log in again." });
  }
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/auth/register", asyncRoute(async (req, res) => {
  const { email, password } = req.body || {};
  const user = await auth.register(email, password);

  res.status(201).json({
    user,
    message: "Account created."
  });
}));

app.post("/api/auth/login", asyncRoute(async (req, res) => {
  const { email, password } = req.body || {};
  const result = await auth.login(email, password);

  res.json(result);
}));

app.get("/api/me", requireAuth, (req, res) => {
  res.json({
    user: req.user,
    balance: store.getBalance(req.user.id)
  });
});

app.get("/api/game/current", (req, res) => {
  res.json({ round: game.getCurrentRound() });
});

app.get("/api/bets/history", requireAuth, (req, res) => {
  res.json({
    bets: store.getBetsForUser(req.user.id, 20)
  });
});

app.post("/api/game/bet", requireAuth, (req, res, next) => {
  try {
    const stake = Number(req.body && req.body.stake);

    if (!Number.isSafeInteger(stake) || stake <= 0) {
      return res.status(400).json({
        error: "Stake must be a positive whole number."
      });
    }

    const result = game.placeBet(req.user.id, stake);
    return res.status(201).json(result);
  } catch (error) {
    return next(error);
  }
});

app.post("/api/game/cashout", requireAuth, (req, res, next) => {
  try {
    const result = game.cashOut(req.user.id);
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

app.use("/",
  express.static(path.join(process.cwd(), "public"), {
    index: "index.html",
    dotfiles: "deny"
  })
);

wss.on("connection", (socket) => {
  socket.send(JSON.stringify({
    type: "round",
    data: game.getCurrentRound()
  }));
});

server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(
    request.url,
    `http://${request.headers.host || "localhost"}`
  ).pathname;

  if (pathname !== "/ws") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

function broadcast(type, data) {
  const message = JSON.stringify({ type, data });

  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

for (const eventName of ["round", "tick", "crash", "bet", "cashout"]) {
  game.subscribe(eventName, (data) => broadcast(eventName, data));
}

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  const message = err && err.message
    ? err.message
    : "Internal server error.";

  const status = [
    "Enter a valid email address.",
    "Password must be at least 10 characters.",
    "Password must be 72 characters or fewer.",
    "An account with this email already exists.",
    "Email or password is incorrect.",
    "Betting is closed for this round.",
    "Betting time has ended.",
    "Insufficient virtual credits.",
    "There is no running round.",
    "The round has already crashed.",
    "No active bet to cash out.",
    "Invalid stake amount."
  ].includes(message) ? 400 : 500;

  if (status === 500) {
    console.error(err);
    return res.status(500).json({ error: "Something went wrong." });
  }

  return res.status(status).json({ error: message });
});

const port = Number(process.env.PORT) || 3000;

server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
  game.start();
});

function shutdown() {
  game.stop();

  for (const client of wss.clients) {
    client.close();
  }

  server.close(() => {
    store.db.close();
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

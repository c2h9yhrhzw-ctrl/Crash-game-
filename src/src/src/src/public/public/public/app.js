
const $ = (id) => document.getElementById(id);

const authPanel = $("authPanel");
const gamePanel = $("gamePanel");
const authForm = $("authForm");
const emailInput = $("email");
const passwordInput = $("password");
const loginBtn = $("loginBtn");
const registerBtn = $("registerBtn");
const logoutBtn = $("logoutBtn");
const balanceEl = $("balance");
const authMessage = $("authMessage");
const actionMessage = $("actionMessage");
const multiplierEl = $("multiplier");
const roundLabel = $("roundLabel");
const gameMessage = $("gameMessage");
const connectionEl = $("connection");
const betBtn = $("betBtn");
const cashoutBtn = $("cashoutBtn");
const stakeInput = $("stake");
const historyList = $("historyList");

let token = null;
let currentRound = null;
let socket = null;
let socketRetry = null;
let activeBet = false;
let lastMultiplier = 1;
let cashoutPending = false;

function setMessage(element, text, kind = "") {
  element.textContent = text;
  element.className = "message" + (kind ? ` ${kind}` : "");
}

async function api(url, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    ...options,
    headers
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.error || "Request failed.");
  }

  return result;
}

function showLoggedIn(user, balance) {
  authPanel.classList.add("hidden");
  gamePanel.classList.remove("hidden");
  logoutBtn.classList.remove("hidden");
  balanceEl.textContent = `Credits: ${balance}`;
  setMessage(authMessage, "");
  loadHistory();
  connectSocket();
}

function showLoggedOut() {
  token = null;
  activeBet = false;
  cashoutPending = false;

  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
  }

  clearTimeout(socketRetry);

  authPanel.classList.remove("hidden");
  gamePanel.classList.add("hidden");
  logoutBtn.classList.add("hidden");
  balanceEl.textContent = "Credits: —";
  cashoutBtn.disabled = true;
  betBtn.disabled = false;
  historyList.replaceChildren();

  setMessage(actionMessage, "");
}

function updateBalance(balance) {
  balanceEl.textContent = `Credits: ${balance}`;
}

function updateRound(round) {
  if (!round) return;

  const previousId = currentRound && currentRound.id;
  currentRound = round;

  roundLabel.textContent = `Round: ${round.id}`;

  if (round.status === "betting") {
    multiplierEl.textContent = "1.00×";
    multiplierEl.className = "multiplier";
    gameMessage.textContent = "Place your bet before betting closes.";
    betBtn.disabled = false;
    cashoutBtn.disabled = true;

    if (previousId !== round.id) {
      activeBet = false;
      cashoutPending = false;
      setMessage(actionMessage, "");
    }
  } else if (round.status === "running") {
    const multiplier = Number(round.multiplier || 1);
    lastMultiplier = multiplier;

    multiplierEl.textContent = `${multiplier.toFixed(2)}×`;
    multiplierEl.className = "multiplier running";
    gameMessage.textContent = activeBet
      ? "Round is running — cash out before the crash."
      : "Round is running.";

    betBtn.disabled = true;
    cashoutBtn.disabled = !activeBet || cashoutPending;
  } else if (round.status === "crashed") {
    multiplierEl.textContent =
      `${Number(round.crashPoint || lastMultiplier).toFixed(2)}×`;
    multiplierEl.className = "multiplier crashed";
    gameMessage.textContent = "CRASH! Waiting for the next round.";
    betBtn.disabled = true;
    cashoutBtn.disabled = true;
    activeBet = false;
    cashoutPending = false;
  }
}

function connectSocket() {
  if (!token || socket) return;

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/ws`);

  socket.addEventListener("open", () => {
    connectionEl.textContent = "Live";
    clearTimeout(socketRetry);
  });

  socket.addEventListener("message", (event) => {
    let message;

    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.type === "round") {
      updateRound(message.data);
    }

    if (message.type === "tick" && currentRound &&
        message.data.roundId === currentRound.id) {
      lastMultiplier = Number(message.data.multiplier || 1);
      multiplierEl.textContent = `${lastMultiplier.toFixed(2)}×`;
      multiplierEl.className = "multiplier running";
    }

    if (message.type === "crash" && currentRound &&
        message.data.roundId === currentRound.id) {
      currentRound.status = "crashed";
      currentRound.crashPoint = message.data.crashPoint;
      updateRound(currentRound);
      refreshAccount();
      loadHistory();
    }

    if (message.type === "cashout") {
      refreshAccount();
      loadHistory();
    }
  });

  socket.addEventListener("close", () => {
    socket = null;
    connectionEl.textContent = "Reconnecting…";

    if (token) {
      socketRetry = setTimeout(connectSocket, 2000);
    }
  });

  socket.addEventListener("error", () => {
    connectionEl.textContent = "Connection issue";
  });
}

async function refreshAccount() {
  if (!token) return;

  try {
    const result = await api("/api/me");
    updateBalance(result.balance);
  } catch {
    // A later authenticated request can report session expiry.
  }
}

async function loadHistory() {
  if (!token) return;

  try {
    const result = await api("/api/bets/history");
    historyList.replaceChildren();

    if (!result.bets.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "No bets yet.";
      historyList.appendChild(empty);
      return;
    }

    for (const bet of result.bets) {
      const row = document.createElement("div");
      row.className = "history-item";

      const left = document.createElement("div");
      const round = document.createElement("strong");
      round.textContent = bet.round_id;
      const details = document.createElement("div");
      details.className = "muted";
      details.textContent = `Stake: ${bet.stake} credits`;
      left.append(round, details);

      const right = document.createElement("div");
      right.className = "result " +
        (bet.status === "won" ? "won" :
          bet.status === "lost" ? "lost" : "");

      right.textContent =
        `${bet.status} · ${bet.payout} credits`;

      row.append(left, right);
      historyList.appendChild(row);
    }
  } catch {
    setMessage(actionMessage, "Could not load bet history.", "error");
  }
}

async function authenticate(mode) {
  const email = emailInput.value.trim();
  const password = passwordInput.value;

  setMessage(authMessage, "Please wait…");
  loginBtn.disabled = true;
  registerBtn.disabled = true;

  try {
    const endpoint = mode === "register"
      ? "/api/auth/register"
      : "/api/auth/login";

    const result = await api(endpoint, {
      method: "POST",
      body: JSON.stringify({ email, password })
    });

    if (mode === "register") {
      setMessage(
        authMessage,
        "Account created. Now log in with your details.",
        "success"
      );
      passwordInput.value = "";
      return;
    }

    token = result.token;
    localStorage.setItem("crashArenaToken", token);
    showLoggedIn(result.user, result.user.balance);
    await syncRound();
  } catch (error) {
    setMessage(authMessage, error.message, "error");
  } finally {
    loginBtn.disabled = false;
    registerBtn.disabled = false;
  }
}

async function syncRound() {
  try {
    const result = await api("/api/game/current");
    updateRound(result.round);
  } catch {
    setMessage(actionMessage, "Could not load the current round.", "error");
  }
}

authForm.addEventListener("submit", (event) => {
  event.preventDefault();
  authenticate("login");
});

registerBtn.addEventListener("click", () => {
  authenticate("register");
});

logoutBtn.addEventListener("click", () => {
  localStorage.removeItem("crashArenaToken");
  showLoggedOut();
});

betBtn.addEventListener("click", async () => {
  if (!token) return;

  const stake = Number(stakeInput.value);

  if (!Number.isSafeInteger(stake) || stake <= 0) {
    setMessage(actionMessage, "Enter a positive whole number.", "error");
    return;
  }

  betBtn.disabled = true;

  try {
    const result = await api("/api/game/bet", {
      method: "POST",
      body: JSON.stringify({ stake })
    });

    activeBet = true;
    updateBalance(result.balance);
    setMessage(actionMessage, "Bet placed.", "success");
    await syncRound();
  } catch (error) {
    setMessage(actionMessage, error.message, "error");
    await syncRound();
  } finally {
    betBtn.disabled = !(currentRound &&
      currentRound.status === "betting");
  }
});

cashoutBtn.addEventListener("click", async () => {
  if (!token || !activeBet || cashoutPending) return;

  cashoutPending = true;
  cashoutBtn.disabled = true;

  try {
    const result = await api("/api/game/cashout", {
      method: "POST",
      body: JSON.stringify({})
    });

    activeBet = false;
    updateBalance(result.balance);

    setMessage(
      actionMessage,
      `Cashed out at ${result.multiplier.toFixed(2)}×. Payout: ${result.payout} credits.`,
      "success"
    );

    await loadHistory();
  } catch (error) {
    setMessage(actionMessage, error.message, "error");
  } finally {
    cashoutPending = false;
    await syncRound();
  }
});

async function restoreSession() {
  const savedToken = localStorage.getItem("crashArenaToken");

  if (!savedToken) return;

  token = savedToken;

  try {
    const result = await api("/api/me");
    showLoggedIn(result.user, result.balance);
    await syncRound();
  } catch {
    localStorage.removeItem("crashArenaToken");
    showLoggedOut();
  }
}

restoreSession();

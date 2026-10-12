
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const store = require("./store");

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error(
    "JWT_SECRET must be set to a random secret of at least 32 characters."
  );
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function register(email, password) {
  email = String(email || "").trim().toLowerCase();

  if (!EMAIL_REGEX.test(email) || email.length > 254) {
    throw new Error("Enter a valid email address.");
  }

  if (typeof password !== "string" || password.length < 10) {
    throw new Error("Password must be at least 10 characters.");
  }

  if (password.length > 72) {
    throw new Error("Password must be 72 characters or fewer.");
  }

  const existing = store.findUserByEmail(email);

  if (existing) {
    throw new Error("An account with this email already exists.");
  }

  const passwordHash = await bcrypt.hash(password, 12);

  let userId;

  try {
    userId = store.createUser(email, passwordHash);
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
      throw new Error("An account with this email already exists.");
    }

    throw error;
  }

  return {
    id: userId,
    email,
    balance: store.getBalance(userId)
  };
}

async function login(email, password) {
  email = String(email || "").trim().toLowerCase();

  if (typeof password !== "string" || !password) {
    throw new Error("Email or password is incorrect.");
  }

  const user = store.findUserByEmail(email);

  if (!user) {
    throw new Error("Email or password is incorrect.");
  }

  const validPassword = await bcrypt.compare(
    password,
    user.password_hash
  );

  if (!validPassword) {
    throw new Error("Email or password is incorrect.");
  }

  const token = jwt.sign(
    { sub: String(user.id) },
    JWT_SECRET,
    { expiresIn: "12h", issuer: "crash-game-platform" }
  );

  return {
    token,
    user: {
      id: user.id,
      email: user.email,
      balance: store.getBalance(user.id)
    }
  };
}

function authenticateToken(token) {
  if (!token || typeof token !== "string") {
    throw new Error("Authentication required.");
  }

  const payload = jwt.verify(token, JWT_SECRET, {
    issuer: "crash-game-platform"
  });

  const userId = Number(payload.sub);

  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error("Invalid authentication token.");
  }

  const user = store.getUserById(userId);

  if (!user) {
    throw new Error("Account no longer exists.");
  }

  return user;
}

module.exports = {
  register,
  login,
  authenticateToken
};

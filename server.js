require("dotenv").config();

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const session = require("express-session");
const SQLiteStoreFactory = require("connect-sqlite3");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const Database = require("better-sqlite3");

const app = express();
const SQLiteStore = SQLiteStoreFactory(session);
const isProduction = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT || 3000);
const GROUP_ID = process.env.ROBLOX_GROUP_ID || "241982252";
const BASE_URL = (process.env.BASE_URL || "").replace(/\/$/, "");
const REDIRECT_URI = process.env.ROBLOX_REDIRECT_URI || (BASE_URL + "/auth/roblox/callback");
const CLIENT_ID = process.env.ROBLOX_CLIENT_ID;
const CLIENT_SECRET = process.env.ROBLOX_CLIENT_SECRET;
const SESSION_SECRET = process.env.SESSION_SECRET;
const MIN_PROMOTER_RANK = Number(process.env.MIN_PROMOTER_RANK || 256);

if (!SESSION_SECRET || SESSION_SECRET.length < 32) throw new Error("Configure SESSION_SECRET com pelo menos 32 caracteres.");
if (isProduction && (!BASE_URL.startsWith("https://") || !REDIRECT_URI.startsWith("https://"))) {
  throw new Error("Em produção, BASE_URL e ROBLOX_REDIRECT_URI precisam usar HTTPS.");
}

let roleRanks = {};
try { roleRanks = JSON.parse(process.env.ROLE_RANKS_JSON || "{}"); }
catch { throw new Error("ROLE_RANKS_JSON precisa conter um JSON válido."); }

app.disable("x-powered-by");
if (isProduction) app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "30kb" }));
app.use(express.static("public"));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

fs.mkdirSync("./data", { recursive: true });
app.use(session({
  store: new SQLiteStore({ db: "sessions.sqlite", dir: "./data", table: "sessions" }),
  name: "ebm.sid",
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: isProduction, sameSite: "lax", maxAge: 8 * 60 * 60 * 1000 }
}));

app.use("/auth", rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: "draft-7", legacyHeaders: false }));
app.use("/api", rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: "draft-7", legacyHeaders: false }));

const db = new Database("./data/eb-manager.sqlite");
db.pragma("journal_mode = WAL");
db.exec("CREATE TABLE IF NOT EXISTS promotions (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, target_user_id TEXT NOT NULL, target_username TEXT NOT NULL, from_role TEXT NOT NULL, to_role TEXT NOT NULL, author_user_id TEXT NOT NULL, author_username TEXT NOT NULL, author_role TEXT NOT NULL, reason TEXT NOT NULL)");
const insertPromotion = db.prepare("INSERT INTO promotions (created_at, target_user_id, target_username, from_role, to_role, author_user_id, author_username, author_role, reason) VALUES (@created_at, @target_user_id, @target_username, @from_role, @to_role, @author_user_id, @author_username, @author_role, @reason)");

function requireCsrf(req, res, next) {
  const supplied = req.get("x-csrf-token") || "";
  const expected = req.session.csrfToken || "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (!a.length || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ error: "Solicitação inválida. Atualize a página e tente novamente." });
  }
  next();
}

function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Faça login com Roblox para continuar." });
  next();
}
function roleRank(label) {
  const value = roleRanks[label];
  return Number.isInteger(value) ? value : null;
}
function randomUrlSafe(bytes = 32) { return crypto.randomBytes(bytes).toString("base64url"); }
function pkceChallenge(verifier) { return crypto.createHash("sha256").update(verifier).digest("base64url"); }

async function robloxJson(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { Accept: "application/json", ...(options.headers || {}) } });
  if (!response.ok) {
    const body = await response.text();
    const error = new Error("Roblox API respondeu " + response.status + ": " + body.slice(0, 300));
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function getGroupRole(userId) {
  const data = await robloxJson("https://groups.roblox.com/v2/users/" + encodeURIComponent(userId) + "/groups/roles");
  const membership = (data.data || []).find(item => String(item.group?.id) === String(GROUP_ID));
  if (!membership) return null;
  return { id: String(membership.role?.id || ""), name: String(membership.role?.name || ""), rank: Number(membership.role?.rank || 0) };
}

async function getRobloxUserId(username) {
  const data = await robloxJson("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: true })
  });
  const user = data.data?.[0];
  return user?.id ? { id: String(user.id), name: String(user.name) } : null;
}

app.get("/auth/roblox", (req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET || !BASE_URL) return res.status(503).send("O login Roblox ainda não foi configurado pelo responsável técnico.");
  const state = randomUrlSafe();
  const verifier = randomUrlSafe(48);
  req.session.oauthState = state;
  req.session.codeVerifier = verifier;

  const authorize = new URL("https://apis.roblox.com/oauth/v1/authorize");
  authorize.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "openid profile",
    response_type: "code",
    state,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256"
  }).toString();
  res.redirect(authorize.toString());
});

app.get("/auth/roblox/callback", async (req, res) => {
  const code = req.query.code;
  const state = req.query.state;
  if (req.query.error) return res.status(400).send("O login Roblox foi cancelado ou recusado.");
  if (!code || !state || !req.session.oauthState || state !== req.session.oauthState || !req.session.codeVerifier) {
    return res.status(400).send("Não foi possível validar a solicitação de login. Tente novamente.");
  }

  const codeVerifier = req.session.codeVerifier;
  delete req.session.oauthState;
  delete req.session.codeVerifier;

  try {
    const tokenResponse = await fetch("https://apis.roblox.com/oauth/v1/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: String(code),
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        code_verifier: codeVerifier
      })
    });
    if (!tokenResponse.ok) throw new Error("A troca do código de autorização falhou.");
    const tokens = await tokenResponse.json();
    if (!tokens.access_token) throw new Error("O Roblox não retornou um token de acesso.");

    const profile = await robloxJson("https://apis.roblox.com/oauth/v1/userinfo", {
      headers: { Authorization: "Bearer " + tokens.access_token }
    });
    if (!profile.sub) throw new Error("Não foi possível confirmar a conta Roblox.");

    const groupRole = await getGroupRole(profile.sub);
    if (!groupRole) return res.status(403).send("Sua conta Roblox não pertence ao grupo configurado para este painel.");

    req.session.regenerate(err => {
      if (err) return res.status(500).send("Não foi possível criar uma sessão segura.");
      req.session.user = {
        robloxId: String(profile.sub),
        username: String(profile.preferred_username || profile.nickname || profile.name || ""),
        displayName: String(profile.name || profile.nickname || ""),
        avatar: typeof profile.picture === "string" ? profile.picture : null,
        groupId: GROUP_ID,
        groupRoleId: groupRole.id,
        groupRoleName: groupRole.name,
        groupRoleRank: groupRole.rank
      };
      req.session.save(saveError => {
        if (saveError) return res.status(500).send("Não foi possível salvar a sessão.");
        res.redirect("/");
      });
    });
  } catch (err) {
    console.error("Falha no callback Roblox:", err.message);
    res.status(502).send("Não foi possível concluir o login Roblox. Tente novamente mais tarde.");
  }
});

app.get("/api/me", requireLogin, (req, res) => {
  if (!req.session.csrfToken) req.session.csrfToken = randomUrlSafe();
  res.json({ user: req.session.user, csrfToken: req.session.csrfToken });
});
app.post("/auth/logout", requireLogin, requireCsrf, (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: "Não foi possível encerrar a sessão." });
    res.clearCookie("ebm.sid", { httpOnly: true, sameSite: "lax", secure: isProduction });
    res.json({ ok: true });
  });
});

app.get("/api/promotions", requireLogin, (req, res) => {
  res.json({ promotions: db.prepare("SELECT * FROM promotions ORDER BY id DESC LIMIT 300").all() });
});

app.post("/api/promotions", requireLogin, requireCsrf, async (req, res) => {
  const body = req.body || {};
  const targetUsername = body.targetUsername;
  const fromRole = body.fromRole;
  const toRole = body.toRole;
  const reason = body.reason;
  if (![targetUsername, fromRole, toRole, reason].every(value => typeof value === "string" && value.trim())) {
    return res.status(400).json({ error: "Preencha militar, patente atual, nova patente e motivo." });
  }
  if (targetUsername.length > 40 || reason.length > 1000) return res.status(400).json({ error: "Algum campo ultrapassou o limite permitido." });

  const author = req.session.user;
  if (author.groupRoleRank < MIN_PROMOTER_RANK) return res.status(403).json({ error: "Permissão negada: sua função no grupo não permite promover." });

  const fromRank = roleRank(fromRole);
  const toRank = roleRank(toRole);
  if (fromRank === null || toRank === null) return res.status(503).json({ error: "As patentes ainda não foram mapeadas pelo responsável técnico." });
  if (toRank <= fromRank) return res.status(400).json({ error: "A nova patente precisa ser superior à patente atual." });
  if (toRank >= author.groupRoleRank) return res.status(403).json({ error: "Você não pode promover alguém para uma patente igual ou superior à sua." });

  try {
    const target = await getRobloxUserId(targetUsername.trim());
    if (!target) return res.status(404).json({ error: "Não encontrei esse usuário Roblox." });
    const targetRole = await getGroupRole(target.id);
    if (!targetRole) return res.status(400).json({ error: "O militar informado não pertence ao grupo." });
    if (targetRole.rank !== fromRank) return res.status(409).json({ error: "A patente atual informada não corresponde à função real do militar no grupo." });

    insertPromotion.run({
      created_at: new Date().toISOString(),
      target_user_id: target.id,
      target_username: target.name,
      from_role: fromRole.trim(),
      to_role: toRole.trim(),
      author_user_id: author.robloxId,
      author_username: author.username,
      author_role: author.groupRoleName,
      reason: reason.trim()
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error("Falha ao registrar promoção:", err.message);
    res.status(502).json({ error: "Não foi possível verificar os dados do grupo Roblox agora." });
  }
});

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "EB Manager API" }));
app.listen(PORT, () => console.log("EB Manager API disponível na porta " + PORT));

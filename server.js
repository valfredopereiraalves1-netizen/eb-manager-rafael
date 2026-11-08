require("dotenv").config();

const crypto = require("node:crypto");
const path = require("node:path");
const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const app = express();
const isProduction = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT || 3000);
const GROUP_ID = process.env.ROBLOX_GROUP_ID || "241982252";
const BASE_URL = (process.env.BASE_URL || "").replace(/\/$/, "");
const REDIRECT_URI = process.env.ROBLOX_REDIRECT_URI || (BASE_URL + "/auth/roblox/callback");
const CLIENT_ID = process.env.ROBLOX_CLIENT_ID;
const CLIENT_SECRET = process.env.ROBLOX_CLIENT_SECRET;
const SESSION_SECRET = process.env.SESSION_SECRET;
const MIN_PROMOTER_RANK = Number(process.env.MIN_PROMOTER_RANK || 256);
const MIN_RECORD_RANK = Number(process.env.MIN_RECORD_RANK || MIN_PROMOTER_RANK);

if (!process.env.DATABASE_URL) throw new Error("Configure DATABASE_URL com a URL do PostgreSQL no Render.");
if (!SESSION_SECRET || SESSION_SECRET.length < 32) throw new Error("Configure SESSION_SECRET com pelo menos 32 caracteres.");
if (isProduction && (!BASE_URL.startsWith("https://") || !REDIRECT_URI.startsWith("https://"))) {
  throw new Error("Em produção, BASE_URL e ROBLOX_REDIRECT_URI precisam usar HTTPS.");
}

let roleRanks = {};
try { roleRanks = JSON.parse(process.env.ROLE_RANKS_JSON || "{}"); }
catch { throw new Error("ROLE_RANKS_JSON precisa conter um JSON válido."); }

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

app.disable("x-powered-by");
if (isProduction) app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "30kb" }));
app.use(express.static("public"));

app.use(session({
  store: new PgSession({
    pool,
    tableName: "user_sessions",
    createTableIfMissing: true
  }),
  name: "ebm.sid",
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge: 8 * 60 * 60 * 1000
  }
}));

app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.use("/auth", rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: "draft-7", legacyHeaders: false }));
app.use("/api", rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: "draft-7", legacyHeaders: false }));

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS promotions (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL,
      target_user_id TEXT NOT NULL,
      target_username TEXT NOT NULL,
      from_role TEXT NOT NULL,
      to_role TEXT NOT NULL,
      author_user_id TEXT NOT NULL,
      author_username TEXT NOT NULL,
      author_role TEXT NOT NULL,
      reason TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS panel_records (
      id BIGSERIAL PRIMARY KEY,
      record_type TEXT NOT NULL CHECK (record_type IN ('training', 'cpd', 'denied')),
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS panel_records_type_created_idx
      ON panel_records(record_type, created_at DESC);
    CREATE TABLE IF NOT EXISTS admin_requests (
      id BIGSERIAL PRIMARY KEY,
      action TEXT NOT NULL CHECK (action IN ('set_role', 'demote', 'revoke')),
      target_user_id TEXT NOT NULL,
      target_username TEXT NOT NULL,
      requested_role TEXT,
      reason TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_by_role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS whitelist_entries (
      id BIGSERIAL PRIMARY KEY,
      roblox_user_id TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

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

const openCloudKey = process.env.ROBLOX_OPEN_CLOUD_API_KEY || "";
async function openCloudJson(url, options = {}) {
  if (!openCloudKey) {
    const error = new Error("Integração Open Cloud não configurada no Render (ROBLOX_OPEN_CLOUD_API_KEY).");
    error.status = 503;
    throw error;
  }
  return robloxJson(url, {
    ...options,
    headers: { "x-api-key": openCloudKey, ...(options.headers || {}) }
  });
}
async function getCloudMembership(userId) {
  let pageToken = "";
  for (let page = 0; page < 30; page++) {
    const url = new URL("https://apis.roblox.com/cloud/v2/groups/" + encodeURIComponent(GROUP_ID) + "/memberships");
    url.searchParams.set("maxPageSize", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const data = await openCloudJson(url.toString());
    const match = (data.groupMemberships || data.memberships || []).find(item => {
      const id = String(item.user?.userId || item.user?.id || item.userId || "");
      return id === String(userId);
    });
    if (match) return match;
    pageToken = data.nextPageToken || "";
    if (!pageToken) break;
  }
  return null;
}
async function assignCloudRole(userId, roleId) {
  const membership = await getCloudMembership(userId);
  if (!membership?.path) throw new Error("Não foi possível localizar a associação do usuário pela Open Cloud.");
  return openCloudJson(
    "https://apis.roblox.com/cloud/v2/groups/" + encodeURIComponent(GROUP_ID) + "/memberships/" +
      encodeURIComponent(membership.path.split("/").pop()) + ":assignRole",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: "groups/" + GROUP_ID + "/roles/" + roleId }) }
  );
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

app.get("/api/promotions", requireLogin, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM promotions ORDER BY id DESC LIMIT 300");
    res.json({ promotions: result.rows });
  } catch (err) {
    console.error("Falha ao consultar promoções:", err.message);
    res.status(500).json({ error: "Não foi possível consultar o banco de dados." });
  }
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
  if (fromRank === null || toRank === null) return res.status(503).json({ error: "O mapeamento das patentes reais do Roblox ainda não foi configurado." });
  if (toRank <= fromRank) return res.status(400).json({ error: "A nova patente precisa ser superior à patente atual." });
  if (toRank >= author.groupRoleRank) return res.status(403).json({ error: "Você não pode promover alguém para uma patente igual ou superior à sua." });
  try {
    const target = await getRobloxUserId(targetUsername.trim());
    if (!target) return res.status(404).json({ error: "Não encontrei esse usuário Roblox." });
    const targetRole = await getGroupRole(target.id);
    if (!targetRole) return res.status(400).json({ error: "O militar informado não pertence ao grupo." });
    if (targetRole.rank !== fromRank) return res.status(409).json({ error: "A patente atual informada não corresponde à função real do militar no grupo." });
    if (!process.env.ROBLOX_OPEN_CLOUD_API_KEY) return res.status(503).json({ error: "A integração Open Cloud ainda não foi configurada no Render." });
    const roleIds = JSON.parse(process.env.ROLE_IDS_JSON || "{}");
    const targetRoleId = roleIds[toRole.trim()];
    if (!targetRoleId) return res.status(503).json({ error: "Falta mapear o ID real da patente de destino em ROLE_IDS_JSON." });
    await assignCloudRole(target.id, String(targetRoleId));
    await pool.query(
      `INSERT INTO promotions (created_at, target_user_id, target_username, from_role, to_role, author_user_id, author_username, author_role, reason)
       VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8)`,
      [target.id, target.name, fromRole.trim(), toRole.trim(), author.robloxId, author.username, author.groupRoleName, reason.trim()]
    );
    res.status(201).json({ ok: true, applied: true });
  } catch (err) {
    console.error("Falha ao registrar promoção:", err.message);
    res.status(502).json({ error: "Não foi possível verificar os dados do grupo Roblox agora." });
  }
});

const recordTypes = new Set(["training", "cpd", "denied"]);
app.get("/api/records/:type", requireLogin, async (req, res) => {
  const type = req.params.type;
  if (!recordTypes.has(type)) return res.status(404).json({ error: "Tipo de registro inválido." });
  try {
    const result = await pool.query(
      "SELECT id, data, created_at FROM panel_records WHERE record_type = $1 ORDER BY created_at DESC LIMIT 500",
      [type]
    );
    res.json({ records: result.rows });
  } catch (err) {
    console.error("Falha ao consultar registros:", err.message);
    res.status(500).json({ error: "Não foi possível consultar o banco de dados." });
  }
});
app.post("/api/records/:type", requireLogin, requireCsrf, async (req, res) => {
  const type = req.params.type;
  if (!recordTypes.has(type)) return res.status(404).json({ error: "Tipo de registro inválido." });
  if (req.session.user.groupRoleRank < MIN_RECORD_RANK) return res.status(403).json({ error: "Permissão negada: seu cargo no grupo não pode criar registros administrativos." });
  const data = req.body || {};
  const required = type === "training" ? ["person", "training", "score", "instructor"]
    : type === "cpd" ? ["person", "type", "description"] : ["person", "rank", "reason"];
  if (!required.every(key => data[key] !== undefined && String(data[key]).trim() !== "")) {
    return res.status(400).json({ error: "Preencha todos os campos obrigatórios." });
  }
  if (JSON.stringify(data).length > 5000) return res.status(400).json({ error: "Registro muito grande." });
  if (type === "training") {
    const score = Number(data.score);
    if (!Number.isFinite(score) || score < 0 || score > 100) return res.status(400).json({ error: "A pontuação deve ficar entre 0 e 100." });
    data.score = score;
  }
  try {
    const result = await pool.query(
      "INSERT INTO panel_records (record_type, data, created_by) VALUES ($1, $2::jsonb, $3) RETURNING id, data, created_at",
      [type, JSON.stringify(data), req.session.user.robloxId]
    );
    res.status(201).json({ record: result.rows[0] });
  } catch (err) {
    console.error("Falha ao salvar registro:", err.message);
    res.status(500).json({ error: "Não foi possível salvar no banco de dados." });
  }
});

function requireSpecialAccess(...allowed) {
  return (req, res, next) => {
    const access = req.session.specialAccess;
    if (!access || !allowed.includes(access)) {
      return res.status(403).json({ error: "Este painel exige um código de acesso autorizado." });
    }
    next();
  };
}
function safeSecretMatch(supplied, expected) {
  if (!expected || typeof supplied !== "string") return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}
app.get("/api/access", requireLogin, (req, res) => {
  res.json({ access: req.session.specialAccess || null });
});
app.post("/api/access/verify", requireLogin, requireCsrf, (req, res) => {
  const code = String(req.body?.code || "");
  if (code.length > 32) return res.status(400).json({ error: "Código inválido." });
  const choices = [
    { access: "admin", code: process.env.ADMIN_ACCESS_CODE, label: "Painel ADM", description: "Pode registrar solicitações para definir patentes." },
    { access: "cgex", code: process.env.CGEX_ACCESS_CODE, label: "Painel CGEx", description: "Pode registrar solicitações de rebaixamento e revogação de patentes do EB." },
    { access: "creator", code: process.env.CREATOR_ACCESS_CODE, label: "Painel do Criador", description: "Acesso total aos painéis especiais, incluindo gerenciamento da WL." }
  ];
  const match = choices.find(item => safeSecretMatch(code, item.code));
  if (!match) return res.status(401).json({ error: "Código incorreto ou ainda não configurado no servidor." });
  req.session.specialAccess = match.access;
  res.json({ access: match.access, label: match.label, description: match.description });
});
app.get("/api/admin/requests", requireLogin, requireSpecialAccess("admin", "cgex", "creator"), async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, action, target_username, requested_role, status, created_at FROM admin_requests ORDER BY id DESC LIMIT 200"
    );
    res.json({ requests: result.rows });
  } catch (err) {
    console.error("Falha ao consultar solicitações:", err.message);
    res.status(500).json({ error: "Não foi possível consultar as solicitações." });
  }
});
app.post("/api/admin/requests", requireLogin, requireCsrf, async (req, res) => {
  const access = req.session.specialAccess;
  const body = req.body || {};
  const action = String(body.action || "");
  const allowed = (action === "set_role" && ["admin", "creator"].includes(access)) ||
    (["demote", "revoke"].includes(action) && ["cgex", "creator"].includes(access));
  if (!allowed) return res.status(403).json({ error: "Seu código não permite esta operação." });
  const username = String(body.username || "").trim();
  const reason = String(body.reason || "").trim();
  const requestedRole = action === "set_role" ? String(body.role || "").trim() : null;
  if (!username || username.length > 40 || !reason || reason.length > 1000) {
    return res.status(400).json({ error: "Informe usuário e motivo válidos." });
  }
  if (action === "set_role" && (!requestedRole || roleRank(requestedRole) === null)) {
    return res.status(503).json({ error: "Configure o mapeamento de patentes reais em ROLE_RANKS_JSON antes de usar esta função." });
  }
  try {
    const target = await getRobloxUserId(username);
    if (!target) return res.status(404).json({ error: "Usuário Roblox não encontrado." });
    const currentRole = await getGroupRole(target.id);
    if (!currentRole) return res.status(400).json({ error: "O usuário não pertence ao grupo EB configurado." });
    if (!process.env.ROBLOX_OPEN_CLOUD_API_KEY) return res.status(503).json({ error: "Configure ROBLOX_OPEN_CLOUD_API_KEY no Render antes de aplicar alterações." });
    const roleIds = JSON.parse(process.env.ROLE_IDS_JSON || "{}");
    let destinationRoleId = null;
    if (action === "set_role") {
      destinationRoleId = roleIds[requestedRole];
      if (!destinationRoleId) return res.status(503).json({ error: "Falta mapear o ID real da patente em ROLE_IDS_JSON." });
    } else {
      const currentRank = Number(currentRole.rank);
      const configured = Object.entries(roleRanks).filter(([, rank]) => Number.isInteger(rank)).sort((a,b) => b[1]-a[1]);
      const lower = configured.find(([, rank]) => rank < currentRank);
      const recruit = configured[configured.length - 1];
      const destinationLabel = action === "revoke" ? recruit?.[0] : lower?.[0];
      if (!destinationLabel) return res.status(400).json({ error: "Não foi possível determinar a patente de destino. Revise ROLE_RANKS_JSON." });
      destinationRoleId = roleIds[destinationLabel];
      if (!destinationRoleId) return res.status(503).json({ error: "Falta mapear a patente de destino em ROLE_IDS_JSON." });
    }
    if (String(target.id) === String(req.session.user.robloxId)) return res.status(403).json({ error: "Você não pode alterar a própria patente por este painel." });
    if (currentRole.rank >= req.session.user.groupRoleRank && access !== "creator") return res.status(403).json({ error: "Você não pode alterar a patente de alguém de nível igual ou superior ao seu." });
    await assignCloudRole(target.id, String(destinationRoleId));
    await pool.query(
      `INSERT INTO admin_requests (action, target_user_id, target_username, requested_role, reason, created_by, created_by_role, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'applied')`,
      [action, target.id, target.name, requestedRole || (action === "revoke" ? "Revogado para patente inicial" : "Rebaixado uma patente"), reason, req.session.user.robloxId, access]
    );
    res.status(201).json({ ok: true, status: "applied" });
  } catch (err) {
    console.error("Falha ao registrar solicitação administrativa:", err.message);
    res.status(502).json({ error: "Não foi possível verificar o usuário Roblox ou registrar a solicitação." });
  }
});
app.get("/api/whitelist", requireLogin, requireSpecialAccess("creator"), async (_req, res) => {
  try {
    const result = await pool.query("SELECT id, roblox_user_id, username, note, created_at FROM whitelist_entries ORDER BY id DESC LIMIT 500");
    res.json({ entries: result.rows });
  } catch (err) {
    console.error("Falha ao consultar WL:", err.message);
    res.status(500).json({ error: "Não foi possível consultar a WL." });
  }
});
app.delete("/api/whitelist/:id", requireLogin, requireCsrf, requireSpecialAccess("creator"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: "Identificador inválido." });
  try {
    const result = await pool.query("DELETE FROM whitelist_entries WHERE id = $1 RETURNING id", [id]);
    if (!result.rowCount) return res.status(404).json({ error: "Registro da WL não encontrado." });
    res.json({ ok: true });
  } catch (err) {
    console.error("Falha ao remover da WL:", err.message);
    res.status(500).json({ error: "Não foi possível remover o usuário da WL." });
  }
});
app.post("/api/whitelist", requireLogin, requireCsrf, requireSpecialAccess("creator"), async (req, res) => {
  const username = String(req.body?.username || "").trim();
  const note = String(req.body?.note || "").trim();
  if (!username || username.length > 40 || note.length > 300) return res.status(400).json({ error: "Informe um usuário válido e uma observação de até 300 caracteres." });
  try {
    const target = await getRobloxUserId(username);
    if (!target) return res.status(404).json({ error: "Usuário Roblox não encontrado." });
    const result = await pool.query(
      "INSERT INTO whitelist_entries (roblox_user_id, username, note, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT (roblox_user_id) DO UPDATE SET username = EXCLUDED.username, note = EXCLUDED.note RETURNING id, roblox_user_id, username, note, created_at",
      [target.id, target.name, note, req.session.user.robloxId]
    );
    res.status(201).json({ entry: result.rows[0] });
  } catch (err) {
    console.error("Falha ao salvar WL:", err.message);
    res.status(500).json({ error: "Não foi possível salvar na WL." });
  }
});

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, service: "EB Manager API", database: "connected" });
  } catch {
    res.status(503).json({ ok: false, database: "unavailable" });
  }
});

initializeDatabase().then(() => {
  app.listen(PORT, () => console.log("EB Manager API disponível na porta " + PORT));
}).catch(err => {
  console.error("Falha ao iniciar o banco de dados:", err);
  process.exit(1);
});

process.on("SIGTERM", async () => {
  await pool.end();
  process.exit(0);
});

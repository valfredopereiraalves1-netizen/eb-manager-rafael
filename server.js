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

const CDP_DEFAULT_RULES = {
  "[CR] Criador": 0,
  "[SLD] Soldado": 0,
  "[CB] Cabo": 2,
  "[3• SGT] Terceiro Sargento": 5.67,
  "[2• SGT] Segundo Sargento": 6.85,
  "[1• SGT] Primeiro Sargento": 8.5,
  "[ST] Subtenente": 11,
  "[CT] Cadete": 15,
  "[ASP] Aspirante a Oficial": 20,
  "[2• TEN] Segundo Tenente": 26,
  "[1• TEN] Primeiro Tenente": 35,
  "[EM] Elite Militar": 125,
  "[ES] Elite Secreta": 140,
  "[MR] Marechal": 100,
  "[PRES] Presidente": 94,
  "[V-PRES] Vice Presidente": 90,
  "[CMT] Comandante": 84,
  "[S-CMT] Sub Comandante": 82,
  "[GEN-EX] General do Exército": 80,
  "[GEN-DIV] General de Divisão": 74,
  "[GEN-BDA] General de Brigada": 70,
  "[CEL] Coronel": 60,
  "[TEN-CEL] Tenente-Coronel": 52,
  "[MAJ] Major": 45,
  "[CAP] Capitão": 40,
  "[ADM-G] Administrador Geral": { hours: 0, creatorOnly: true },
  "[MOD] Moderador": { hours: 0, creatorOnly: true },
  "[S-CR] Sub Criador": { hours: 0, creatorOnly: true },
  "[ER] Elite Real": { hours: 0, creatorOnly: true }
};
let cdpRules = { ...CDP_DEFAULT_RULES };
try {
  const overrides = JSON.parse(process.env.CDP_RULES_JSON || "{}");
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) throw new Error("invalid");
  cdpRules = { ...cdpRules, ...overrides };
} catch {
  throw new Error("CDP_RULES_JSON precisa conter um objeto JSON válido.");
}

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
app.use(express.json({ limit: "4mb" }));
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
    CREATE TABLE IF NOT EXISTS promotion_evidence (
      promotion_id BIGINT PRIMARY KEY REFERENCES promotions(id) ON DELETE CASCADE,
      mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp')),
      image_data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
      from_role TEXT,
      to_role TEXT,
      reason TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_by_role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE admin_requests ADD COLUMN IF NOT EXISTS from_role TEXT;
    ALTER TABLE admin_requests ADD COLUMN IF NOT EXISTS to_role TEXT;
    ALTER TABLE admin_requests ADD COLUMN IF NOT EXISTS created_by_username TEXT;
    CREATE TABLE IF NOT EXISTS profile_settings (
      roblox_user_id TEXT PRIMARY KEY,
      bio TEXT NOT NULL DEFAULT '',
      tagline TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS whitelist_entries (
      id BIGSERIAL PRIMARY KEY,
      roblox_user_id TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS rank_service (
      roblox_user_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      role_name TEXT NOT NULL,
      role_rank INTEGER NOT NULL,
      rank_since TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS rank_service_rank_idx ON rank_service(role_name, rank_since);
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL
    );
    INSERT INTO app_settings (setting_key, setting_value)
      VALUES ('cdp_activated_at', NOW()::text)
      ON CONFLICT (setting_key) DO NOTHING;
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
// Nomes alternativos retornados pelo Roblox são convertidos para a nomenclatura
// oficial do EB Manager antes da consulta da regra. Isso não cria prazos novos.
function normalizeCdpRoleName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/•/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}
const CDP_ROLE_ALIASES = new Map([
  ["t sgt terceiro sargento", "[3• SGT] Terceiro Sargento"],
  ["terceiro sargento", "[3• SGT] Terceiro Sargento"],
  ["s sgt segundo sargento", "[2• SGT] Segundo Sargento"],
  ["segundo sargento", "[2• SGT] Segundo Sargento"],
  ["p sgt primeiro sargento", "[1• SGT] Primeiro Sargento"],
  ["primeiro sargento", "[1• SGT] Primeiro Sargento"],
  ["cdt cadete", "[CT] Cadete"],
  ["cadete", "[CT] Cadete"],
  ["asp aspirante a oficial", "[ASP] Aspirante a Oficial"],
  ["asp aspirante oficial", "[ASP] Aspirante a Oficial"],
  ["aspirante a oficial", "[ASP] Aspirante a Oficial"],
  ["marechal", "[MR] Marechal"],
  ["presidente", "[PRES] Presidente"],
  ["vice presidente", "[V-PRES] Vice Presidente"],
  ["v pres vice presidente", "[V-PRES] Vice Presidente"],
  ["comandante", "[CMT] Comandante"],
  ["s cmt sub comandante", "[S-CMT] Sub Comandante"],
  ["sub comandante", "[S-CMT] Sub Comandante"],
  ["gen ex general do exercito", "[GEN-EX] General do Exército"],
  ["general do exercito", "[GEN-EX] General do Exército"],
  ["gen div general de divisao", "[GEN-DIV] General de Divisão"],
  ["general de divisao", "[GEN-DIV] General de Divisão"],
  ["gen bda general de brigada", "[GEN-BDA] General de Brigada"],
  ["general de brigada", "[GEN-BDA] General de Brigada"],
  ["coronel", "[CEL] Coronel"],
  ["ten cel tenente coronel", "[TEN-CEL] Tenente-Coronel"],
  ["tenente coronel", "[TEN-CEL] Tenente-Coronel"],
  ["major", "[MAJ] Major"],
  ["cap capitao", "[CAP] Capitão"],
  ["capitão", "[CAP] Capitão"],
  ["capitao", "[CAP] Capitão"],
  ["adm g administrador geral", "[ADM-G] Administrador Geral"],
  ["administrador geral", "[ADM-G] Administrador Geral"],
  ["mod moderador", "[MOD] Moderador"],
  ["moderador", "[MOD] Moderador"]
]);
function getCdpRule(roleName) {
  const normalized = normalizeCdpRoleName(roleName);
  const canonicalName = CDP_ROLE_ALIASES.get(normalized);
  const targetName = normalizeCdpRoleName(canonicalName || roleName);
  const key = Object.keys(cdpRules).find(name => normalizeCdpRoleName(name) === targetName);
  if (!key) return null;
  const raw = cdpRules[key];
  if (Number.isFinite(Number(raw)) && typeof raw !== "object") {
    const hours = Number(raw);
    return hours >= 0 ? { hours, creatorOnly: false } : null;
  }
  if (!raw || typeof raw !== "object" || !Number.isFinite(Number(raw.hours)) || Number(raw.hours) < 0) return null;
  return { hours: Number(raw.hours), creatorOnly: Boolean(raw.creatorOnly) };
}
async function getCdpActivationAt() {
  const result = await pool.query("SELECT setting_value FROM app_settings WHERE setting_key = 'cdp_activated_at'");
  return result.rows[0]?.setting_value || new Date().toISOString();
}
async function syncCdpMembers(members) {
  if (!members.length) return;
  const activationAt = await getCdpActivationAt();
  await pool.query(
    `INSERT INTO rank_service (roblox_user_id, username, role_name, role_rank, rank_since)
     SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::int[], $5::timestamptz[])
     ON CONFLICT (roblox_user_id) DO UPDATE SET
       username = EXCLUDED.username,
       rank_since = CASE
         WHEN rank_service.role_name IS DISTINCT FROM EXCLUDED.role_name
           OR rank_service.role_rank IS DISTINCT FROM EXCLUDED.role_rank
         THEN NOW() ELSE rank_service.rank_since END,
       role_name = EXCLUDED.role_name,
       role_rank = EXCLUDED.role_rank,
       updated_at = NOW()`,
    [
      members.map(m => String(m.userId)),
      members.map(m => String(m.username)),
      members.map(m => String(m.roleName)),
      members.map(m => Number(m.rank || 0)),
      members.map(() => activationAt)
    ]
  );
}
async function ensureCdpMember(userId, username, roleName, rank) {
  const activationAt = await getCdpActivationAt();
  await pool.query(
    `INSERT INTO rank_service (roblox_user_id, username, role_name, role_rank, rank_since)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (roblox_user_id) DO UPDATE SET
       username = EXCLUDED.username,
       rank_since = CASE
         WHEN rank_service.role_name IS DISTINCT FROM EXCLUDED.role_name
           OR rank_service.role_rank IS DISTINCT FROM EXCLUDED.role_rank
         THEN NOW() ELSE rank_service.rank_since END,
       role_name = EXCLUDED.role_name,
       role_rank = EXCLUDED.role_rank,
       updated_at = NOW()`,
    [String(userId), String(username), String(roleName), Number(rank || 0), activationAt]
  );
  const result = await pool.query("SELECT rank_since FROM rank_service WHERE roblox_user_id = $1", [String(userId)]);
  return result.rows[0]?.rank_since || activationAt;
}
async function checkCdpEligibility(target, currentRole, destinationRole, actorAccess) {
  const currentRule = getCdpRule(currentRole.name);
  if (!currentRule) {
    return { ok: false, error: "O tempo mínimo desta patente ainda não foi configurado no CDP. A promoção está bloqueada até a regra ser cadastrada." };
  }
  const destinationRule = getCdpRule(destinationRole);
  if (destinationRule?.creatorOnly && actorAccess !== "creator") {
    return { ok: false, error: "Esta patente só pode ser concedida pelo Criador." };
  }
  const rankSince = await ensureCdpMember(target.id, target.name, currentRole.name, currentRole.rank);
  const elapsedHours = Math.max(0, (Date.now() - new Date(rankSince).getTime()) / 3600000);
  if (elapsedHours < currentRule.hours) {
    const remaining = Math.ceil((currentRule.hours - elapsedHours) * 10) / 10;
    return { ok: false, error: `Promoção bloqueada pelo CDP: são necessárias ${currentRule.hours} horas nesta patente. Faltam aproximadamente ${remaining} horas.` };
  }
  return { ok: true };
}
async function resetCdpMember(userId, username, roleName, rank) {
  await pool.query(
    `INSERT INTO rank_service (roblox_user_id, username, role_name, role_rank, rank_since)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (roblox_user_id) DO UPDATE SET
       username = EXCLUDED.username, role_name = EXCLUDED.role_name,
       role_rank = EXCLUDED.role_rank, rank_since = NOW(), updated_at = NOW()`,
    [String(userId), String(username), String(roleName), Number(rank || 0)]
  );
}

function minimumPromoterRank() {
  const aspiranteEntry = Object.entries(roleRanks).find(([name, value]) =>
    /aspirante/i.test(name) && Number.isInteger(value)
  );
  return aspiranteEntry ? aspiranteEntry[1] : MIN_PROMOTER_RANK;
}
function canPromote(user) {
  return Number(user?.groupRoleRank) >= minimumPromoterRank();
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
      const userPath = typeof item.user === "string" ? item.user : "";
      const nestedId = item.user?.userId || item.user?.id || item.userId || "";
      const id = userPath.startsWith("users/") ? userPath.slice("users/".length) : String(nestedId);
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
  res.json({ user: req.session.user, csrfToken: req.session.csrfToken, permissions: { canPromote: canPromote(req.session.user) } });
});
app.post("/auth/logout", requireLogin, requireCsrf, (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: "Não foi possível encerrar a sessão." });
    res.clearCookie("ebm.sid", { httpOnly: true, sameSite: "lax", secure: isProduction });
    res.json({ ok: true });
  });
});


let groupMembersCache = { at: 0, members: null };
async function listCloudGroupRoles() {
  let pageToken = "";
  const roles = new Map();
  for (let page = 0; page < 10; page++) {
    const url = new URL("https://apis.roblox.com/cloud/v2/groups/" + encodeURIComponent(GROUP_ID) + "/roles");
    url.searchParams.set("maxPageSize", "20");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const data = await openCloudJson(url.toString());
    for (const role of (data.groupRoles || data.roles || [])) {
      const pathValue = String(role.path || "");
      const id = String(role.id || pathValue.split("/").pop() || "");
      if (id) roles.set(id, {
        id,
        name: String(role.displayName || role.name || "Patente sem nome"),
        rank: Number(role.rank || 0)
      });
    }
    pageToken = data.nextPageToken || "";
    if (!pageToken) break;
  }
  return roles;
}
async function listGroupMembersFromCloud() {
  const memberships = [];
  let pageToken = "";
  for (let page = 0; page < 100; page++) {
    const url = new URL("https://apis.roblox.com/cloud/v2/groups/" + encodeURIComponent(GROUP_ID) + "/memberships");
    url.searchParams.set("maxPageSize", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const data = await openCloudJson(url.toString());
    memberships.push(...(data.groupMemberships || data.memberships || []));
    pageToken = data.nextPageToken || "";
    if (!pageToken) break;
  }
  const roleMap = await listCloudGroupRoles();
  const ids = [...new Set(memberships.map(item => {
    const userPath = typeof item.user === "string" ? item.user : "";
    const nestedId = item.user?.userId || item.user?.id || item.userId || "";
    return userPath.startsWith("users/") ? userPath.slice(6) : String(nestedId);
  }).filter(Boolean))];
  const userMap = new Map();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const chunk = ids.slice(offset, offset + 100).map(id => Number(id)).filter(Number.isSafeInteger);
    if (!chunk.length) continue;
    const data = await robloxJson("https://users.roblox.com/v1/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userIds: chunk, excludeBannedUsers: false })
    });
    for (const user of (data.data || [])) userMap.set(String(user.id), user);
  }
  return memberships.map(item => {
    const userPath = typeof item.user === "string" ? item.user : "";
    const nestedId = item.user?.userId || item.user?.id || item.userId || "";
    const userId = userPath.startsWith("users/") ? userPath.slice(6) : String(nestedId);
    const rolePath = typeof item.role === "string" ? item.role : "";
    const roleId = rolePath.split("/").pop() || String(item.role?.roleId || item.role?.id || "");
    const role = roleMap.get(roleId);
    const user = userMap.get(userId);
    return {
      userId,
      username: String(user?.name || "Usuário " + userId),
      displayName: String(user?.displayName || user?.name || "—"),
      roleName: role?.name || "Patente não identificada",
      rank: Number(role?.rank || 0)
    };
  }).filter(member => member.userId).sort((a, b) => b.rank - a.rank || a.username.localeCompare(b.username, "pt-BR"));
}
app.get("/api/group/members", requireLogin, async (_req, res) => {
  if (groupMembersCache.members && Date.now() - groupMembersCache.at < 60_000) {
    return res.json({ groupId: GROUP_ID, updatedAt: new Date(groupMembersCache.at).toISOString(), members: groupMembersCache.members });
  }
  try {
    const members = await listGroupMembersFromCloud();
    await syncCdpMembers(members);
    groupMembersCache = { at: Date.now(), members };
    res.json({ groupId: GROUP_ID, updatedAt: new Date(groupMembersCache.at).toISOString(), members });
  } catch (err) {
    console.error("Falha ao consultar membros do grupo Roblox:", err.message);
    res.status(502).json({ error: "Não foi possível carregar os membros. Verifique se a API Key tem permissão group:read para este grupo." });
  }
});
app.get("/api/cdp", requireLogin, async (_req, res) => {
  try {
    let members = groupMembersCache.members;
    if (!members || Date.now() - groupMembersCache.at >= 60_000) {
      members = await listGroupMembersFromCloud();
      groupMembersCache = { at: Date.now(), members };
    }
    await syncCdpMembers(members);
    const result = await pool.query("SELECT roblox_user_id, username, role_name, role_rank, rank_since FROM rank_service ORDER BY role_rank DESC, username ASC");
    const now = Date.now();
    const currentIds = new Set(members.map(member => String(member.userId)));
    const tracked = result.rows.filter(row => currentIds.has(String(row.roblox_user_id))).map(row => {
      const rule = getCdpRule(row.role_name);
      const elapsedHours = Math.max(0, (now - new Date(row.rank_since).getTime()) / 3600000);
      return {
        userId: row.roblox_user_id,
        username: row.username,
        roleName: row.role_name,
        rank: row.role_rank,
        rankSince: row.rank_since,
        elapsedHours: Math.floor(elapsedHours * 10) / 10,
        requiredHours: rule ? rule.hours : null,
        ruleConfigured: Boolean(rule),
        creatorOnly: Boolean(rule?.creatorOnly),
        eligible: Boolean(rule && elapsedHours >= rule.hours)
      };
    });
    res.json({ activationAt: await getCdpActivationAt(), members: tracked });
  } catch (err) {
    console.error("Falha ao consultar CDP:", err.message);
    res.status(502).json({ error: "Não foi possível carregar o CDP. Verifique a integração do grupo Roblox." });
  }
});

app.get("/api/profile", requireLogin, async (req, res) => {
  const user = req.session.user;
  try {
    const [settings, promotions, demotions, trainings, history] = await Promise.all([
      pool.query("SELECT bio, tagline, updated_at FROM profile_settings WHERE roblox_user_id = $1", [user.robloxId]),
      pool.query("SELECT COUNT(*)::int AS total, MAX(created_at) AS last_at FROM promotions WHERE target_user_id = $1", [user.robloxId]),
      pool.query("SELECT COUNT(*)::int AS total FROM admin_requests WHERE target_user_id = $1 AND action IN ('demote','revoke') AND status = 'applied'", [user.robloxId]),
      pool.query("SELECT COUNT(*)::int AS total FROM panel_records WHERE record_type = 'training' AND lower(data->>'person') = lower($1)", [user.username]),
      pool.query(`
        SELECT created_at, 'Promoção'::text AS title, from_role, to_role, reason
          FROM promotions WHERE target_user_id = $1
        UNION ALL
        SELECT created_at,
          CASE action WHEN 'demote' THEN 'Rebaixamento' WHEN 'revoke' THEN 'Revogação' ELSE 'Alteração de patente' END AS title,
          from_role, to_role, reason
          FROM admin_requests WHERE target_user_id = $1 AND status = 'applied'
        UNION ALL
        SELECT created_at, ('Treinamento: ' || COALESCE(data->>'training', 'Concluído')) AS title,
          NULL::text AS from_role, NULL::text AS to_role,
          CONCAT_WS(' · ',
            CASE WHEN data->>'score' IS NOT NULL THEN ('Pontuação: ' || (data->>'score')) END,
            CASE WHEN data->>'instructor' IS NOT NULL THEN ('Instrutor: ' || (data->>'instructor')) END) AS reason
          FROM panel_records
          WHERE record_type = 'training' AND lower(data->>'person') = lower($2)
        ORDER BY created_at DESC LIMIT 30
      `, [user.robloxId, user.username])
    ]);
    let joinedAt = null;
    try {
      const membership = await getCloudMembership(user.robloxId);
      joinedAt = membership?.createTime || membership?.createdAt || membership?.joinTime || null;
    } catch (error) {
      console.warn("Data de entrada no grupo indisponível:", error.message);
    }
    res.json({
      profile: {
        username: user.username, displayName: user.displayName, robloxId: user.robloxId,
        avatar: user.avatar, groupId: user.groupId, roleName: user.groupRoleName,
        roleId: user.groupRoleId, rank: user.groupRoleRank, joinedAt,
        bio: settings.rows[0]?.bio || "", tagline: settings.rows[0]?.tagline || "",
        updatedAt: settings.rows[0]?.updated_at || null,
        stats: {
          promotions: promotions.rows[0]?.total || 0,
          lastPromotionAt: promotions.rows[0]?.last_at || null,
          demotions: demotions.rows[0]?.total || 0,
          trainings: trainings.rows[0]?.total || 0,
          records: history.rows.length
        },
        history: history.rows,
        cdp: await (async () => {
          const rankSince = await ensureCdpMember(user.robloxId, user.username, user.groupRoleName, user.groupRoleRank);
          const rule = getCdpRule(user.groupRoleName);
          const elapsedHours = Math.max(0, (Date.now() - new Date(rankSince).getTime()) / 3600000);
          return {
            rankSince,
            elapsedHours: Math.floor(elapsedHours * 10) / 10,
            requiredHours: rule ? rule.hours : null,
            ruleConfigured: Boolean(rule),
            creatorOnly: Boolean(rule?.creatorOnly),
            eligible: Boolean(rule && elapsedHours >= rule.hours)
          };
        })()
      }
    });
  } catch (err) {
    console.error("Falha ao carregar perfil:", err.message);
    res.status(500).json({ error: "Não foi possível carregar os dados do perfil." });
  }
});
app.put("/api/profile", requireLogin, requireCsrf, async (req, res) => {
  const bio = String(req.body?.bio || "").trim();
  const tagline = String(req.body?.tagline || "").trim();
  if (bio.length > 300 || tagline.length > 80) {
    return res.status(400).json({ error: "A biografia deve ter até 300 caracteres e a frase até 80." });
  }
  try {
    await pool.query(
      `INSERT INTO profile_settings (roblox_user_id, bio, tagline, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (roblox_user_id) DO UPDATE SET bio = EXCLUDED.bio, tagline = EXCLUDED.tagline, updated_at = NOW()`,
      [req.session.user.robloxId, bio, tagline]
    );
    res.json({ ok: true, bio, tagline });
  } catch (err) {
    console.error("Falha ao salvar perfil:", err.message);
    res.status(500).json({ error: "Não foi possível salvar sua apresentação." });
  }
});

app.get("/api/logs", requireLogin, async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, created_at, 'promotion'::TEXT AS action,
        target_username, from_role, to_role, author_username AS author,
        author_role AS author_role, reason, 'applied'::TEXT AS status
      FROM promotions
      UNION ALL
      SELECT id, created_at, action::TEXT AS action,
        target_username, from_role,
        COALESCE(to_role, requested_role) AS to_role,
        COALESCE(created_by_username, created_by) AS author, created_by_role AS author_role,
        reason, status
      FROM admin_requests
      WHERE status = 'applied'
      ORDER BY created_at DESC
      LIMIT 500
    `);
    res.json({ logs: result.rows });
  } catch (err) {
    console.error("Falha ao consultar histórico unificado:", err.message);
    res.status(500).json({ error: "Não foi possível consultar o histórico." });
  }
});

app.get("/api/promotions/:id/evidence", requireLogin, async (req, res) => {
  if (!/^\\d+$/.test(req.params.id)) return res.status(400).json({ error: "Identificador inválido." });
  try {
    const result = await pool.query("SELECT mime_type, image_data FROM promotion_evidence WHERE promotion_id = $1", [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: "Comprovante não encontrado." });
    res.set("Content-Type", result.rows[0].mime_type);
    res.set("Cache-Control", "private, no-store");
    res.send(result.rows[0].image_data);
  } catch (err) {
    console.error("Falha ao consultar foto da promoção:", err.message);
    res.status(500).json({ error: "Não foi possível carregar o comprovante." });
  }
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
  const evidenceData = body.evidenceData;
  if (![targetUsername, fromRole, toRole, reason].every(value => typeof value === "string" && value.trim())) {
    return res.status(400).json({ error: "Preencha militar, patente atual, nova patente e motivo." });
  }
  if (targetUsername.length > 40 || reason.length > 1000) return res.status(400).json({ error: "Algum campo ultrapassou o limite permitido." });
  if (typeof evidenceData !== "string") return res.status(400).json({ error: "A foto EM CUNHA é obrigatória. Envie a imagem antes de entregar a patente." });
  const evidenceMatch = evidenceData.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!evidenceMatch) return res.status(400).json({ error: "A foto precisa estar em JPG, PNG ou WEBP válido." });
  const evidenceMime = evidenceMatch[1];
  const evidenceBuffer = Buffer.from(evidenceMatch[2], "base64");
  if (!evidenceBuffer.length || evidenceBuffer.length > 2 * 1024 * 1024) return res.status(400).json({ error: "A foto deve ter no máximo 2 MB." });
  const validImage =
    (evidenceMime === "image/jpeg" && evidenceBuffer.subarray(0,3).equals(Buffer.from([0xff,0xd8,0xff]))) ||
    (evidenceMime === "image/png" && evidenceBuffer.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) ||
    (evidenceMime === "image/webp" && evidenceBuffer.toString("ascii",0,4) === "RIFF" && evidenceBuffer.toString("ascii",8,12) === "WEBP");
  if (!validImage) return res.status(400).json({ error: "O arquivo enviado não parece ser uma imagem válida." });
  const author = req.session.user;
  if (!canPromote(author)) return res.status(403).json({ error: "Permissão negada: somente Aspirante a Oficial ou patente superior pode promover." });
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
    const cdpCheck = await checkCdpEligibility(target, targetRole, toRole.trim(), req.session.specialAccess);
    if (!cdpCheck.ok) return res.status(403).json({ error: cdpCheck.error });
    if (!process.env.ROBLOX_OPEN_CLOUD_API_KEY) return res.status(503).json({ error: "A integração Open Cloud ainda não foi configurada no Render." });
    const roleIds = JSON.parse(process.env.ROLE_IDS_JSON || "{}");
    const targetRoleId = roleIds[toRole.trim()];
    if (!targetRoleId) return res.status(503).json({ error: "Falta mapear o ID real da patente de destino em ROLE_IDS_JSON." });
    await assignCloudRole(target.id, String(targetRoleId));
    await resetCdpMember(target.id, target.name, toRole.trim(), toRank);
    const saved = await pool.query(
      `INSERT INTO promotions (created_at, target_user_id, target_username, from_role, to_role, author_user_id, author_username, author_role, reason)
       VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [target.id, target.name, fromRole.trim(), toRole.trim(), author.robloxId, author.username, author.groupRoleName, reason.trim()]
    );
    await pool.query(
      "INSERT INTO promotion_evidence (promotion_id, mime_type, image_data) VALUES ($1, $2, $3)",
      [saved.rows[0].id, evidenceMime, evidenceBuffer]
    );
    res.status(201).json({ ok: true, applied: true, promotionId: saved.rows[0].id, evidenceSaved: true });
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
    if (action === "set_role") {
      const cdpCheck = await checkCdpEligibility(target, currentRole, requestedRole, access);
      if (!cdpCheck.ok) return res.status(403).json({ error: cdpCheck.error });
    }
    if (!process.env.ROBLOX_OPEN_CLOUD_API_KEY) return res.status(503).json({ error: "Configure ROBLOX_OPEN_CLOUD_API_KEY no Render antes de aplicar alterações." });
    const roleIds = JSON.parse(process.env.ROLE_IDS_JSON || "{}");
    let destinationRoleId = null;
    let destinationLabel = requestedRole;
    if (action === "set_role") {
      destinationRoleId = roleIds[requestedRole];
      if (!destinationRoleId) return res.status(503).json({ error: "Falta mapear o ID real da patente em ROLE_IDS_JSON." });
      const destinationRank = roleRank(requestedRole);
      if (access !== "creator" && destinationRank >= Number(req.session.user.groupRoleRank)) {
        return res.status(403).json({ error: "O painel ADM não pode atribuir uma patente igual ou superior à patente de quem está operando." });
      }
    } else {
      const currentRank = Number(currentRole.rank);
      const configured = Object.entries(roleRanks).filter(([, rank]) => Number.isInteger(rank)).sort((a,b) => b[1]-a[1]);
      const lower = configured.find(([, rank]) => rank < currentRank);
      const recruit = configured[configured.length - 1];
      destinationLabel = action === "revoke" ? recruit?.[0] : lower?.[0];
      if (!destinationLabel) return res.status(400).json({ error: "Não foi possível determinar a patente de destino. Revise ROLE_RANKS_JSON." });
      destinationRoleId = roleIds[destinationLabel];
      if (!destinationRoleId) return res.status(503).json({ error: "Falta mapear a patente de destino em ROLE_IDS_JSON." });
    }
    if (String(target.id) === String(req.session.user.robloxId)) return res.status(403).json({ error: "Você não pode alterar a própria patente por este painel." });
    if (currentRole.rank >= req.session.user.groupRoleRank && access !== "creator") return res.status(403).json({ error: "Você não pode alterar a patente de alguém de nível igual ou superior ao seu." });
    if (action === "set_role" && access !== "creator" && roleRank(requestedRole) <= currentRole.rank) {
      return res.status(400).json({ error: "O painel ADM só pode atribuir uma patente superior à patente atual. Use o painel CGEx para rebaixamento ou revogação." });
    }
    await assignCloudRole(target.id, String(destinationRoleId));
    await resetCdpMember(target.id, target.name, destinationLabel, roleRank(destinationLabel) ?? currentRole.rank);
    await pool.query(
      `INSERT INTO admin_requests (action, target_user_id, target_username, requested_role, from_role, to_role, reason, created_by, created_by_username, created_by_role, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'applied')`,
      [action, target.id, target.name, destinationLabel, currentRole.name, destinationLabel, reason, req.session.user.robloxId, req.session.user.username, access]
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

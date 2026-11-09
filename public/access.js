(() => {
  const nav = document.getElementById("nav");
  const content = document.querySelector(".content");
  if (!nav || !content) return;
  const navButton = document.createElement("button");
  navButton.dataset.page = "acessos";
  navButton.innerHTML = '<span class="ico" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="m11 12 8-8 2 2-2 2 2 2-3 3-2-2-2 2"/></svg></span>Acessos restritos';
  nav.appendChild(navButton);

  const section = document.createElement("section");
  section.id = "page-acessos";
  section.className = "page hidden";
  section.innerHTML = `
    <div class="pagehead"><div><h1>Acessos especiais</h1><p class="sub">Área protegida por código e pela sua sessão Roblox.</p></div></div>
    <div class="card">
      <form id="specialAccessForm" class="formgrid">
        <div class="field full"><label>Código de acesso</label><input id="specialCode" type="password" inputmode="numeric" autocomplete="off" maxlength="32" required placeholder="Digite seu código"></div>
        <div class="field full"><button class="btn primary">Validar acesso</button></div>
      </form>
      <p id="specialMessage" class="muted" aria-live="polite">Entre com Roblox e informe seu código.</p>
    </div>
    <div id="specialPanels" class="hidden">
      <div class="card section"><h2 id="specialTitle">Painel</h2><p id="specialDescription" class="muted"></p></div>
      <div id="adminPanel" class="card section hidden">
        <h2>Administração — solicitação de patente</h2>
        <form id="adminRoleForm" class="formgrid">
          <div class="field"><label>Usuário Roblox</label><input name="username" required maxlength="40"></div>
          <div class="field"><label>Patente desejada</label><select name="role" id="adminRoleSelect"></select></div>
          <div class="field full"><label>Motivo</label><textarea name="reason" required maxlength="1000"></textarea></div>
          <div class="field full"><button class="btn primary">Registrar solicitação</button></div>
        </form>
      </div>
      <div id="cgexPanel" class="card section hidden">
        <h2>CGEx — revogação e rebaixamento</h2>
        <form id="cgexForm" class="formgrid">
          <div class="field"><label>Usuário Roblox</label><input name="username" required maxlength="40"></div>
          <div class="field"><label>Ação</label><select name="action"><option value="demote">Rebaixamento</option><option value="revoke">Revogação</option></select></div>
          <div class="field full"><label>Motivo</label><textarea name="reason" required maxlength="1000"></textarea></div>
          <div class="field full"><button class="btn danger">Registrar solicitação</button></div>
        </form>
      </div>
      <div id="creatorPanel" class="card section hidden">
        <h2>Criador — controle de WL</h2>
        <form id="wlForm" class="formgrid">
          <div class="field"><label>Usuário Roblox para WL</label><input name="username" required maxlength="40"></div>
          <div class="field"><label>Observação (opcional)</label><input name="note" maxlength="300"></div>
          <div class="field full"><button class="btn primary">Adicionar à WL</button></div>
        </form>
        <div id="wlList" class="section empty">Carregando lista...</div>
      </div>
      <div class="card section"><h2>Solicitações administrativas</h2><p class="muted">As operações autorizadas são aplicadas diretamente no grupo Roblox e registradas no histórico. Se a integração ou as permissões não estiverem configuradas, o servidor informa o erro e não confirma a alteração.</p><div id="adminRequests" class="empty">Nenhuma solicitação carregada.</div></div>
    </div>`;
  content.appendChild(section);

  function switchPage(name) {
    document.querySelectorAll(".page").forEach(el => el.classList.add("hidden"));
    const target = document.getElementById("page-" + name);
    if (target) target.classList.remove("hidden");
    document.querySelectorAll("#nav button").forEach(el => el.classList.toggle("active", el.dataset.page === name));
    const crumb = document.getElementById("crumb");
    if (crumb) crumb.textContent = name === "acessos" ? "Acessos restritos" : name;
  }
  navButton.addEventListener("click", () => switchPage("acessos"));
  const message = document.getElementById("specialMessage");
  const panels = document.getElementById("specialPanels");
  let currentAccess = null;

  async function api(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      ...options,
      headers: { ...(options.headers || {}), ...(options.method && options.method !== "GET" ? { "Content-Type": "application/json", "x-csrf-token": (typeof csrfToken !== "undefined" ? csrfToken : "") } : {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Não foi possível concluir a solicitação.");
    return data;
  }
  function formData(form) { return Object.fromEntries(new FormData(form).entries()); }
  async function loadRequests() {
    const data = await api("/api/admin/requests");
    document.getElementById("adminRequests").innerHTML = data.requests.length
      ? data.requests.map(item => '<div class="rank"><b>' + safe(item.target_username) + ' · ' + safe(item.action) + '</b><small>' + safe(item.created_at) + ' · ' + safe(item.status) + '</small></div>').join("")
      : "Nenhuma solicitação registrada.";
  }
  function safe(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
  }
  async function loadWhitelist() {
    const data = await api("/api/whitelist");
    document.getElementById("wlList").innerHTML = data.entries.length
      ? data.entries.map(item => '<div class="rank"><b>' + safe(item.username) + '</b><small>' + safe(item.note || "Sem observação") + '</small><button class="btn danger" type="button" data-remove-wl="' + Number(item.id) + '">Remover</button></div>').join("")
      : "WL vazia.";
  }

  document.getElementById("specialAccessForm").addEventListener("submit", async event => {
    event.preventDefault();
    try {
      const data = await api("/api/access/verify", { method: "POST", body: JSON.stringify({ code: document.getElementById("specialCode").value }) });
      currentAccess = data.access;
      document.getElementById("specialCode").value = "";
      message.textContent = "Acesso validado: " + data.label + ".";
      panels.classList.remove("hidden");
      document.getElementById("specialTitle").textContent = data.label;
      document.getElementById("specialDescription").textContent = data.description;
      document.getElementById("adminPanel").classList.toggle("hidden", !["admin", "creator"].includes(currentAccess));
      document.getElementById("cgexPanel").classList.toggle("hidden", !["cgex", "creator"].includes(currentAccess));
      document.getElementById("creatorPanel").classList.toggle("hidden", currentAccess !== "creator");
      const select = document.getElementById("adminRoleSelect");
      if (typeof ranks !== "undefined") select.innerHTML = ranks.map(role => '<option>' + safe(role) + '</option>').join("");
      await loadRequests();
      if (typeof loadServerLogs === "function") await loadServerLogs();
      if (currentAccess === "creator") await loadWhitelist();
    } catch (error) { message.textContent = error.message; }
  });

  document.getElementById("adminRoleForm").addEventListener("submit", async event => {
    event.preventDefault();
    try {
      const body = formData(event.target); body.action = "set_role";
      await api("/api/admin/requests", { method: "POST", body: JSON.stringify(body) });
      event.target.reset(); await loadRequests(); if (typeof loadServerLogs === "function") await loadServerLogs(); alert("Patente alterada no grupo Roblox e registrada nos logs.");
    } catch (error) { alert(error.message); }
  });
  document.getElementById("cgexForm").addEventListener("submit", async event => {
    event.preventDefault();
    try {
      await api("/api/admin/requests", { method: "POST", body: JSON.stringify(formData(event.target)) });
      event.target.reset(); await loadRequests(); if (typeof loadServerLogs === "function") await loadServerLogs(); alert("Alteração aplicada no grupo Roblox e registrada nos logs.");
    } catch (error) { alert(error.message); }
  });
  document.getElementById("wlList").addEventListener("click", async event => {
    const button = event.target.closest("[data-remove-wl]");
    if (!button) return;
    if (!confirm("Remover este usuário da WL?")) return;
    try {
      await api("/api/whitelist/" + encodeURIComponent(button.dataset.removeWl), { method: "DELETE" });
      await loadWhitelist();
    } catch (error) { alert(error.message); }
  });
  document.getElementById("wlForm").addEventListener("submit", async event => {
    event.preventDefault();
    try {
      await api("/api/whitelist", { method: "POST", body: JSON.stringify(formData(event.target)) });
      event.target.reset(); await loadWhitelist(); alert("Usuário adicionado à lista de permissões do painel.");
    } catch (error) { alert(error.message); }
  });
  document.addEventListener("click", event => {
    if (event.target && event.target.dataset.page === "acessos") switchPage("acessos");
  });
  api("/api/access").then(data => {
    if (data.access) { message.textContent = "Você já possui acesso especial: " + data.access + ". Digite novamente o código para abrir os painéis."; }
  }).catch(() => {});
})();
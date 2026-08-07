// ============================================================
// users.js — pannello admin: gestione utenti e ruoli
// Richiede firebase-config.js e auth.js già caricati.
// ============================================================

let currentProfile = null;
let rolesCache = []; // [{id, permessi:[...]}]

const KNOWN_PERMISSIONS = [
  { id: "*", label: "Amministratore (tutti i permessi)" },
  { id: "diario:leggi_tutti", label: "Diario: leggere le voci di tutti" },
  { id: "diario:gestisci_tutti", label: "Diario: modificare/cancellare le voci di tutti" },
  { id: "users:gestisci", label: "Gestire utenti" },
  { id: "ruoli:gestisci", label: "Gestire ruoli e permessi" },
  { id: "config:gestisci", label: "Gestire configurazione (tipi attività, tariffe, campi)" }
];

function permessoLabel(id) {
  return (KNOWN_PERMISSIONS.find(p => p.id === id) || {}).label || id;
}

function getCheckedPermessi() {
  return Array.from(document.querySelectorAll("#new-role-permessi-list input[type=checkbox]:checked")).map(cb => cb.value);
}

function setCheckedPermessi(permessi) {
  document.querySelectorAll("#new-role-permessi-list input[type=checkbox]").forEach(cb => {
    cb.checked = (permessi || []).includes(cb.value);
  });
  syncAdminExclusive();
}

function syncAdminExclusive() {
  const adminCb = document.getElementById("perm-admin");
  document.querySelectorAll("#new-role-permessi-list input[type=checkbox]:not(#perm-admin)").forEach(cb => {
    cb.disabled = adminCb.checked;
    if (adminCb.checked) cb.checked = false;
  });
}

// ---------- Creazione utente senza perdere la sessione admin ----------
// Creare un utente con l'SDK client normale forza il login automatico
// sul nuovo account, disconnettendo l'admin. Per evitarlo, usiamo una
// seconda istanza "di servizio" della stessa app Firebase, isolata
// dalla sessione principale.
function getSecondaryAuth() {
  let secondaryApp = firebase.apps.find(a => a.name === "Secondary");
  if (!secondaryApp) {
    secondaryApp = firebase.initializeApp(firebaseConfig, "Secondary");
  }
  return secondaryApp.auth();
}

// ---------- Utenti ----------

async function loadUsers() {
  const list = document.getElementById("users-list");
  list.innerHTML = `<div class="empty-state"><div class="display">Caricamento…</div></div>`;

  const snap = await db.collection("users").orderBy("nome").get();
  const users = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  if (users.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="display">Nessun utente</div></div>`;
    return;
  }

  list.innerHTML = users.map(u => {
    const roleLabel = u.ruoloNome || u.ruoloId || "—";
    return `
      <div class="entry-card" data-uid="${u.id}">
        <div class="entry-main">
          <div class="entry-tipo">${escapeHtml(u.nome || u.id)}</div>
          <div class="entry-meta">${escapeHtml(u.email || "")} · ${escapeHtml(roleLabel)}${u.soggettoQuotaCampo ? " · quota campo" : ""}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <button class="btn btn-ghost toggle-active-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-uid="${u.id}" data-attivo="${u.attivo !== false}">
            ${u.attivo !== false ? "Attivo" : "Disattivato"}
          </button>
          <button class="btn btn-ghost toggle-quotacampo-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-uid="${u.id}" data-quotacampo="${!!u.soggettoQuotaCampo}">
            ${u.soggettoQuotaCampo ? "Quota: sì" : "Quota: no"}
          </button>
        </div>
      </div>
    `;
  }).join("");

  list.querySelectorAll(".toggle-active-btn").forEach(btn => {
    btn.addEventListener("click", onToggleActive);
  });
  list.querySelectorAll(".toggle-quotacampo-btn").forEach(btn => {
    btn.addEventListener("click", onToggleQuotaCampo);
  });
}

async function onToggleActive(e) {
  const btn = e.currentTarget;
  const uid = btn.dataset.uid;
  const nuovoStato = btn.dataset.attivo !== "true";
  btn.disabled = true;
  try {
    await db.collection("users").doc(uid).update({ attivo: nuovoStato });
    await loadUsers();
  } catch (err) {
    showError(document.getElementById("users-list-error"), "Errore: " + err.message);
    btn.disabled = false;
  }
}

async function onToggleQuotaCampo(e) {
  const btn = e.currentTarget;
  const uid = btn.dataset.uid;
  const nuovoStato = btn.dataset.quotacampo !== "true";
  btn.disabled = true;
  try {
    await db.collection("users").doc(uid).update({ soggettoQuotaCampo: nuovoStato });
    await loadUsers();
  } catch (err) {
    showError(document.getElementById("users-list-error"), "Errore: " + err.message);
    btn.disabled = false;
  }
}

async function populateRoleSelect() {
  const select = document.getElementById("new-user-ruolo");
  const snap = await db.collection("roles").get();
  rolesCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  select.innerHTML = rolesCache.map(r => `<option value="${r.id}">${r.id}</option>`).join("");
}

async function onCreateUser(e) {
  e.preventDefault();
  const btn = document.getElementById("create-user-btn");
  const errorEl = document.getElementById("new-user-error");
  errorEl.textContent = "";
  btn.disabled = true;
  btn.textContent = "Creazione…";

  const nome = document.getElementById("new-user-nome").value.trim();
  const email = document.getElementById("new-user-email").value.trim();
  const password = document.getElementById("new-user-password").value;
  const ruoloId = document.getElementById("new-user-ruolo").value;
  const soggettoQuotaCampo = document.getElementById("new-user-quotacampo").checked;

  try {
    const secondaryAuth = getSecondaryAuth();
    const cred = await secondaryAuth.createUserWithEmailAndPassword(email, password);
    const uid = cred.user.uid;

    const role = rolesCache.find(r => r.id === ruoloId);

    await db.collection("users").doc(uid).set({
      nome,
      email,
      ruoloId,
      ruoloNome: ruoloId,
      attivo: true,
      soggettoQuotaCampo
    });

    await secondaryAuth.signOut();

    document.getElementById("new-user-form").reset();
    await loadUsers();
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Crea utente";
  }
}

// ---------- Ruoli ----------

async function loadRoles() {
  const list = document.getElementById("roles-list");
  list.innerHTML = `<div class="empty-state"><div class="display">Caricamento…</div></div>`;

  const snap = await db.collection("roles").get();
  const roles = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  if (roles.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="display">Nessun ruolo</div></div>`;
    return;
  }

  list.innerHTML = roles.map(r => `
    <div class="entry-card" data-role-id="${r.id}">
      <div class="entry-main">
        <div class="entry-tipo">${escapeHtml(r.id)}</div>
        <div class="entry-meta">${(r.permessi || []).map(p => escapeHtml(permessoLabel(p))).join(", ") || "nessun permesso"}</div>
      </div>
      <button class="btn btn-ghost edit-role-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${r.id}">Modifica</button>
    </div>
  `).join("");

  list.querySelectorAll(".edit-role-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const role = roles.find(r => r.id === btn.dataset.id);
      document.getElementById("new-role-id").value = role.id;
      setCheckedPermessi(role.permessi || []);
      document.getElementById("new-role-id").scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });
}

async function onCreateRole(e) {
  e.preventDefault();
  const btn = document.getElementById("create-role-btn");
  const errorEl = document.getElementById("new-role-error");
  errorEl.textContent = "";
  btn.disabled = true;
  btn.textContent = "Salvataggio…";

  const roleId = document.getElementById("new-role-id").value.trim();
  const permessi = getCheckedPermessi();

  try {
    if (!roleId) throw new Error("Inserisci un ID ruolo (es. reception).");
    await db.collection("roles").doc(roleId).set({ permessi });
    document.getElementById("new-role-form").reset();
    syncAdminExclusive();
    await loadRoles();
    await populateRoleSelect();
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Salva ruolo";
  }
}

// ---------- Init ----------

requireAuth(async (profile) => {
  currentProfile = profile;
  document.getElementById("user-chip").textContent = profile.nome + (profile.ruoloNome ? " · " + profile.ruoloNome : "");

  if (!hasPermission(profile, "users:gestisci")) {
    document.getElementById("access-denied").classList.remove("hidden");
    document.getElementById("admin-content").classList.add("hidden");
    return;
  }

  document.getElementById("new-user-form").addEventListener("submit", onCreateUser);
  document.getElementById("new-role-form").addEventListener("submit", onCreateRole);
  document.getElementById("perm-admin").addEventListener("change", syncAdminExclusive);

  await populateRoleSelect();
  await loadUsers();
  await loadRoles();
});

document.getElementById("logout-link").addEventListener("click", (e) => {
  e.preventDefault();
  logout();
});

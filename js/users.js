// ============================================================
// users.js — pannello admin: gestione utenti e ruoli
// Richiede firebase-config.js e auth.js già caricati.
// ============================================================

let currentProfile = null;
let rolesCache = []; // [{id, permessi:[...]}]
let usersCache = [];

const KNOWN_PERMISSIONS = [
  { id: "*", label: "Amministratore (tutti i permessi)" },
  { id: "diario:leggi_tutti", label: "Diario: leggere le voci di tutti" },
  { id: "diario:gestisci_tutti", label: "Diario: modificare/cancellare le voci di tutti" },
  { id: "diario:approva", label: "Diario: approvare le voci del team" },
  { id: "users:gestisci", label: "Gestire utenti" },
  { id: "ruoli:gestisci", label: "Gestire ruoli e permessi" },
  { id: "config:gestisci", label: "Gestire configurazione (tipi attività, tariffe, campi)" },
  { id: "vendite:gestisci", label: "Gestire vendite (Cassa: registrare e vedere il riepilogo)" },
  { id: "corsi:gestisci", label: "Corsi: creare e modificare" },
  { id: "corsi:approva", label: "Corsi: approvare" },
  { id: "iscrizioni:gestisci", label: "Iscrizioni corsi: leggere e confermare/annullare (dati sensibili)" },
  { id: "prenotazioni:gestisci", label: "Prenotazioni padel: eliminare prenotazioni altrui" },
  { id: "prenotazioni:proprie", label: "Prenotazioni padel: creare/eliminare solo le proprie e bloccare slot (es. maestri)" }
];

function permessoLabel(id) {
  return (KNOWN_PERMISSIONS.find(p => p.id === id) || {}).label || id;
}

function tariffeSummary(u) {
  const t = u.tariffeOrarie || {};
  return DISCIPLINE
    .filter(d => t[d.id])
    .map(d => `${d.label} CHF${t[d.id].toFixed(2)}/ora`)
    .join(", ");
}

function renderNewUserTariffeFields() {
  const container = document.getElementById("new-user-tariffe-container");
  container.innerHTML = DISCIPLINE.map(d => `
    <input type="number" class="new-user-tariffa-input" min="0" step="0.5" placeholder="${escapeHtml(d.label)}" data-disciplina="${d.id}">
  `).join("");
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

// Password iniziale leggibile (due parole a tema + numero) da comunicare
// direttamente al collaboratore — pensata per essere facile da leggere/
// dettare a voce o via WhatsApp, non per restare quella definitiva.
const PASSWORD_WORDS = ["corte", "rete", "match", "set", "volee", "servizio", "campo", "palla", "rovescio", "diritto", "smash", "slice"];
function generateReadablePassword() {
  const w1 = PASSWORD_WORDS[Math.floor(Math.random() * PASSWORD_WORDS.length)];
  let w2 = PASSWORD_WORDS[Math.floor(Math.random() * PASSWORD_WORDS.length)];
  while (w2 === w1) w2 = PASSWORD_WORDS[Math.floor(Math.random() * PASSWORD_WORDS.length)];
  const n = Math.floor(10 + Math.random() * 90);
  return `${w1}-${w2}-${n}`;
}

// Messaggio pronto da incollare (WhatsApp, email, di persona) con le
// credenziali del collaboratore appena creato.
function mostraCredenzialiCreate(nome, email, password) {
  const link = basePageUrl() + "index.html";
  const testo = `Ciao ${nome},\n\nEcco le tue credenziali di accesso a Sportcenter Manager Os (il gestionale del ${DATI_CENTRO.nome}):\n\nLink: ${link}\nEmail: ${email}\nPassword: ${password}\n\nAl primo accesso puoi cambiarla dalla pagina "Password" in alto.`;

  document.getElementById("new-user-credenziali-testo").textContent = testo;
  document.getElementById("new-user-fatto").classList.remove("hidden");

  const copiaBtn = document.getElementById("copia-credenziali-btn");
  copiaBtn.onclick = () => copyToClipboard(testo, copiaBtn);
}

// ---------- Utenti ----------

async function loadUsers() {
  const list = document.getElementById("users-list");
  list.innerHTML = `<div class="empty-state"><div class="display">Caricamento…</div></div>`;

  const snap = await db.collection("users").orderBy("nome").get();
  const users = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  usersCache = users;
  renderTeamEmailPicker();

  if (users.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="display">Nessun utente</div></div>`;
    return;
  }

  list.innerHTML = users.map(u => {
    const roleLabel = u.ruoloNome || u.ruoloId || "—";
    const tariffe = tariffeSummary(u);
    const attivo = u.attivo !== false;
    return `
      <div class="team-card" data-uid="${u.id}">
        <div class="team-card-header">
          <div>
            <div class="team-card-name">${escapeHtml(u.nome || u.id)}</div>
            <div class="team-card-meta">${escapeHtml(u.email || "")} · ${escapeHtml(roleLabel)}${u.soggettoQuotaCampo ? " · quota campo" : ""}${u.puoRichiederePagamento ? " · pagamento online" : ""}${tariffe ? " · " + escapeHtml(tariffe) : ""}</div>
          </div>
          <span class="badge" style="${attivo ? "border-color:#7f9e4a;color:#c1e08f;" : "border-color:var(--danger);color:var(--danger);"}">${attivo ? "Attivo" : "Disattivato"}</span>
        </div>

        <div class="team-card-section">
          <div class="team-card-section-label">Ruolo</div>
          <div class="team-card-row">
            <select class="user-ruolo-select" data-uid="${u.id}">
              ${rolesCache.map(r => `<option value="${r.id}" ${r.id === u.ruoloId ? "selected" : ""}>${escapeHtml(r.id)}</option>`).join("")}
            </select>
            <button class="btn btn-ghost save-ruolo-btn" data-uid="${u.id}">Salva</button>
          </div>
        </div>

        <div class="team-card-section">
          <div class="team-card-section-label">Tariffe orarie (CHF)</div>
          <div class="team-card-row">
            ${DISCIPLINE.map(d => `
              <input type="number" class="user-tariffa-input" min="0" step="0.5" placeholder="${d.label}" value="${(u.tariffeOrarie && u.tariffeOrarie[d.id]) || ""}" data-uid="${u.id}" data-disciplina="${d.id}">
            `).join("")}
            <button class="btn btn-ghost save-tariffa-btn" data-uid="${u.id}">Salva</button>
          </div>
        </div>

        <div class="team-card-actions">
          <button class="btn btn-ghost toggle-quotacampo-btn" data-uid="${u.id}" data-quotacampo="${!!u.soggettoQuotaCampo}">
            ${u.soggettoQuotaCampo ? "Rimuovi quota campo" : "Assegna quota campo"}
          </button>
          <button class="btn btn-ghost toggle-pagamento-btn" data-uid="${u.id}" data-pagamento="${!!u.puoRichiederePagamento}">
            ${u.puoRichiederePagamento ? "Rimuovi pagamento online" : "Assegna pagamento online"}
          </button>
          <button class="btn btn-ghost toggle-active-btn" data-uid="${u.id}" data-attivo="${attivo}">
            ${attivo ? "Disattiva" : "Riattiva"}
          </button>
          <button class="btn btn-ghost send-reset-btn" data-email="${escapeHtml(u.email || "")}" data-nome="${escapeHtml(u.nome || "")}">
            Prepara email reset password
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
  list.querySelectorAll(".toggle-pagamento-btn").forEach(btn => {
    btn.addEventListener("click", onTogglePagamentoOnline);
  });
  list.querySelectorAll(".save-tariffa-btn").forEach(btn => {
    btn.addEventListener("click", onSaveTariffa);
  });
  list.querySelectorAll(".save-ruolo-btn").forEach(btn => {
    btn.addEventListener("click", onSaveRuolo);
  });
  list.querySelectorAll(".send-reset-btn").forEach(btn => {
    btn.addEventListener("click", onSendPasswordReset);
  });
}

// ---------- Comunicazione al team (mailto con destinatari in CCN) ----------

function renderTeamEmailPicker() {
  const container = document.getElementById("team-email-list");
  if (!container) return;

  const conEmail = usersCache.filter(u => u.email);
  if (conEmail.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="display">Nessun utente con email</div></div>`;
    return;
  }

  container.innerHTML = conEmail.map(u => `
    <div class="checkbox-row">
      <input type="checkbox" class="team-email-cb" value="${escapeHtml(u.email)}" id="team-email-${u.id}" ${u.attivo !== false ? "checked" : ""}>
      <label for="team-email-${u.id}">${escapeHtml(u.nome || u.email)}${u.attivo === false ? " (disattivato)" : ""}</label>
    </div>
  `).join("");
}

// mailto standard: destinatari passati come parametro "bcc" invece che nella
// parte principale dell'indirizzo, così nessuno vede gli indirizzi altrui —
// niente da inviare/gestire lato server, si appoggia al programma email già
// configurato su chi clicca.
function onInviaEmailTeam() {
  const errorEl = document.getElementById("team-email-error");
  errorEl.textContent = "";

  const emails = Array.from(document.querySelectorAll(".team-email-cb:checked")).map(cb => cb.value);
  if (emails.length === 0) {
    showError(errorEl, "Seleziona almeno un destinatario.");
    return;
  }

  const oggetto = document.getElementById("team-email-oggetto").value.trim();
  const corpo = document.getElementById("team-email-corpo").value.trim();
  const calce = `${DATI_CENTRO.nome}\nSportcenter Manager OS\n${basePageUrl()}index.html`;
  const corpoConCalce = (corpo ? corpo + "\n\n" : "") + "--\n" + calce;

  const parti = [`bcc=${encodeURIComponent(emails.join(","))}`, `body=${encodeURIComponent(corpoConCalce)}`];
  if (oggetto) parti.push(`subject=${encodeURIComponent(oggetto)}`);

  window.location.href = `mailto:?${parti.join("&")}`;
}

// Genera SOLO il link (Cloud Function con Admin SDK, non spedisce nulla)
// e apre il client di posta di chi gestisce gli utenti con un testo di
// benvenuto già pronto — invio manuale, come le credenziali di un nuovo
// collaboratore. Bypassa l'invio automatico di Firebase
// (auth.sendPasswordResetEmail), spesso finito in spam o filtrato da
// alcuni provider, perché il mittente diventa una persona vera invece
// di un dominio Firebase condiviso.
async function onSendPasswordReset(e) {
  const btn = e.currentTarget;
  const email = btn.dataset.email;
  const nome = btn.dataset.nome || "";
  if (!email) {
    showError(document.getElementById("users-list-error"), "Questo utente non ha un'email registrata: impossibile preparare il reset.");
    return;
  }
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Preparazione…";
  try {
    const fn = firebase.functions().httpsCallable("generaLinkResetPassword");
    const result = await fn({ email });
    const link = result.data.link;

    const oggetto = `Benvenuto in Sport-OS — ${DATI_CENTRO.nome}`;
    const corpo = `Ciao ${nome || ""},\n\nBenvenuto/a nel gestionale Sport-OS del ${DATI_CENTRO.nome}!\n\nPer impostare la tua password, apri questo link:\n${link}\n\nUna volta impostata, accedi da qui:\n${basePageUrl()}index.html\n\nEmail: ${email}`;
    const calce = `${DATI_CENTRO.nome}\nSportcenter Manager OS\n${basePageUrl()}index.html`;

    window.location.href = `mailto:?to=${encodeURIComponent(email)}&subject=${encodeURIComponent(oggetto)}&body=${encodeURIComponent(corpo + "\n\n--\n" + calce)}`;

    btn.textContent = "Email pronta";
    setTimeout(() => {
      btn.textContent = originalText;
      btn.disabled = false;
    }, 3000);
  } catch (err) {
    showError(document.getElementById("users-list-error"), "Errore: " + err.message);
    btn.textContent = originalText;
    btn.disabled = false;
  }
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

async function onTogglePagamentoOnline(e) {
  const btn = e.currentTarget;
  const uid = btn.dataset.uid;
  const nuovoStato = btn.dataset.pagamento !== "true";
  btn.disabled = true;
  try {
    await db.collection("users").doc(uid).update({ puoRichiederePagamento: nuovoStato });
    await loadUsers();
  } catch (err) {
    showError(document.getElementById("users-list-error"), "Errore: " + err.message);
    btn.disabled = false;
  }
}

async function onSaveTariffa(e) {
  const btn = e.currentTarget;
  const uid = btn.dataset.uid;
  const inputs = document.querySelectorAll(`.user-tariffa-input[data-uid="${uid}"]`);
  const tariffeOrarie = {};
  inputs.forEach(input => {
    const val = parseFloat(input.value) || 0;
    if (val > 0) tariffeOrarie[input.dataset.disciplina] = val;
  });
  btn.disabled = true;
  try {
    await db.collection("users").doc(uid).update({ tariffeOrarie });
    await loadUsers();
  } catch (err) {
    showError(document.getElementById("users-list-error"), "Errore: " + err.message);
    btn.disabled = false;
  }
}

async function onSaveRuolo(e) {
  const btn = e.currentTarget;
  const uid = btn.dataset.uid;
  const ruoloId = document.querySelector(`.user-ruolo-select[data-uid="${uid}"]`).value;
  btn.disabled = true;
  try {
    await db.collection("users").doc(uid).update({ ruoloId, ruoloNome: ruoloId });
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
  const ruoloId = document.getElementById("new-user-ruolo").value;
  const password = document.getElementById("new-user-password").value;
  const soggettoQuotaCampo = document.getElementById("new-user-quotacampo").checked;

  const tariffeOrarie = {};
  document.querySelectorAll(".new-user-tariffa-input").forEach(input => {
    const val = parseFloat(input.value) || 0;
    if (val > 0) tariffeOrarie[input.dataset.disciplina] = val;
  });

  try {
    const secondaryAuth = getSecondaryAuth();
    const cred = await secondaryAuth.createUserWithEmailAndPassword(email, password);
    const uid = cred.user.uid;

    await db.collection("users").doc(uid).set({
      nome,
      email,
      ruoloId,
      ruoloNome: ruoloId,
      attivo: true,
      soggettoQuotaCampo,
      tariffeOrarie
    });

    await secondaryAuth.signOut();

    mostraCredenzialiCreate(nome, email, password);

    document.getElementById("new-user-form").reset();
    document.getElementById("new-user-password").value = generateReadablePassword();
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

  await loadDatiCentro();

  document.getElementById("new-user-form").addEventListener("submit", onCreateUser);
  document.getElementById("new-role-form").addEventListener("submit", onCreateRole);
  document.getElementById("perm-admin").addEventListener("change", syncAdminExclusive);
  document.getElementById("genera-password-btn").addEventListener("click", () => {
    document.getElementById("new-user-password").value = generateReadablePassword();
  });
  document.getElementById("new-user-password").value = generateReadablePassword();
  document.getElementById("team-email-tutti-btn").addEventListener("click", () => {
    document.querySelectorAll(".team-email-cb").forEach(cb => { cb.checked = true; });
  });
  document.getElementById("team-email-nessuno-btn").addEventListener("click", () => {
    document.querySelectorAll(".team-email-cb").forEach(cb => { cb.checked = false; });
  });
  document.getElementById("team-email-invia-btn").addEventListener("click", onInviaEmailTeam);

  await loadDiscipline();
  renderNewUserTariffeFields();

  await populateRoleSelect();
  await loadUsers();
  await loadRoles();
});

document.getElementById("logout-link").addEventListener("click", (e) => {
  e.preventDefault();
  logout();
});

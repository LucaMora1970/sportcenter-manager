// ============================================================
// giocatori-padel-admin.js — pannello staff (Istruttore Padel o chi
// gestisce corsi/iscrizioni): livello assegnato quando manca un livello
// Playtomic, e flag anti-abuso puoLanciareProposte. Mai telefono/email
// (giocatoriPadelContatti non è letto da questa pagina — l'istruttore
// vede solo nome e livello, il contatto passa solo dalla proposta di
// sessione). Tutte le modifiche passano dalle Cloud Function dedicate,
// mai una scrittura diretta su giocatoriPadel (collection allow write:
// if false).
// Richiede firebase-config.js, utils.js e auth.js già caricati.
// ============================================================

let currentProfile = null;
let giocatoriCache = [];

async function loadGiocatori() {
  const list = document.getElementById("giocatori-padel-list");
  list.innerHTML = `<div class="empty-state"><div class="display">Caricamento…</div></div>`;
  try {
    const snap = await db.collection("giocatoriPadel").orderBy("livelloEffettivo", "desc").get();
    giocatoriCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    showError(document.getElementById("giocatori-padel-error"), "Errore nel caricamento: " + err.message);
    list.innerHTML = "";
    return;
  }
  renderGiocatori();
}

function renderGiocatori() {
  const list = document.getElementById("giocatori-padel-list");
  if (giocatoriCache.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="display">Nessun giocatore registrato</div></div>`;
    return;
  }

  list.innerHTML = giocatoriCache.map(g => {
    const haPlaytomic = g.playtomicLivello != null;
    return `
    <div class="entry-card" data-id="${g.id}">
      <div class="entry-main">
        <span class="badge" style="${g.attivo ? "border-color:#7f9e4a;color:#c1e08f;" : "border-color:var(--chalk-grey-dim);color:var(--chalk-grey);"}">${g.attivo ? "Attivo" : "Disattivato"}</span>
        <span class="badge">${g.esterno ? "Esterno" : "Socio"}</span>
        <div class="entry-tipo">${escapeHtml(g.nome)} ${escapeHtml(g.cognome)}</div>
        <div class="entry-meta">Livello effettivo: ${g.livelloEffettivo != null ? g.livelloEffettivo : "—"}${haPlaytomic ? " · Playtomic: " + g.playtomicLivello : " · nessun livello Playtomic"}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        <input type="number" class="livello-istruttore-input" data-id="${g.id}" min="0" max="7" step="0.01"
          value="${g.livelloIstruttore != null ? g.livelloIstruttore : ""}" placeholder="Livello assegnato"
          style="width:170px;padding:8px;font-size:0.78rem;" ${haPlaytomic ? "disabled" : ""}
          title="${haPlaytomic ? "Ha già un livello Playtomic, prevale su questo" : ""}">
        <button type="button" class="btn btn-ghost salva-livello-btn" data-id="${g.id}" style="width:auto;padding:8px 12px;font-size:0.7rem;" ${haPlaytomic ? "disabled" : ""}>Salva livello</button>
        <label class="checkbox-row" style="margin:4px 0 0;">
          <input type="checkbox" class="puo-lanciare-cb" data-id="${g.id}" ${g.puoLanciareProposte !== false ? "checked" : ""}>
          <span>Può lanciare proposte</span>
        </label>
      </div>
    </div>
  `;
  }).join("");

  list.querySelectorAll(".salva-livello-btn").forEach(btn => {
    btn.addEventListener("click", () => salvaLivelloIstruttore(btn.dataset.id));
  });
  list.querySelectorAll(".puo-lanciare-cb").forEach(cb => {
    cb.addEventListener("change", () => salvaPuoLanciareProposte(cb.dataset.id, cb.checked));
  });
}

async function salvaLivelloIstruttore(giocatoreId) {
  const input = document.querySelector(`.livello-istruttore-input[data-id="${giocatoreId}"]`);
  const btn = document.querySelector(`.salva-livello-btn[data-id="${giocatoreId}"]`);
  btn.disabled = true;
  try {
    const fn = cloudFunctions().httpsCallable("modificaLivelloIstruttorePadel");
    await fn({ giocatoreId, livelloIstruttore: input.value !== "" ? parseFloat(input.value) : null });
    await loadGiocatori();
  } catch (err) {
    showError(document.getElementById("giocatori-padel-error"), "Errore: " + err.message);
    btn.disabled = false;
  }
}

async function salvaPuoLanciareProposte(giocatoreId, puoLanciareProposte) {
  try {
    const fn = cloudFunctions().httpsCallable("modificaPuoLanciareProposte");
    await fn({ giocatoreId, puoLanciareProposte });
  } catch (err) {
    showError(document.getElementById("giocatori-padel-error"), "Errore: " + err.message);
    await loadGiocatori();
  }
}

requireAuth(async (profile) => {
  currentProfile = profile;
  document.getElementById("user-chip").textContent = profile.nome + (profile.ruoloNome ? " · " + profile.ruoloNome : "");

  const autorizzato = hasPermission(profile, "corsi:gestisci_padel") || hasPermission(profile, "iscrizioni:gestisci_padel")
    || hasPermission(profile, "corsi:gestisci") || hasPermission(profile, "iscrizioni:gestisci");
  if (!autorizzato) {
    document.getElementById("access-denied").classList.remove("hidden");
    document.getElementById("giocatori-padel-content").classList.add("hidden");
    return;
  }

  document.getElementById("giocatori-padel-content").classList.remove("hidden");
  await loadGiocatori();
});

document.getElementById("logout-link").addEventListener("click", (e) => {
  e.preventDefault();
  logout();
});

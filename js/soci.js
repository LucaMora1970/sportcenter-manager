// ============================================================
// soci.js — pannello admin/segretaria: ricerca/modifica soci, e le
// richieste di iscrizione (pagina pubblica iscrizione-socio.html) da
// verificare o da confermare con pagamento avvenuto fuori dall'app.
//
// "soci" non è mai leggibile/scrivibile direttamente dal client (vedi
// firestore.rules) — ogni azione qui passa da una Cloud Function
// (listaSoci, aggiornaSocioAdmin, eliminaSocioAdmin,
// confermaIscrizioneSocioPagamentoEsterno), mai un db.collection("soci").
//
// Richiede firebase-config.js, utils.js e auth.js già caricati.
// ============================================================

let currentProfile = null;
let categorieSocioCache = []; // [{id, nome, costoForfait, ordine}]
let percentualeFissaQuotaSocioCache = 50;
let ultimaRicercaSoci = [];
let editingSocioId = null;

function ordinaCategorie(items) {
  return items.slice().sort((a, b) => {
    const ao = a.ordine != null ? a.ordine : 99;
    const bo = b.ordine != null ? b.ordine : 99;
    return ao - bo || (a.nome || "").localeCompare(b.nome || "");
  });
}

// Stessa formula di quotaProporzionale() lato server (functions/index.js)
// e di quotaProporzionaleClient() in configurazione.js — solo
// un'anteprima, l'importo si può comunque correggere a mano.
function quotaProporzionaleClient(costoPieno, percentualeFissa) {
  const mesiRimanenti = 12 - new Date().getMonth();
  const fissa = percentualeFissa / 100;
  const variabile = (1 - fissa) * (mesiRimanenti / 12);
  return Math.round(costoPieno * (fissa + variabile) * 100) / 100;
}

async function caricaCategorieSocio() {
  const snap = await db.collection("categorieSocio").where("attivo", "==", true).get();
  categorieSocioCache = ordinaCategorie(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  const select = document.getElementById("socio-categoria");
  select.innerHTML = categorieSocioCache.map(c => `<option value="${c.id}">${escapeHtml(c.nome)}</option>`).join("")
    + `<option value="azienda">Azienda</option>`;

  const impostazioniSnap = await db.collection("impostazioni").doc("generale").get();
  const g = impostazioniSnap.exists ? impostazioniSnap.data() : {};
  percentualeFissaQuotaSocioCache = g.quotaSocioPercentualeFissa != null ? g.quotaSocioPercentualeFissa : 50;
}

// ---------- Ricerca soci ----------

async function cercaSoci() {
  const testo = document.getElementById("soci-search-input").value.trim();
  const includiInattivi = document.getElementById("soci-mostra-inattivi").checked;
  const listEl = document.getElementById("soci-search-list");
  const errorEl = document.getElementById("soci-search-error");
  errorEl.textContent = "";

  if (testo.length < 2) {
    listEl.innerHTML = `<div class="empty-state"><div class="display">Cerca un nome per iniziare</div></div>`;
    ultimaRicercaSoci = [];
    return;
  }

  listEl.innerHTML = `<div class="empty-state"><div class="display">Ricerca…</div></div>`;
  try {
    const fn = cloudFunctions().httpsCallable("listaSoci");
    const { data } = await fn({ testo, includiInattivi });
    ultimaRicercaSoci = data.risultati;
    if (ultimaRicercaSoci.length === 0) {
      listEl.innerHTML = `<div class="empty-state"><div class="display">Nessun socio trovato</div></div>`;
      return;
    }
    listEl.innerHTML = ultimaRicercaSoci.map(s => {
      const categoria = categorieSocioCache.find(c => c.id === s.categoria);
      const badge = !s.attivo
        ? `<span class="soci-badge inattivo">Disattivato</span>`
        : s.attivato ? `<span class="soci-badge attivato">Attivato</span>` : `<span class="soci-badge">Non ancora attivato</span>`;
      return `
        <div class="entry-card" data-id="${s.id}">
          <div class="entry-main">
            <div class="entry-tipo">${escapeHtml(s.nome)} ${escapeHtml(s.cognome)}${badge}</div>
            <div class="entry-meta">${escapeHtml(categoria ? categoria.nome : s.categoria)}${s.tessera ? " · " + escapeHtml(s.tessera) : ""} · ${escapeHtml(s.email)}</div>
          </div>
          <button type="button" class="btn btn-ghost modifica-socio-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${s.id}">Modifica</button>
          ${isAdmin(currentProfile) && s.attivo ? `<button type="button" class="btn btn-ghost prova-come-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${s.id}" data-nome="${escapeHtml(s.nome + " " + s.cognome)}">Prova come questo socio</button>` : ""}
        </div>
      `;
    }).join("");
    listEl.querySelectorAll(".modifica-socio-btn").forEach(btn => {
      btn.addEventListener("click", () => startEditSocio(ultimaRicercaSoci.find(s => s.id === btn.dataset.id)));
    });
    listEl.querySelectorAll(".prova-come-btn").forEach(btn => {
      btn.addEventListener("click", () => onProvaComeUtente(btn, "socio", btn.dataset.id, btn.dataset.nome));
    });
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
    listEl.innerHTML = "";
  }
}

// ---------- Modifica socio ----------

function startEditSocio(socio) {
  if (!socio) return;
  editingSocioId = socio.id;

  document.getElementById("socio-nome").value = socio.nome || "";
  document.getElementById("socio-cognome").value = socio.cognome || "";
  document.getElementById("socio-email").value = socio.email || "";
  document.getElementById("socio-telefono").value = socio.telefono || "";
  document.getElementById("socio-datanascita").value = socio.dataNascita || "";
  document.getElementById("socio-via").value = socio.via || "";
  document.getElementById("socio-cap").value = socio.cap || "";
  document.getElementById("socio-localita").value = socio.localita || "";
  document.getElementById("socio-categoria").value = socio.categoria || "";
  document.getElementById("socio-tessera").value = socio.tessera || "";
  document.getElementById("socio-scadenza").value = socio.scadenza && socio.scadenza._seconds
    ? new Date(socio.scadenza._seconds * 1000).toISOString().slice(0, 10) : "";
  document.getElementById("socio-pseudonimo").value = socio.pseudonimo || "";
  document.getElementById("socio-attivo").checked = socio.attivo !== false;

  document.getElementById("socio-form-title").querySelector("h2").textContent = `Modifica ${socio.nome} ${socio.cognome}`;
  document.getElementById("socio-form-wrap").classList.remove("hidden");
  document.getElementById("socio-form-wrap").scrollIntoView({ behavior: "smooth", block: "start" });
}

function cancelEditSocio() {
  editingSocioId = null;
  document.getElementById("socio-form").reset();
  document.getElementById("socio-form-title").querySelector("h2").textContent = "Modifica socio";
  document.getElementById("socio-form-wrap").classList.add("hidden");
}

async function onSubmitSocio(e) {
  e.preventDefault();
  if (!editingSocioId) return;
  const btn = document.getElementById("socio-save-btn");
  const errorEl = document.getElementById("socio-form-error");
  errorEl.textContent = "";
  btn.disabled = true;

  const payload = {
    socioId: editingSocioId,
    nome: document.getElementById("socio-nome").value.trim(),
    cognome: document.getElementById("socio-cognome").value.trim(),
    email: document.getElementById("socio-email").value.trim(),
    telefono: document.getElementById("socio-telefono").value.trim() || null,
    dataNascita: document.getElementById("socio-datanascita").value,
    via: document.getElementById("socio-via").value.trim() || null,
    cap: document.getElementById("socio-cap").value.trim() || null,
    localita: document.getElementById("socio-localita").value.trim() || null,
    categoria: document.getElementById("socio-categoria").value,
    tessera: document.getElementById("socio-tessera").value.trim() || null,
    scadenza: document.getElementById("socio-scadenza").value || null,
    attivo: document.getElementById("socio-attivo").checked,
    pseudonimo: document.getElementById("socio-pseudonimo").value.trim() || null
  };

  try {
    const fn = cloudFunctions().httpsCallable("aggiornaSocioAdmin");
    await fn(payload);
    cancelEditSocio();
    await cercaSoci();
  } catch (err) {
    showError(errorEl, "Errore nel salvataggio: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

async function onDeleteSocio() {
  if (!editingSocioId) return;
  if (!confirm("Eliminare definitivamente questo socio? L'operazione non è reversibile.")) return;
  const btn = document.getElementById("socio-delete-btn");
  btn.disabled = true;
  try {
    const fn = cloudFunctions().httpsCallable("eliminaSocioAdmin");
    await fn({ socioId: editingSocioId });
    cancelEditSocio();
    await cercaSoci();
  } catch (err) {
    showError(document.getElementById("socio-form-error"), "Errore: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------- Richieste di iscrizione (verifica e/o conferma pagamento) ----------
//
// Due stati mostrati qui: IN_ATTESA_APPROVAZIONE (Famiglia/Studenti, o
// categorie senza quota — va scelta/confermata la categoria) e
// IN_ATTESA_PAGAMENTO (categoria già chiara, in attesa che il pagamento
// arrivi) — per entrambi lo staff può anche confermare direttamente un
// pagamento avvenuto fuori dall'app invece di aspettare/inviare il link
// PostFinance.
async function loadRichiesteIscrizione() {
  const listEl = document.getElementById("richieste-iscrizione-list");
  if (!listEl) return;
  try {
    const snap = await db.collection("richiesteIscrizioneSocio")
      .where("stato", "in", ["IN_ATTESA_APPROVAZIONE", "IN_ATTESA_PAGAMENTO"]).get();
    const richieste = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0) - (b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0));
    if (richieste.length === 0) {
      listEl.innerHTML = "";
      return;
    }
    const opzioniCategorie = categorieSocioCache.map(c => `<option value="${c.id}">${escapeHtml(c.nome)}</option>`).join("");
    listEl.innerHTML = `<div class="section-title" style="margin-top:18px;"><h3 style="font-size:0.9rem;">Richieste di iscrizione</h3></div>`
      + richieste.map(r => {
        const data = r.createdAt && typeof r.createdAt.toDate === "function" ? r.createdAt.toDate().toLocaleDateString("it-CH") : "—";
        const daVerificare = r.stato === "IN_ATTESA_APPROVAZIONE";
        const categoriaSuggerita = categorieSocioCache.find(c => c.id === r.categoriaRichiesta);
        const importoSuggerito = categoriaSuggerita && categoriaSuggerita.costoForfait != null
          ? quotaProporzionaleClient(categoriaSuggerita.costoForfait, percentualeFissaQuotaSocioCache) : "";
        const provenienza = r.inseritaDaStaff ? ` · inserita da ${escapeHtml(r.inseritaDaNome || "staff")}` : "";
        return `
          <div class="entry-card" data-id="${r.id}" data-stato="${r.stato}" style="flex-direction:column;align-items:stretch;">
            <div class="entry-main">
              <div class="entry-tipo">${escapeHtml(r.nome)} ${escapeHtml(r.cognome)} · ${r.eta} anni</div>
              <div class="entry-meta">${escapeHtml(r.email)}${r.telefono ? " · " + escapeHtml(r.telefono) : ""} — richiesta il ${data}${provenienza}</div>
              <div class="entry-meta" style="${daVerificare ? "color:var(--danger);" : ""}">${daVerificare ? "Categoria da verificare" : "In attesa del pagamento online"}: ${escapeHtml(categoriaSuggerita ? categoriaSuggerita.nome : r.categoriaRichiesta)}</div>
            </div>
            ${daVerificare ? `
              <div class="row2" style="margin-top:10px;">
                <div class="field" style="margin-bottom:0;">
                  <label>Categoria da confermare</label>
                  <select class="ri-categoria">${opzioniCategorie}</select>
                </div>
                <div class="field" style="margin-bottom:0;flex:0 0 140px;">
                  <label>Importo da richiedere (CHF)</label>
                  <input type="number" class="ri-importo" min="0" step="0.5" value="${importoSuggerito}">
                </div>
              </div>
            ` : ""}
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;justify-content:flex-end;">
              ${daVerificare ? `<button type="button" class="btn btn-primary approva-iscrizione-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${r.id}">Approva e invia pagamento</button>` : ""}
              <button type="button" class="btn btn-ghost conferma-esterno-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${r.id}">Conferma pagamento esterno</button>
            </div>
          </div>
        `;
      }).join("");

    listEl.querySelectorAll(".entry-card").forEach(card => {
      const richiesta = richieste.find(r => r.id === card.dataset.id);
      if (!richiesta) return;
      const sel = card.querySelector(".ri-categoria");
      if (!sel) return;
      sel.value = richiesta.categoriaRichiesta;
      sel.addEventListener("change", () => {
        const cat = categorieSocioCache.find(c => c.id === sel.value);
        if (cat && cat.costoForfait != null) {
          card.querySelector(".ri-importo").value = quotaProporzionaleClient(cat.costoForfait, percentualeFissaQuotaSocioCache);
        }
      });
    });
    listEl.querySelectorAll(".approva-iscrizione-btn").forEach(btn => btn.addEventListener("click", onApprovaIscrizione));
    listEl.querySelectorAll(".conferma-esterno-btn").forEach(btn => btn.addEventListener("click", onConfermaPagamentoEsterno));
  } catch (err) {
    console.error("loadRichiesteIscrizione:", err.message);
  }
}

async function onApprovaIscrizione(e) {
  const btn = e.currentTarget;
  const card = btn.closest(".entry-card");
  const requestId = btn.dataset.id;
  const categoria = card.querySelector(".ri-categoria").value;
  const importoRaw = card.querySelector(".ri-importo").value;
  const importo = importoRaw !== "" ? parseFloat(importoRaw) : 0;
  if (!confirm("Confermare questa categoria e inviare il link di pagamento al richiedente? Il socio nascerà solo dopo che avrà pagato.")) return;
  btn.disabled = true;
  btn.textContent = "Invio in corso…";
  try {
    const fn = cloudFunctions().httpsCallable("approvaIscrizioneSocio");
    await fn({ requestId, categoria, importo });
    await loadRichiesteIscrizione();
  } catch (err) {
    alert("Errore: " + err.message);
    btn.disabled = false;
    btn.textContent = "Approva e invia pagamento";
  }
}

async function onConfermaPagamentoEsterno(e) {
  const btn = e.currentTarget;
  const card = btn.closest(".entry-card");
  const requestId = btn.dataset.id;
  const daVerificare = card.dataset.stato === "IN_ATTESA_APPROVAZIONE";
  const payload = { requestId };
  if (daVerificare) {
    payload.categoria = card.querySelector(".ri-categoria").value;
    const importoRaw = card.querySelector(".ri-importo").value;
    payload.importo = importoRaw !== "" ? parseFloat(importoRaw) : 0;
  }
  if (!confirm("Confermare che il pagamento è già avvenuto fuori dall'app (contanti/bonifico)? Il socio verrà creato subito, senza passare da PostFinance.")) return;
  btn.disabled = true;
  btn.textContent = "Conferma in corso…";
  try {
    const fn = cloudFunctions().httpsCallable("confermaIscrizioneSocioPagamentoEsterno");
    await fn(payload);
    await loadRichiesteIscrizione();
  } catch (err) {
    alert("Errore: " + err.message);
    btn.disabled = false;
    btn.textContent = "Conferma pagamento esterno";
  }
}

// ---------- Init ----------

requireAuth(async (profile) => {
  currentProfile = profile;
  document.getElementById("user-chip").textContent = profile.nome + (profile.ruoloNome ? " · " + profile.ruoloNome : "");

  if (!hasPermission(profile, "soci:gestisci")) {
    document.getElementById("access-denied").classList.remove("hidden");
    document.getElementById("admin-content").classList.add("hidden");
    return;
  }

  await loadDatiCentro();
  await caricaCategorieSocio();

  document.getElementById("registra-socio-btn").addEventListener("click", () => {
    window.open(basePageUrl() + "iscrizione-socio.html", "_blank");
  });

  let ricercaTimeout = null;
  document.getElementById("soci-search-input").addEventListener("input", () => {
    clearTimeout(ricercaTimeout);
    ricercaTimeout = setTimeout(cercaSoci, 400);
  });
  document.getElementById("soci-mostra-inattivi").addEventListener("change", cercaSoci);

  document.getElementById("socio-form").addEventListener("submit", onSubmitSocio);
  document.getElementById("socio-cancel-edit-btn").addEventListener("click", cancelEditSocio);
  document.getElementById("socio-delete-btn").addEventListener("click", onDeleteSocio);

  await loadRichiesteIscrizione();
});

document.getElementById("logout-link").addEventListener("click", (e) => {
  e.preventDefault();
  logout();
});

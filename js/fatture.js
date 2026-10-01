// ============================================================
// fatture.js — emissione di fatture con polizza di versamento QR
// svizzera (QR-bill), invio per email e stato dei pagamenti.
//
// Il lavoro vero (numerazione continua, riferimento SCOR/QRR, PDF, email)
// sta nelle Cloud Functions emettiFattura / pdfFattura / inviaFatturaEmail /
// aggiornaStatoFattura (functions/index.js): qui c'è solo l'interfaccia.
// Le fatture si leggono da Firestore (collection "fatture") ma non si
// scrivono mai da browser: vedi firestore.rules.
//
// Tipo di riferimento: con un IBAN normale si usa SCOR; con un QR-IBAN
// (IID 30000-31999) serve QRR. Il client avvisa l'incoerenza già nel form
// dei dati, il server la rifiuta comunque all'emissione.
//
// Richiede firebase-config.js, utils.js e auth.js già caricati.
// ============================================================

let currentProfile = null;
let fattureCache = [];
let filtroStato = "tutte";
let ricercaQuery = "";
let configCorrente = null;

const STATI_LABEL = { emessa: "Emessa", inviata: "Inviata", pagata: "Pagata", annullata: "Annullata" };

function oggiISO() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function formatDataBreve(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

function chf(n) {
  return Number(n || 0).toFixed(2);
}

function erroreFunzione(err) {
  return (err && err.message) ? err.message : "Operazione non riuscita.";
}

// ---------- IBAN (controlli di cortesia lato client) ----------

function normalizzaIban(s) {
  return String(s || "").replace(/\s+/g, "").toUpperCase();
}

function formattaIban(s) {
  return normalizzaIban(s).replace(/(.{4})/g, "$1 ").trim();
}

// Modulo 97 (ISO 13616): sposta le prime 4 posizioni in fondo, lettere → numeri.
function ibanValido(iban) {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  const r = iban.slice(4) + iban.slice(0, 4);
  const numerico = r.replace(/[A-Z]/g, c => String(c.charCodeAt(0) - 55));
  let resto = 0;
  for (let i = 0; i < numerico.length; i += 7) {
    resto = parseInt(String(resto) + numerico.slice(i, i + 7), 10) % 97;
  }
  return resto === 1;
}

// QR-IBAN: identificativo istituto (cifre 5-9) tra 30000 e 31999.
function eQrIban(iban) {
  if (!/^(CH|LI)\d{2}\d{5}/.test(iban)) return false;
  const iid = parseInt(iban.slice(4, 9), 10);
  return iid >= 30000 && iid <= 31999;
}

function aggiornaInfoIban() {
  const info = document.getElementById("cfg-iban-info");
  const iban = normalizzaIban(document.getElementById("cfg-iban").value);
  const tipoSel = document.getElementById("cfg-tipo-rif");
  if (!iban) { info.textContent = ""; info.style.color = ""; return; }
  if (!ibanValido(iban)) {
    info.textContent = "IBAN non valido (controlla le cifre).";
    info.style.color = "var(--danger)";
    return;
  }
  if (!/^(CH|LI)/.test(iban)) {
    info.textContent = "Il QR-bill richiede un IBAN svizzero o del Liechtenstein.";
    info.style.color = "var(--danger)";
    return;
  }
  const qr = eQrIban(iban);
  info.style.color = "";
  info.textContent = qr
    ? "QR-IBAN riconosciuto: usa il riferimento QRR."
    : "IBAN normale: usa il riferimento SCOR (o nessuno).";
  if (qr && tipoSel.value !== "QRR") tipoSel.value = "QRR";
  if (!qr && tipoSel.value === "QRR") tipoSel.value = "SCOR";
}

// ---------- Configurazione ----------

async function caricaConfig() {
  const snap = await db.collection("fattureConfig").doc("main").get();
  configCorrente = snap.exists ? snap.data() : null;
  const c = (configCorrente && configCorrente.creditore) || {};
  // Prima volta: proponi i dati già inseriti in "Dati del centro".
  const centro = DATI_CENTRO || {};
  document.getElementById("cfg-nome").value = c.nome || centro.nome || "";
  document.getElementById("cfg-via").value = c.via || centro.indirizzo || "";
  document.getElementById("cfg-civico").value = c.civico || "";
  document.getElementById("cfg-cap").value = c.cap || centro.cap || "";
  document.getElementById("cfg-localita").value = c.localita || centro.localita || "";
  document.getElementById("cfg-telefono").value = (configCorrente && configCorrente.telefono) || centro.telefono || "";
  document.getElementById("cfg-email").value = (configCorrente && configCorrente.email) || centro.email || "";
  document.getElementById("cfg-iban").value = configCorrente ? formattaIban(configCorrente.iban) : "";
  document.getElementById("cfg-tipo-rif").value = (configCorrente && configCorrente.tipoRiferimento) || "SCOR";
  document.getElementById("cfg-giorni").value = configCorrente && configCorrente.giorniScadenza != null ? configCorrente.giorniScadenza : 30;
  document.getElementById("cfg-nota-iva").value = configCorrente && configCorrente.notaIva != null ? configCorrente.notaIva : "Non soggetto a IVA.";
  document.getElementById("cfg-piede").value = (configCorrente && configCorrente.pieDiPagina) || "";
  aggiornaInfoIban();
  // Senza configurazione si parte da qui: apri la sezione.
  if (!configCorrente) document.getElementById("config-details").open = true;
}

async function salvaConfig(e) {
  e.preventDefault();
  const errEl = document.getElementById("cfg-error");
  errEl.innerHTML = "";
  const iban = normalizzaIban(document.getElementById("cfg-iban").value);
  const tipo = document.getElementById("cfg-tipo-rif").value;

  if (!ibanValido(iban)) return showError(errEl, "L'IBAN non è valido.");
  if (!/^(CH|LI)/.test(iban)) return showError(errEl, "Serve un IBAN svizzero o del Liechtenstein.");
  if (eQrIban(iban) && tipo !== "QRR") return showError(errEl, "Con un QR-IBAN il riferimento deve essere QRR.");
  if (!eQrIban(iban) && tipo === "QRR") return showError(errEl, "Il riferimento QRR richiede un QR-IBAN: con questo IBAN scegli SCOR o nessun riferimento.");

  const val = id => document.getElementById(id).value.trim();
  const dati = {
    creditore: {
      nome: val("cfg-nome"), via: val("cfg-via"), civico: val("cfg-civico"),
      cap: val("cfg-cap"), localita: val("cfg-localita"), paese: "CH"
    },
    telefono: val("cfg-telefono"),
    email: val("cfg-email"),
    iban,
    tipoRiferimento: tipo,
    giorniScadenza: Math.max(0, parseInt(val("cfg-giorni"), 10) || 0),
    notaIva: val("cfg-nota-iva"),
    pieDiPagina: val("cfg-piede"),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedBy: currentProfile.uid
  };
  try {
    await db.collection("fattureConfig").doc("main").set(dati);
    configCorrente = dati;
    document.getElementById("cfg-iban").value = formattaIban(iban);
    errEl.innerHTML = "";
    alert("Dati salvati.");
  } catch (err) {
    showError(errEl, erroreFunzione(err));
  }
}

// ---------- Righe della nuova fattura ----------

let righeForm = [{ descrizione: "", quantita: 1, prezzoUnitario: "" }];

function totaleForm() {
  return righeForm.reduce((s, r) => {
    const q = parseFloat(r.quantita), p = parseFloat(r.prezzoUnitario);
    return s + (isFinite(q) && isFinite(p) ? Math.round(q * p * 100) / 100 : 0);
  }, 0);
}

function aggiornaTotaleForm() {
  document.getElementById("nuova-totale").textContent = "CHF " + chf(totaleForm());
}

function renderRighe() {
  const cont = document.getElementById("righe-container");
  cont.innerHTML = righeForm.map((r, i) => `
    <div class="row-card" data-i="${i}">
      <div class="field">
        <label>Descrizione</label>
        <input type="text" class="riga-descr" maxlength="200" value="${escapeHtml(r.descrizione)}" placeholder="es. Lezione privata, quota corso…">
      </div>
      <div class="row2">
        <div class="field">
          <label>Quantità</label>
          <input type="number" class="riga-qta" min="0" step="any" value="${escapeHtml(String(r.quantita))}">
        </div>
        <div class="field">
          <label>Prezzo (CHF)</label>
          <input type="number" class="riga-prezzo" step="0.01" value="${escapeHtml(String(r.prezzoUnitario))}">
        </div>
      </div>
      ${righeForm.length > 1 ? `<button type="button" class="btn btn-ghost riga-rimuovi" data-i="${i}">Rimuovi riga</button>` : ""}
    </div>
  `).join("");

  cont.querySelectorAll(".row-card").forEach(card => {
    const i = parseInt(card.dataset.i, 10);
    card.querySelector(".riga-descr").addEventListener("input", e => { righeForm[i].descrizione = e.target.value; });
    card.querySelector(".riga-qta").addEventListener("input", e => { righeForm[i].quantita = e.target.value; aggiornaTotaleForm(); });
    card.querySelector(".riga-prezzo").addEventListener("input", e => { righeForm[i].prezzoUnitario = e.target.value; aggiornaTotaleForm(); });
  });
  cont.querySelectorAll(".riga-rimuovi").forEach(btn => {
    btn.addEventListener("click", () => {
      righeForm.splice(parseInt(btn.dataset.i, 10), 1);
      renderRighe();
    });
  });
  aggiornaTotaleForm();
}

// Dati pre-compilati da altre pagine (es. Fatturazione corsi) tramite
// sessionStorage: letti una volta sola e poi cancellati.
let origineForm = null;
function applicaPrecompilazione() {
  let pre = null;
  try {
    const raw = sessionStorage.getItem("fatturaPrefill");
    if (raw) { pre = JSON.parse(raw); sessionStorage.removeItem("fatturaPrefill"); }
  } catch { /* storage non disponibile: si parte da form vuoto */ }
  if (!pre) return;
  const d = pre.destinatario || {};
  const set = (id, v) => { document.getElementById(id).value = v || ""; };
  set("dest-nome", d.nome); set("dest-via", d.via); set("dest-civico", d.civico);
  set("dest-cap", d.cap); set("dest-localita", d.localita); set("dest-email", d.email);
  set("fat-oggetto", pre.oggetto); set("fat-note", pre.note);
  if (Array.isArray(pre.righe) && pre.righe.length) {
    righeForm = pre.righe.map(r => ({
      descrizione: r.descrizione || "", quantita: r.quantita != null ? r.quantita : 1, prezzoUnitario: r.prezzoUnitario != null ? r.prezzoUnitario : ""
    }));
    renderRighe();
  }
  origineForm = pre.origine || null;
  apriModalNuova();
}

function apriModalNuova() {
  document.getElementById("nuova-error").innerHTML = "";
  document.getElementById("nuova-modal").classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function chiudiModalNuova() {
  document.getElementById("nuova-modal").classList.add("hidden");
  document.body.style.overflow = "";
}

function scaricaBase64(nomeFile, base64) {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = nomeFile;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function scaricaPdf(id) {
  mostraCaricamento("Preparo il PDF…");
  try {
    const res = await cloudFunctions().httpsCallable("pdfFattura")({ id });
    scaricaBase64(res.data.nomeFile, res.data.base64);
  } catch (err) {
    showError(document.getElementById("fatt-error"), erroreFunzione(err));
  } finally {
    nascondiCaricamento();
  }
}

async function emettiFattura(e) {
  e.preventDefault();
  const errEl = document.getElementById("nuova-error");
  errEl.innerHTML = "";
  if (!configCorrente) {
    chiudiModalNuova();
    document.getElementById("config-details").open = true;
    return showError(document.getElementById("fatt-error"), "Prima compila e salva i «Dati per la fattura» (creditore e IBAN).");
  }
  const val = id => document.getElementById(id).value.trim();
  const righe = righeForm.map(r => ({
    descrizione: String(r.descrizione).trim(),
    quantita: parseFloat(r.quantita),
    prezzoUnitario: parseFloat(r.prezzoUnitario)
  }));
  if (righe.some(r => !r.descrizione || !(r.quantita > 0) || !isFinite(r.prezzoUnitario))) {
    return showError(errEl, "Controlla le righe: servono descrizione, quantità maggiore di zero e prezzo.");
  }
  if (!(totaleForm() > 0)) return showError(errEl, "Il totale deve essere maggiore di zero.");

  const btn = document.getElementById("emetti-btn");
  btn.disabled = true;
  mostraCaricamento("Emetto la fattura…");
  try {
    const res = await cloudFunctions().httpsCallable("emettiFattura")({
      destinatario: {
        nome: val("dest-nome"), via: val("dest-via"), civico: val("dest-civico"),
        cap: val("dest-cap"), localita: val("dest-localita"), email: val("dest-email")
      },
      oggetto: val("fat-oggetto"),
      note: val("fat-note"),
      righe,
      origine: origineForm
    });
    const pdf = await cloudFunctions().httpsCallable("pdfFattura")({ id: res.data.id });
    scaricaBase64(pdf.data.nomeFile, pdf.data.base64);
    document.getElementById("nuova-form").reset();
    righeForm = [{ descrizione: "", quantita: 1, prezzoUnitario: "" }];
    origineForm = null;
    renderRighe();
    chiudiModalNuova();
    await caricaFatture();
  } catch (err) {
    showError(errEl, erroreFunzione(err));
  } finally {
    btn.disabled = false;
    nascondiCaricamento();
  }
}

// ---------- Elenco ----------

async function caricaFatture() {
  const snap = await db.collection("fatture").orderBy("createdAt", "desc").limit(300).get();
  fattureCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  aggiornaRiepilogo();
  renderFiltri();
  renderElenco();
}

function inRitardo(f) {
  return (f.stato === "emessa" || f.stato === "inviata") && f.dataScadenza < oggiISO();
}

function aggiornaRiepilogo() {
  const anno = String(new Date().getFullYear());
  let aperte = 0, scadute = 0, incassato = 0;
  fattureCache.forEach(f => {
    if (f.stato === "emessa" || f.stato === "inviata") {
      aperte += f.totale;
      if (inRitardo(f)) scadute++;
    } else if (f.stato === "pagata" && (f.dataPagamento || "").startsWith(anno)) {
      incassato += f.totale;
    }
  });
  document.getElementById("riep-aperte").innerHTML = `<small>CHF</small>${chf(aperte)}`;
  document.getElementById("riep-scadute").textContent = scadute;
  document.getElementById("riep-incassato").innerHTML = `<small>CHF</small>${chf(incassato)}`;
}

function renderFiltri() {
  const filtri = [
    { id: "tutte", label: "Tutte" },
    { id: "aperte", label: "Da incassare" },
    { id: "pagata", label: "Pagate" },
    { id: "annullata", label: "Annullate" }
  ];
  const el = document.getElementById("filtro-stato-pills");
  el.innerHTML = filtri.map(f =>
    `<button type="button" data-filtro="${f.id}" aria-pressed="${f.id === filtroStato}">${f.label}</button>`).join("");
  el.querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
    filtroStato = b.dataset.filtro;
    renderFiltri();
    renderElenco();
  }));
}

function fatturaCardHtml(f) {
  const ritardo = inRitardo(f);
  const badgeClasse = f.stato === "pagata" ? "badge-confermata" : f.stato === "annullata" ? "badge-annullata" : "badge-in-attesa";
  const chiusa = f.stato === "pagata" || f.stato === "annullata";
  return `
    <div class="dipendente-block" data-id="${f.id}">
      <div class="entry-card">
        <div class="entry-main">
          <div class="entry-tipo">${escapeHtml(f.numero)} · ${escapeHtml(f.destinatario.nome)}</div>
          <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">
            <span class="badge ${badgeClasse}">${STATI_LABEL[f.stato] || f.stato}</span>
            ${ritardo ? `<span class="badge" style="border-color:var(--danger);color:var(--danger);">Scaduta</span>` : ""}
          </div>
          <div class="entry-meta" style="margin-top:6px;">Emessa il ${formatDataBreve(f.dataEmissione)} · scadenza ${formatDataBreve(f.dataScadenza)}${f.dataPagamento ? ` · pagata il ${formatDataBreve(f.dataPagamento)}` : ""}</div>
          ${f.oggetto ? `<div class="entry-meta">${escapeHtml(f.oggetto)}</div>` : ""}
          ${f.inviataA ? `<div class="entry-meta">Inviata a ${escapeHtml(f.inviataA)}</div>` : ""}
        </div>
        <div class="entry-ore">CHF ${chf(f.totale)}</div>
      </div>
      <div class="dipendente-actions">
        <button type="button" class="btn btn-ghost" data-azione="pdf" data-id="${f.id}">PDF</button>
        ${f.stato !== "annullata" ? `<button type="button" class="btn btn-ghost" data-azione="email" data-id="${f.id}">Invia email</button>` : ""}
        ${!chiusa ? `<button type="button" class="btn btn-primary" data-azione="pagata" data-id="${f.id}">Segna pagata</button>` : ""}
        ${f.stato !== "annullata" ? `<button type="button" class="btn btn-danger" data-azione="annulla" data-id="${f.id}">Annulla</button>` : ""}
      </div>
    </div>`;
}

function renderElenco() {
  const listEl = document.getElementById("fatture-list");
  const q = ricercaQuery.trim().toLowerCase();
  const filtrate = fattureCache.filter(f => {
    if (filtroStato === "aperte" && !(f.stato === "emessa" || f.stato === "inviata")) return false;
    if (filtroStato === "pagata" && f.stato !== "pagata") return false;
    if (filtroStato === "annullata" && f.stato !== "annullata") return false;
    if (q && !`${f.numero} ${f.destinatario.nome}`.toLowerCase().includes(q)) return false;
    return true;
  });
  if (filtrate.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><div class="display">Nessuna fattura</div></div>`;
    return;
  }
  listEl.innerHTML = filtrate.map(fatturaCardHtml).join("");
  listEl.querySelectorAll("[data-azione]").forEach(btn => {
    btn.addEventListener("click", () => azioneFattura(btn.dataset.azione, btn.dataset.id));
  });
}

async function azioneFattura(azione, id) {
  const f = fattureCache.find(x => x.id === id);
  if (!f) return;
  const errEl = document.getElementById("fatt-error");
  errEl.innerHTML = "";
  try {
    if (azione === "pdf") {
      await scaricaPdf(id);
      return;
    }
    if (azione === "email") {
      const to = prompt(`Invia la fattura ${f.numero} a quale indirizzo email?`, f.inviataA || f.destinatario.email || "");
      if (!to) return;
      mostraCaricamento("Invio la fattura…");
      await cloudFunctions().httpsCallable("inviaFatturaEmail")({ id, to: to.trim() });
      nascondiCaricamento();
      alert("Fattura inviata a " + to.trim());
    } else if (azione === "pagata") {
      const data = prompt(`Data del pagamento (AAAA-MM-GG) per la fattura ${f.numero}:`, oggiISO());
      if (!data) return;
      await cloudFunctions().httpsCallable("aggiornaStatoFattura")({ id, stato: "pagata", dataPagamento: data.trim() });
    } else if (azione === "annulla") {
      if (!confirm(`Annullare la fattura ${f.numero}? Il numero resta assegnato e non si può riaprire.`)) return;
      await cloudFunctions().httpsCallable("aggiornaStatoFattura")({ id, stato: "annullata" });
    }
    await caricaFatture();
  } catch (err) {
    nascondiCaricamento();
    showError(errEl, erroreFunzione(err));
  }
}

// ---------- Init ----------

requireAuth(async (profile) => {
  currentProfile = profile;
  document.getElementById("user-chip").textContent = profile.nome + (profile.ruoloNome ? " · " + profile.ruoloNome : "");

  if (!hasPermission(profile, "fatture:gestisci")) {
    document.getElementById("access-denied").classList.remove("hidden");
    return;
  }

  try {
    await loadDatiCentro();
    await caricaConfig();
    await caricaFatture();
  } catch (err) {
    document.getElementById("access-denied").classList.remove("hidden");
    document.getElementById("access-denied").querySelector("p").textContent = erroreFunzione(err);
    return;
  }

  document.getElementById("content").classList.remove("hidden");
  renderRighe();
  applicaPrecompilazione();

  document.getElementById("cfg-form").addEventListener("submit", salvaConfig);
  document.getElementById("cfg-iban").addEventListener("input", aggiornaInfoIban);
  document.getElementById("nuova-form").addEventListener("submit", emettiFattura);
  document.getElementById("nuova-btn").addEventListener("click", apriModalNuova);
  document.getElementById("nuova-chiudi").addEventListener("click", chiudiModalNuova);
  document.getElementById("nuova-modal").addEventListener("click", (e) => {
    if (e.target.id === "nuova-modal") chiudiModalNuova();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") chiudiModalNuova(); });
  document.getElementById("aggiungi-riga-btn").addEventListener("click", () => {
    righeForm.push({ descrizione: "", quantita: 1, prezzoUnitario: "" });
    renderRighe();
  });
  document.getElementById("fat-search").addEventListener("input", (e) => {
    ricercaQuery = e.target.value;
    renderElenco();
  });
});

document.getElementById("logout-link").addEventListener("click", (e) => {
  e.preventDefault();
  logout();
});

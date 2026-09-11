// ============================================================
// allievi.js — anagrafica centrale degli allievi (collection Firestore
// "allieviCorsi", staff-only). Non confondere con la collection "allievi"
// usata dal Diario per tutt'altro scopo: qui si legge/scrive sempre e
// solo "allieviCorsi".
//
// A differenza di soci.js, qui non ci sono Cloud Function dedicate: le
// regole Firestore (gestite altrove, stesso contratto dati) permettono
// già allo staff con "allievi:gestisci" di leggere/scrivere direttamente
// la collection, quindi tutto qui passa da db.collection("allieviCorsi").
//
// Richiede firebase-config.js, utils.js e auth.js già caricati.
// ============================================================

let currentProfile = null;
let allieviCache = []; // [{id, nome, cognome, email, ...}] — caricata una volta, filtrata in locale
let allievoSelezionatoId = null;
let iscrizioniAllievoCache = [];
let comunicazioniAllievoCache = [];
let corsiAllievoCache = new Map();   // corsoId -> dati corso, solo per le iscrizioni in vista
let gruppiAllievoCache = new Map();  // gruppoId -> dati gruppo, idem

// Indice per i chip/filtri in elenco (caricato una volta sola, non solo
// per l'allievo aperto): allievoId -> iscrizioni non annullate di corsi in
// corso o futuri, e gruppoId -> dati gruppo per etichettarle.
let iscrizioniIndice = new Map();
let gruppiIndice = new Map();
let corsiListaCache = []; // [{id, nome}] per popolare il filtro "Corso"

function formatDataBreve(dataStr) {
  if (!dataStr) return "—";
  const [y, m, d] = dataStr.split("-");
  return `${d}.${m}.${y}`;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function etaDa(dataNascitaStr) {
  if (!dataNascitaStr) return null;
  const nascita = new Date(dataNascitaStr + "T00:00:00");
  const oggi = new Date();
  let eta = oggi.getFullYear() - nascita.getFullYear();
  const m = oggi.getMonth() - nascita.getMonth();
  if (m < 0 || (m === 0 && oggi.getDate() < nascita.getDate())) eta--;
  return eta;
}

// "mario DE rossi" -> "Mario De Rossi", "jean-pierre" -> "Jean-Pierre".
function capitalizzaNome(str) {
  return (str || "").trim().replace(/\s+/g, " ")
    .split(" ")
    .map(parola => parola.split("-")
      .map(seg => seg ? seg.charAt(0).toLocaleUpperCase("it") + seg.slice(1).toLocaleLowerCase("it") : seg)
      .join("-"))
    .join(" ");
}

// ---------- Caricamento/ricerca allievi ----------

async function caricaAllievi() {
  const listEl = document.getElementById("allievi-list");
  const errorEl = document.getElementById("allievi-search-error");
  errorEl.textContent = "";
  try {
    const snap = await db.collection("allieviCorsi").orderBy("cognome").get();
    allieviCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderAllieviList();
  } catch (err) {
    showError(errorEl, "Errore nel caricamento: " + err.message);
    listEl.innerHTML = "";
  }
}

// Indice corsi/gruppi per i chip e i filtri dell'elenco — caricato una
// volta sola insieme agli allievi (non per-allievo come
// caricaDettaglioAllievo, quello resta per lo storico completo di un
// singolo allievo aperto). Solo iscrizioni non annullate di corsi in
// corso o futuri: le stesse regole di scostamentoOreIscrizione, qui
// applicate a tutti così l'elenco non si affolla di storico vecchio.
async function caricaIndiceIscrizioni() {
  const [iscrSnap, gruppiSnap, corsiSnap] = await Promise.all([
    db.collection("iscrizioniCorsi").get(),
    db.collection("gruppiCorso").get(),
    db.collection("corsi").get()
  ]);

  const corsiMap = new Map(corsiSnap.docs.map(d => [d.id, { id: d.id, ...d.data() }]));
  corsiListaCache = [...corsiMap.values()].sort((a, b) => (a.nome || "").localeCompare(b.nome || "", "it", { sensitivity: "base" }));
  gruppiIndice = new Map(gruppiSnap.docs.map(d => [d.id, d.data()]));

  iscrizioniIndice = new Map();
  iscrSnap.docs.forEach(d => {
    const i = { id: d.id, ...d.data() };
    if (!i.allievoId || i.stato === "annullata") return;
    const corso = corsiMap.get(i.corsoId);
    if (corso && corso.al && corso.al < todayISO()) return;
    if (!iscrizioniIndice.has(i.allievoId)) iscrizioniIndice.set(i.allievoId, []);
    iscrizioniIndice.get(i.allievoId).push(i);
  });
}

function popolaFiltroCorso() {
  const sel = document.getElementById("allievi-filtro-corso");
  const valorePrecedente = sel.value;
  sel.innerHTML = `<option value="">Tutti</option>` + corsiListaCache.map(c => `<option value="${c.id}">${escapeHtml(c.nome || c.id)}</option>`).join("");
  sel.value = valorePrecedente;
}

function badgeIscrizioneHtml(i) {
  const gruppi = (i.gruppoIds || []).map(gid => gruppiIndice.get(gid)).filter(Boolean);
  const gruppiTxt = gruppi.length ? " · " + gruppi.map(g => g.nome).filter(Boolean).join(", ") : "";
  return `<span class="badge" style="${STATO_ISCRIZIONE_COLORE[i.stato] || ""}">${escapeHtml((i.corsoNome || "") + gruppiTxt)}</span>`;
}

// Ricerca client-side sulla cache già caricata (nessuna nuova lettura
// Firestore a ogni digitazione) — stesso principio di
// iscrizioniRicercabili()/renderRicercaAllievi() in corsi.js.
function renderAllieviList() {
  const testo = document.getElementById("allievi-search-input").value.trim().toLowerCase();
  const filtroCorso = document.getElementById("allievi-filtro-corso").value;
  const filtroStato = document.getElementById("allievi-filtro-stato").value;
  const listEl = document.getElementById("allievi-list");

  const risultati = allieviCache
    .filter(a => !testo
      || `${a.nome || ""} ${a.cognome || ""}`.toLowerCase().includes(testo)
      || (a.email || "").toLowerCase().includes(testo))
    .filter(a => {
      if (!filtroCorso && !filtroStato) return true;
      return (iscrizioniIndice.get(a.id) || []).some(i =>
        (!filtroCorso || i.corsoId === filtroCorso) && (!filtroStato || i.stato === filtroStato));
    })
    .sort((a, b) => (a.cognome || "").localeCompare(b.cognome || "", "it", { sensitivity: "base" })
      || (a.nome || "").localeCompare(b.nome || "", "it", { sensitivity: "base" }));

  const conteggioEl = document.getElementById("allievi-conteggio");
  conteggioEl.textContent = (testo || filtroCorso || filtroStato)
    ? `${risultati.length} di ${allieviCache.length} allievi in anagrafica`
    : `${allieviCache.length} allievi in anagrafica`;

  if (risultati.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><div class="display">Nessun allievo trovato</div></div>`;
    return;
  }

  listEl.innerHTML = risultati.map(a => {
    const eta = etaDa(a.dataNascita);
    const metaParts = [];
    if (eta != null) metaParts.push(eta + " anni");
    if (a.email) metaParts.push(a.email);
    const genitoreParts = [];
    if (a.nomeGenitore) genitoreParts.push(a.nomeGenitore);
    if (a.telefonoGenitore) genitoreParts.push(a.telefonoGenitore);
    const iscrChips = (iscrizioniIndice.get(a.id) || []).map(badgeIscrizioneHtml).join(" ");
    return `
      <div class="entry-card allievo-card" data-id="${a.id}" style="cursor:pointer;">
        <div class="entry-main">
          <div class="entry-tipo">${escapeHtml(a.cognome)} ${escapeHtml(a.nome)}</div>
          <div class="entry-meta">${escapeHtml(metaParts.join(" · "))}</div>
          ${genitoreParts.length ? `<div class="entry-meta">Genitore: ${escapeHtml(genitoreParts.join(" · "))}</div>` : ""}
          ${iscrChips ? `<div style="margin-top:6px;">${iscrChips}</div>` : ""}
        </div>
      </div>
    `;
  }).join("");

  listEl.querySelectorAll(".allievo-card").forEach(card => {
    card.addEventListener("click", () => selectAllievo(card.dataset.id));
  });
}

// ---------- Dettaglio/modifica ----------

function popolaFormAllievo(a) {
  document.getElementById("allievo-nome").value = a.nome || "";
  document.getElementById("allievo-cognome").value = a.cognome || "";
  document.getElementById("allievo-datanascita").value = a.dataNascita || "";
  document.getElementById("allievo-email").value = a.email || "";
  document.getElementById("allievo-nazionalita").value = a.nazionalita || "";
  document.getElementById("allievo-via").value = a.via || "";
  document.getElementById("allievo-cap").value = a.cap || "";
  document.getElementById("allievo-localita").value = a.localita || "";
  document.getElementById("allievo-nomegenitore").value = a.nomeGenitore || "";
  document.getElementById("allievo-telefonogenitore").value = a.telefonoGenitore || "";
  document.getElementById("allievo-scuola").value = a.scuolaFrequentata || "";
  document.getElementById("allievo-altrisport").value = a.altriSportPraticati || "";
  document.getElementById("allievo-note").value = a.note || "";
}

// Carica lo storico iscrizioni (iscrizioniCorsi.allievoId == id) e le
// comunicazioni (sottocollezione) in parallelo — nessuna dipendenza tra
// le due letture.
async function caricaDettaglioAllievo(id) {
  const iscrizioniListEl = document.getElementById("allievo-iscrizioni-list");
  const comunicazioniListEl = document.getElementById("allievo-comunicazioni-list");
  iscrizioniListEl.innerHTML = `<div class="empty-state"><div class="display">Caricamento…</div></div>`;
  comunicazioniListEl.innerHTML = `<div class="empty-state"><div class="display">Caricamento…</div></div>`;

  const [iscrizioniSnap, comunicazioniSnap] = await Promise.all([
    db.collection("iscrizioniCorsi").where("allievoId", "==", id).get(),
    db.collection("allieviCorsi").doc(id).collection("comunicazioni").orderBy("createdAt", "desc").get()
  ]);

  iscrizioniAllievoCache = iscrizioniSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0) - (a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0));
  comunicazioniAllievoCache = comunicazioniSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Corso (per durataSessioneMinuti/al) e gruppi assegnati (per nome/slot),
  // solo quelli citati dalle iscrizioni in vista — niente da caricare se
  // l'allievo non ha ancora gruppi assegnati.
  const corsoIds = [...new Set(iscrizioniAllievoCache.map(i => i.corsoId).filter(Boolean))];
  const gruppoIds = [...new Set(iscrizioniAllievoCache.flatMap(i => i.gruppoIds || []))];
  const [corsiDocs, gruppiDocs] = await Promise.all([
    Promise.all(corsoIds.map(cid => db.collection("corsi").doc(cid).get())),
    Promise.all(gruppoIds.map(gid => db.collection("gruppiCorso").doc(gid).get()))
  ]);
  corsiAllievoCache = new Map(corsiDocs.filter(d => d.exists).map(d => [d.id, d.data()]));
  gruppiAllievoCache = new Map(gruppiDocs.filter(d => d.exists).map(d => [d.id, d.data()]));

  renderIscrizioniAllievo();
  renderComunicazioniAllievo();
}

const STATO_ISCRIZIONE_LABEL = { in_attesa: "In attesa", confermata: "Confermata", annullata: "Annullata" };
const STATO_ISCRIZIONE_COLORE = {
  in_attesa: "border-color:#d4b83a;color:#d4b83a;",
  confermata: "border-color:#7f9e4a;color:#c1e08f;",
  annullata: "border-color:var(--chalk-grey-dim);color:var(--chalk-grey);"
};

function giornoLabel(id) {
  return (GIORNI_SETTIMANA.find(g => g.id === id) || {}).label || id;
}

function formatOre(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// Confronta le ore/settimana richieste dall'allievo (nrOreDesiderate) con
// quelle effettivamente coperte dai gruppi assegnati (durataSessioneMinuti
// del corso × numero di gruppi) — solo per corsi in corso o futuri
// (corso.al nel passato = iscrizione storica, nessuna segnalazione).
function scostamentoOreIscrizione(i) {
  if (!i.nrOreDesiderate || !(i.gruppoIds || []).length) return null;
  const corso = corsiAllievoCache.get(i.corsoId);
  if (!corso || !corso.durataSessioneMinuti) return null;
  if (corso.al && corso.al < todayISO()) return null;
  const oreAssegnate = (corso.durataSessioneMinuti / 60) * i.gruppoIds.length;
  if (oreAssegnate >= i.nrOreDesiderate) return null;
  return { richieste: i.nrOreDesiderate, assegnate: oreAssegnate, mancante: i.nrOreDesiderate - oreAssegnate };
}

// Dashboard per allievo: un badge di stato per iscrizione, un chip per
// ogni gruppo assegnato, ed eventuale conferma della convocazione inviata
// dal gruppo (vedi inviaConvocazioneGruppo in programmazione-corso.js).
function renderIscrizioniAllievo() {
  const listEl = document.getElementById("allievo-iscrizioni-list");
  if (iscrizioniAllievoCache.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><div class="display">Nessuna iscrizione</div></div>`;
    return;
  }
  listEl.innerHTML = iscrizioniAllievoCache.map(i => {
    const data = i.createdAt && typeof i.createdAt.toDate === "function" ? i.createdAt.toDate().toLocaleDateString("it-CH") : "—";
    const gruppi = (i.gruppoIds || []).map(gid => gruppiAllievoCache.get(gid)).filter(Boolean);
    const chipsGruppi = gruppi.map(g => {
      const slot = g.giorno ? `${giornoLabel(g.giorno)} ${g.orario || ""}${g.campo ? " · Campo " + escapeHtml(String(g.campo)) : ""}` : "";
      return `<span class="badge" title="${escapeHtml(slot)}">${escapeHtml(g.nome || slot || "Gruppo")}</span>`;
    }).join(" ");
    const convocazione = i.convocazioneInviataAt && typeof i.convocazioneInviataAt.toDate === "function"
      ? `Convocazione inviata il ${i.convocazioneInviataAt.toDate().toLocaleDateString("it-CH")}`
      : null;
    const disponibilita = Object.entries(i.disponibilita || {})
      .map(([g, orari]) => `${giornoLabel(g)} ${(orari || []).join("/")}`).join(" · ");
    const scostamento = scostamentoOreIscrizione(i);
    return `
      <div class="entry-card">
        <div class="entry-main">
          <span class="badge" style="${STATO_ISCRIZIONE_COLORE[i.stato] || ""}">${STATO_ISCRIZIONE_LABEL[i.stato] || i.stato || "—"}</span>
          ${chipsGruppi}
          <div class="entry-tipo">${escapeHtml(i.corsoNome || "—")}${i.tipo === "ospite" ? ` <span class="badge">Ospite</span>` : ""}</div>
          <div class="entry-meta">Iscritto il ${data}${i.nrOreDesiderate ? " · " + formatOre(i.nrOreDesiderate) + "h/sett. richieste" : ""}</div>
          ${disponibilita ? `<div class="entry-meta">Disponibilità indicata: ${escapeHtml(disponibilita)}</div>` : ""}
          ${convocazione ? `<div class="entry-meta">${convocazione}</div>` : ""}
          ${scostamento ? `<div class="entry-meta" style="color:var(--danger);">⚠ Richieste ${formatOre(scostamento.richieste)}h/sett., assegnate ${formatOre(scostamento.assegnate)}h/sett. — mancante ${formatOre(scostamento.mancante)}h/sett.</div>` : ""}
        </div>
      </div>
    `;
  }).join("");
}

const CANALE_LABEL = { telefono: "Telefono", email: "Email", di_persona: "Di persona", altro: "Altro" };

function renderComunicazioniAllievo() {
  const listEl = document.getElementById("allievo-comunicazioni-list");
  if (comunicazioniAllievoCache.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><div class="display">Nessuna comunicazione registrata</div></div>`;
    return;
  }
  listEl.innerHTML = comunicazioniAllievoCache.map(c => {
    const data = c.createdAt && typeof c.createdAt.toDate === "function" ? c.createdAt.toDate().toLocaleString("it-CH") : "—";
    const canale = c.canale ? CANALE_LABEL[c.canale] || c.canale : null;
    return `
      <div class="comunicazione-item">
        <div class="comunicazione-testo">${escapeHtml(c.testo || "")}</div>
        <div class="comunicazione-meta">${canale ? canale + " · " : ""}${escapeHtml(c.daNome || "—")} · ${data}</div>
      </div>
    `;
  }).join("");
}

async function selectAllievo(id) {
  try {
    const doc = await db.collection("allieviCorsi").doc(id).get();
    if (!doc.exists) {
      alert("Questo allievo non esiste più (potrebbe essere stato eliminato).");
      return;
    }
    allievoSelezionatoId = id;
    const allievo = { id: doc.id, ...doc.data() };
    popolaFormAllievo(allievo);

    document.getElementById("allievo-form-title").querySelector("h2").textContent = `Modifica ${allievo.nome} ${allievo.cognome}`;
    // Eliminazione riservata al vero admin — vedi firestore.rules, stessa
    // regola: chi ha solo allievi:gestisci non deve nemmeno vedere il
    // bottone, non solo essere bloccato al click.
    document.getElementById("allievo-delete-btn").classList.toggle("hidden", !isAdmin(currentProfile));
    document.getElementById("allievo-stampa-btn").classList.remove("hidden");
    document.getElementById("allievo-detail").classList.remove("hidden");
    document.getElementById("allievo-detail").scrollIntoView({ behavior: "smooth", block: "start" });

    // Riflette l'id nell'URL, così il link a questo allievo è condivisibile
    // (nessun'altra pagina lo usa ancora, ma un link diretto deve funzionare).
    const url = new URL(location.href);
    url.searchParams.set("id", id);
    history.replaceState(null, "", url);

    await caricaDettaglioAllievo(id);
  } catch (err) {
    alert("Errore nel caricamento dell'allievo: " + err.message);
  }
}

function nuovoAllievo() {
  allievoSelezionatoId = null;
  iscrizioniAllievoCache = [];
  comunicazioniAllievoCache = [];
  document.getElementById("allievo-form").reset();
  document.getElementById("allievo-form-error").textContent = "";
  document.getElementById("allievo-form-title").querySelector("h2").textContent = "Nuovo allievo";
  document.getElementById("allievo-delete-btn").classList.add("hidden");
  document.getElementById("allievo-stampa-btn").classList.add("hidden");
  document.getElementById("allievo-iscrizioni-list").innerHTML = `<div class="empty-state"><div class="display">Disponibile dopo il salvataggio</div></div>`;
  document.getElementById("allievo-comunicazioni-list").innerHTML = `<div class="empty-state"><div class="display">Disponibile dopo il salvataggio</div></div>`;
  document.getElementById("comunicazione-testo").value = "";
  document.getElementById("comunicazione-canale").value = "";

  document.getElementById("allievo-detail").classList.remove("hidden");
  document.getElementById("allievo-detail").scrollIntoView({ behavior: "smooth", block: "start" });

  const url = new URL(location.href);
  url.searchParams.delete("id");
  history.replaceState(null, "", url);
}

function chiudiDettaglioAllievo() {
  allievoSelezionatoId = null;
  document.getElementById("allievo-detail").classList.add("hidden");
  document.getElementById("allievo-form").reset();
  const url = new URL(location.href);
  url.searchParams.delete("id");
  history.replaceState(null, "", url);
}

async function onSubmitAllievo(e) {
  e.preventDefault();
  const btn = document.getElementById("allievo-save-btn");
  const errorEl = document.getElementById("allievo-form-error");
  errorEl.textContent = "";
  btn.disabled = true;

  const email = document.getElementById("allievo-email").value.trim();
  const payload = {
    nome: capitalizzaNome(document.getElementById("allievo-nome").value),
    cognome: capitalizzaNome(document.getElementById("allievo-cognome").value),
    dataNascita: document.getElementById("allievo-datanascita").value,
    email,
    emailLower: email.toLowerCase(),
    nazionalita: document.getElementById("allievo-nazionalita").value.trim() || null,
    via: document.getElementById("allievo-via").value.trim() || null,
    cap: document.getElementById("allievo-cap").value.trim() || null,
    localita: document.getElementById("allievo-localita").value.trim() || null,
    nomeGenitore: document.getElementById("allievo-nomegenitore").value.trim() || null,
    telefonoGenitore: document.getElementById("allievo-telefonogenitore").value.trim() || null,
    scuolaFrequentata: document.getElementById("allievo-scuola").value.trim() || null,
    altriSportPraticati: document.getElementById("allievo-altrisport").value.trim() || null,
    note: document.getElementById("allievo-note").value.trim() || null,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };

  try {
    if (allievoSelezionatoId) {
      await db.collection("allieviCorsi").doc(allievoSelezionatoId).update(payload);
      await caricaAllievi();
      await selectAllievo(allievoSelezionatoId);
    } else {
      payload.creatoDa = "staff";
      payload.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      const ref = await db.collection("allieviCorsi").add(payload);
      await caricaAllievi();
      await selectAllievo(ref.id);
    }
  } catch (err) {
    showError(errorEl, "Errore nel salvataggio: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

async function onDeleteAllievo() {
  if (!allievoSelezionatoId) return;
  // Le iscrizioni collegate NON vengono eliminate a cascata: restano con
  // un allievoId che non punta più a nessuno. Limite noto, non bloccante
  // per questa prima versione.
  if (!confirm("Eliminare definitivamente questo allievo? Lo storico iscrizioni collegato non viene toccato. L'operazione non è reversibile.")) return;
  const btn = document.getElementById("allievo-delete-btn");
  btn.disabled = true;
  try {
    await db.collection("allieviCorsi").doc(allievoSelezionatoId).delete();
    chiudiDettaglioAllievo();
    await caricaAllievi();
  } catch (err) {
    alert("Errore nell'eliminazione: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------- Comunicazioni ----------

async function onAggiungiComunicazione() {
  if (!allievoSelezionatoId) return;
  const testoEl = document.getElementById("comunicazione-testo");
  const canaleEl = document.getElementById("comunicazione-canale");
  const errorEl = document.getElementById("comunicazione-error");
  errorEl.textContent = "";

  const testo = testoEl.value.trim();
  if (!testo) {
    showError(errorEl, "Scrivi qualcosa prima di salvare la nota.");
    return;
  }

  const btn = document.getElementById("comunicazione-add-btn");
  btn.disabled = true;
  try {
    await db.collection("allieviCorsi").doc(allievoSelezionatoId).collection("comunicazioni").add({
      testo,
      canale: canaleEl.value || null,
      daUid: currentProfile.uid,
      daNome: currentProfile.nome,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    testoEl.value = "";
    canaleEl.value = "";
    await caricaDettaglioAllievo(allievoSelezionatoId);
  } catch (err) {
    showError(errorEl, "Errore nel salvataggio: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------- Stampa ----------

function stampaListatoAllievo(id) {
  if (!id || id !== allievoSelezionatoId) return;
  const nome = document.getElementById("allievo-nome").value;
  const cognome = document.getElementById("allievo-cognome").value;
  const dataNascita = document.getElementById("allievo-datanascita").value;
  const eta = etaDa(dataNascita);

  const righeAnagrafica = [
    ["Data di nascita", dataNascita ? formatDataBreve(dataNascita) + (eta != null ? ` (${eta} anni)` : "") : "—"],
    ["Email", document.getElementById("allievo-email").value || "—"],
    ["Nazionalità", document.getElementById("allievo-nazionalita").value || "—"],
    ["Indirizzo", [document.getElementById("allievo-via").value, [document.getElementById("allievo-cap").value, document.getElementById("allievo-localita").value].filter(Boolean).join(" ")].filter(Boolean).join(", ") || "—"],
    ["Genitore", [document.getElementById("allievo-nomegenitore").value, document.getElementById("allievo-telefonogenitore").value].filter(Boolean).join(" · ") || "—"],
    ["Scuola frequentata", document.getElementById("allievo-scuola").value || "—"],
    ["Altri sport praticati", document.getElementById("allievo-altrisport").value || "—"],
    ["Note", document.getElementById("allievo-note").value || "—"]
  ];

  const righeIscrizioni = iscrizioniAllievoCache.map(i => {
    const data = i.createdAt && typeof i.createdAt.toDate === "function" ? i.createdAt.toDate().toLocaleDateString("it-CH") : "—";
    return `<tr><td>${escapeHtml(i.corsoNome || "—")}${i.tipo === "ospite" ? " (ospite)" : ""}</td><td>${STATO_ISCRIZIONE_LABEL[i.stato] || i.stato || "—"}</td><td>${data}</td></tr>`;
  }).join("");

  const righeComunicazioni = comunicazioniAllievoCache.map(c => {
    const data = c.createdAt && typeof c.createdAt.toDate === "function" ? c.createdAt.toDate().toLocaleString("it-CH") : "—";
    const canale = c.canale ? CANALE_LABEL[c.canale] || c.canale : "—";
    return `<tr><td>${data}</td><td>${canale}</td><td>${escapeHtml(c.daNome || "—")}</td><td>${escapeHtml(c.testo || "")}</td></tr>`;
  }).join("");

  document.getElementById("print-area").innerHTML = `
    ${intestazioneStampaHtml()}
    <h1>${escapeHtml(cognome)} ${escapeHtml(nome)}</h1>
    <p>Istantanea del ${new Date().toLocaleString("it-CH")}</p>
    <table>
      <tbody>
        ${righeAnagrafica.map(([label, valore]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(valore)}</td></tr>`).join("")}
      </tbody>
    </table>
    <h2>Storico iscrizioni</h2>
    ${righeIscrizioni ? `
      <table>
        <thead><tr><th>Corso</th><th>Stato</th><th>Data iscrizione</th></tr></thead>
        <tbody>${righeIscrizioni}</tbody>
      </table>
    ` : "<p>Nessuna iscrizione</p>"}
    <h2>Comunicazioni</h2>
    ${righeComunicazioni ? `
      <table>
        <thead><tr><th>Data</th><th>Canale</th><th>Da</th><th>Nota</th></tr></thead>
        <tbody>${righeComunicazioni}</tbody>
      </table>
    ` : "<p>Nessuna comunicazione registrata</p>"}
  `;
  window.print();
}

// ---------- Init ----------

requireAuth(async (profile) => {
  currentProfile = profile;
  document.getElementById("user-chip").textContent = profile.nome + (profile.ruoloNome ? " · " + profile.ruoloNome : "");

  if (!hasPermission(profile, "allievi:gestisci")) {
    document.getElementById("access-denied").classList.remove("hidden");
    document.getElementById("admin-content").classList.add("hidden");
    return;
  }

  await loadDatiCentro();
  await Promise.all([caricaAllievi(), caricaIndiceIscrizioni()]);
  popolaFiltroCorso();
  renderAllieviList();

  let ricercaTimeout = null;
  document.getElementById("allievi-search-input").addEventListener("input", () => {
    clearTimeout(ricercaTimeout);
    ricercaTimeout = setTimeout(renderAllieviList, 400);
  });
  document.getElementById("allievi-filtro-corso").addEventListener("change", renderAllieviList);
  document.getElementById("allievi-filtro-stato").addEventListener("change", renderAllieviList);

  document.getElementById("nuovo-allievo-btn").addEventListener("click", nuovoAllievo);
  document.getElementById("allievo-form").addEventListener("submit", onSubmitAllievo);
  document.getElementById("allievo-cancel-btn").addEventListener("click", chiudiDettaglioAllievo);
  document.getElementById("allievo-delete-btn").addEventListener("click", onDeleteAllievo);
  document.getElementById("comunicazione-add-btn").addEventListener("click", onAggiungiComunicazione);
  document.getElementById("allievo-stampa-btn").addEventListener("click", () => stampaListatoAllievo(allievoSelezionatoId));
  ["allievo-nome", "allievo-cognome"].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener("blur", () => { el.value = capitalizzaNome(el.value); });
  });

  // Link diretto ?id=... (nessuna pagina lo usa ancora, ma deve funzionare
  // già da ora per link futuri).
  const idParam = new URLSearchParams(location.search).get("id");
  if (idParam) await selectAllievo(idParam);
});

document.getElementById("logout-link").addEventListener("click", (e) => {
  e.preventDefault();
  logout();
});

// ============================================================
// programmazione-corso.js — modulo di programmazione dei gruppi di un
// corso (dietro login, permesso iscrizioni:gestisci / _padel scoped).
//
// Si apre con ?corso=<id>. Mostra l'anagrafica degli iscritti con un
// livello 1–10 attribuibile dallo staff, propone automaticamente una
// suddivisione in gruppi (per slot giorno/orario × campo) rispettando
// età, livello, capienza, disponibilità e ore/settimana, e la lascia
// ritoccare a mano prima di salvarla come documenti gruppiCorso.
//
// Un gruppo salvato scrive sull'iscrizione: stato "confermata",
// gruppoIds:[...] e — per retro-compatibilità con i riepiloghi/stampe
// esistenti in corsi.js — anche giornoAssegnato/orarioAssegnato/
// campoAssegnato copiati dal gruppo primario (ordine più basso).
//
// Richiede firebase-config.js, utils.js e auth.js già caricati.
// ============================================================

let currentProfile = null;
let corsoId = null;
let corso = null;
let livelliCache = [];        // [{livello, nome, ...}] attivi, ordinati
let iscrizioni = [];          // tutte le iscrizioni del corso
let gruppiSalvati = [];       // gruppiCorso come letti da Firestore
let gruppiLavoro = [];        // modello di lavoro (salvati + bozza)

let filtroStato = "tutti";
let filtroLivello = "";
let filtroGiorno = "";

const SOGLIA_ETA_GRUPPO = 3;   // anni di scarto tollerati in un gruppo
const SOGLIA_LIVELLO_GRUPPO = 2;

// ---------- Helper locali ----------

function qs(name) {
  return new URLSearchParams(location.search).get(name);
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

function giornoLabel(id) {
  return (GIORNI_SETTIMANA.find(g => g.id === id) || {}).label || id;
}

// Tutte le combinazioni giorno/orario proposte dal corso, in ordine.
function combinazioniCorso() {
  const out = [];
  GIORNI_SETTIMANA.forEach(g => {
    (corso.giorniOrari?.[g.id] || []).forEach(o => out.push({ giorno: g.id, orario: o }));
  });
  return out;
}

function campiCorso() {
  return (corso.campiNumeri || []).length > 0 ? corso.campiNumeri.slice() : [null];
}

function oreSessione() {
  return (corso.durataSessioneMinuti || 60) / 60;
}

function sessioniNecessarie(i) {
  const ore = i.nrOreDesiderate || oreSessione();
  return Math.max(1, Math.ceil(ore / oreSessione() - 1e-9));
}

function dispSet(i) {
  return new Set(
    Object.entries(i.disponibilita || {}).flatMap(([g, orari]) => (orari || []).map(o => `${g}|${o}`))
  );
}

function iscrizioniProgrammabili() {
  return iscrizioni.filter(i => i.stato === "in_attesa" || i.stato === "confermata");
}

function etaFuoriRange(i) {
  const eta = etaDa(i.dataNascita);
  if (eta == null) return false;
  if (corso.etaMin != null && eta < corso.etaMin) return true;
  if (corso.etaMax != null && eta > corso.etaMax) return true;
  return false;
}

// registro immutabile, non blocca l'azione principale se fallisce
async function registraLog(iscrizioneId, iscrittoNome, azione, dettaglio) {
  try {
    await db.collection("iscrizioniLog").add({
      iscrizioneId, corsoId, iscrittoNome, azione, dettaglio,
      daUid: currentProfile.uid, daNome: currentProfile.nome,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch (err) {
    console.warn("registraLog fallito:", err.message);
  }
}

// ---------- Caricamento ----------

async function loadTutto() {
  const [corsoDoc, livelliSnap, iscrSnap, gruppiSnap] = await Promise.all([
    db.collection("corsi").doc(corsoId).get(),
    db.collection("livelliCorso").get(),
    db.collection("iscrizioniCorsi").where("corsoId", "==", corsoId).get(),
    db.collection("gruppiCorso").where("corsoId", "==", corsoId).get()
  ]);

  if (!corsoDoc.exists) throw new Error("Corso non trovato.");
  corso = { id: corsoDoc.id, ...corsoDoc.data() };

  livelliCache = livelliSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(l => l.attivo !== false)
    .sort((a, b) => (a.ordine ?? a.livello ?? 99) - (b.ordine ?? b.livello ?? 99));

  iscrizioni = iscrSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  gruppiSalvati = gruppiSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.ordine ?? 99) - (b.ordine ?? 99));

  gruppiLavoro = gruppiSalvati.map((g, idx) => {
    // membriIds è la fonte autorevole dell'appartenenza (funziona anche in
    // bozza, quando le iscrizioni non sono ancora state toccate); ripiego
    // su iscrizioniCorsi.gruppoIds per compatibilità.
    const daMembriIds = Array.isArray(g.membriIds) ? g.membriIds.filter(id => iscrizioni.some(i => i.id === id)) : null;
    const membri = daMembriIds && daMembriIds.length
      ? daMembriIds
      : iscrizioni.filter(i => (i.gruppoIds || []).includes(g.id)).map(i => i.id);
    return {
      tempId: "g" + idx,
      firestoreId: g.id,
      bozza: g.bozza !== false,
      nome: g.nome || "",
      giorno: g.giorno || null,
      orario: g.orario || null,
      campo: g.campo || null,
      capienza: g.capienza != null ? g.capienza : (corso.maxIscrittiPerSessione || null),
      istruttoreNome: g.istruttoreNome || "",
      note: g.note || "",
      ordine: g.ordine != null ? g.ordine : idx,
      membri,
      _deleted: false
    };
  });
}

// Stato complessivo del piano salvato (non del modello di lavoro):
// "nessuno" | "bozza" | "confermato".
function statoPianoSalvato() {
  if (!gruppiSalvati.length) return "nessuno";
  return gruppiSalvati.every(g => g.bozza === false) ? "confermato" : "bozza";
}

function ultimaModificaPiano() {
  let best = null;
  gruppiSalvati.forEach(g => {
    const t = g.aggiornatoAt?.toMillis ? g.aggiornatoAt.toMillis() : 0;
    if (!best || t > best.t) best = { t, nome: g.aggiornatoDaNome || g.creatoDaNome || "—", at: g.aggiornatoAt || g.createdAt || null };
  });
  return best;
}

// ---------- Anagrafica iscritti ----------

function gruppiDi(iscrizioneId) {
  return gruppiLavoro.filter(g => !g._deleted && g.membri.includes(iscrizioneId));
}

function renderFiltri() {
  const statoEl = document.getElementById("prog-filtri-stato");
  const opzioni = [
    { id: "tutti", label: "Tutti" },
    { id: "in_attesa", label: "In attesa" },
    { id: "confermata", label: "Confermati" },
    { id: "senza_gruppo", label: "Senza gruppo" }
  ];
  statoEl.innerHTML = opzioni
    .map(o => `<button type="button" data-stato="${o.id}" aria-pressed="${o.id === filtroStato}">${o.label}</button>`)
    .join("");
  statoEl.querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
    filtroStato = b.dataset.stato;
    renderFiltri();
    renderIscritti();
  }));

  const livEl = document.getElementById("prog-filtro-livello");
  if (livEl.options.length <= 1) {
    livelliCache.forEach(l => {
      const opt = document.createElement("option");
      opt.value = String(l.livello);
      opt.textContent = `${l.livello} · ${l.nome}`;
      livEl.appendChild(opt);
    });
    const senza = document.createElement("option");
    senza.value = "__nessuno__";
    senza.textContent = "Senza livello";
    livEl.appendChild(senza);
  }

  const giornoEl = document.getElementById("prog-filtro-giorno");
  if (giornoEl.options.length <= 1) {
    GIORNI_SETTIMANA.filter(g => (corso.giorniOrari || {})[g.id]?.length)
      .forEach(g => {
        const opt = document.createElement("option");
        opt.value = g.id;
        opt.textContent = g.label;
        giornoEl.appendChild(opt);
      });
  }
}

function passaFiltri(i) {
  if (filtroStato === "in_attesa" && i.stato !== "in_attesa") return false;
  if (filtroStato === "confermata" && i.stato !== "confermata") return false;
  if (filtroStato === "senza_gruppo" && gruppiDi(i.id).length > 0) return false;
  if (filtroLivello === "__nessuno__" && i.livello != null) return false;
  if (filtroLivello && filtroLivello !== "__nessuno__" && String(i.livello) !== filtroLivello) return false;
  if (filtroGiorno && !(i.disponibilita?.[filtroGiorno]?.length)) return false;
  return true;
}

function livelloOptionsHtml(selected) {
  const opts = [`<option value="">livello —</option>`];
  livelliCache.forEach(l => {
    opts.push(`<option value="${l.livello}"${String(selected) === String(l.livello) ? " selected" : ""}>${l.livello} · ${escapeHtml(l.nome)}</option>`);
  });
  return opts.join("");
}

function renderIscritti() {
  const el = document.getElementById("prog-iscritti-list");
  const statoLabel = { in_attesa: "In attesa", confermata: "Confermata", annullata: "Annullata" };
  const lista = iscrizioniProgrammabili()
    .filter(passaFiltri)
    .sort((a, b) => (a.livello ?? 99) - (b.livello ?? 99)
      || (etaDa(a.dataNascita) ?? 999) - (etaDa(b.dataNascita) ?? 999)
      || (a.cognome || "").localeCompare(b.cognome || ""));

  if (lista.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="display">Nessun iscritto con questi filtri</div></div>`;
    return;
  }

  el.innerHTML = lista.map(i => {
    const eta = etaDa(i.dataNascita);
    const disp = Object.entries(i.disponibilita || {})
      .map(([g, orari]) => `${giornoLabel(g)} ${orari.join("/")}`).join(" · ") || "—";
    const gruppi = gruppiDi(i.id);
    const avvisi = [];
    if (i.livello == null) avvisi.push("livello mancante");
    if (etaFuoriRange(i)) avvisi.push(`età fuori range (${corso.etaMin ?? "–"}–${corso.etaMax ?? "–"})`);
    const combSet = new Set(combinazioniCorso().map(c => `${c.giorno}|${c.orario}`));
    const haDispCompatibile = [...dispSet(i)].some(k => combSet.has(k));
    if (!corso.forfettario && !haDispCompatibile) avvisi.push("nessuna disponibilità compatibile");
    const sess = sessioniNecessarie(i);

    return `
      <div class="entry-card">
        <div class="entry-main">
          <span class="badge" style="border-color:var(--chalk-grey-dim);color:var(--chalk-grey);">${statoLabel[i.stato] || i.stato}</span>
          <div class="entry-tipo">${escapeHtml(i.cognome)} ${escapeHtml(i.nome)}${eta != null ? " · " + eta + " anni" : ""}</div>
          <div class="entry-meta">${i.nrOreDesiderate ? i.nrOreDesiderate + "h/sett. · " + sess + (sess === 1 ? " sessione" : " sessioni") : "ore non indicate"}</div>
          <div class="entry-meta">Disponibilità: ${escapeHtml(disp)}</div>
          <div class="entry-meta">Gruppi: ${gruppi.length ? gruppi.map(g => escapeHtml(nomeGruppo(g))).join(", ") : "—"}</div>
          ${avvisi.length ? `<div class="entry-meta" style="color:var(--danger);">⚠ ${avvisi.join(" · ")}</div>` : ""}
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;">
          <select class="prog-livello-select" data-id="${i.id}" style="font-size:0.72rem;padding:6px 8px;">
            ${livelloOptionsHtml(i.livello)}
          </select>
          <select class="prog-move-select" data-id="${i.id}" style="font-size:0.72rem;padding:6px 8px;">
            <option value="">Aggiungi a un gruppo…</option>
            ${gruppiLavoro.filter(g => !g._deleted).map(g => `<option value="${g.tempId}"${g.membri.includes(i.id) ? " disabled" : ""}>${escapeHtml(nomeGruppo(g))}</option>`).join("")}
          </select>
        </div>
      </div>
    `;
  }).join("");

  el.querySelectorAll(".prog-livello-select").forEach(sel => {
    sel.addEventListener("change", () => setLivello(sel.dataset.id, sel.value));
  });
  el.querySelectorAll(".prog-move-select").forEach(sel => {
    sel.addEventListener("change", () => {
      if (sel.value) aggiungiAGruppo(sel.dataset.id, sel.value);
    });
  });
}

async function setLivello(iscrizioneId, valoreRaw) {
  const i = iscrizioni.find(x => x.id === iscrizioneId);
  if (!i) return;
  const livello = valoreRaw !== "" ? parseInt(valoreRaw, 10) : null;
  const precedente = i.livello ?? null;
  if (livello === precedente) return;
  try {
    await db.collection("iscrizioniCorsi").doc(iscrizioneId).update({ livello });
    i.livello = livello;
    const nomeL = livello != null ? (livelliCache.find(l => l.livello === livello)?.nome || "") : "";
    await registraLog(iscrizioneId, `${i.nome} ${i.cognome}`, "livello_impostato",
      livello != null ? `Livello ${livello}${nomeL ? " (" + nomeL + ")" : ""}` : "Livello rimosso");
    renderIscritti();
    renderGruppi();
  } catch (err) {
    showError(document.getElementById("prog-error"), "Errore nel salvataggio del livello: " + err.message);
  }
}

// ---------- Gruppi ----------

function nomeGruppo(g) {
  if (g.nome) return g.nome;
  const slot = g.giorno && g.orario ? `${giornoLabel(g.giorno)} ${g.orario}` : "senza slot";
  return `${slot}${g.campo ? " · Campo " + g.campo : ""}`;
}

function nuovoTempId() {
  return "g" + Date.now() + Math.floor(Math.random() * 1000);
}

function creaGruppoVuoto(giorno, orario, campo) {
  return {
    tempId: nuovoTempId(),
    firestoreId: null,
    bozza: true,
    nome: "",
    giorno: giorno ?? null,
    orario: orario ?? null,
    campo: campo ?? null,
    capienza: corso.maxIscrittiPerSessione || null,
    istruttoreNome: "",
    note: "",
    ordine: gruppiLavoro.length,
    membri: [],
    _deleted: false
  };
}

function aggiungiGruppoManuale() {
  const comb = combinazioniCorso()[0] || { giorno: null, orario: null };
  const campo = campiCorso()[0];
  gruppiLavoro.push(creaGruppoVuoto(comb.giorno, comb.orario, campo));
  renderGruppi();
  renderIscritti();
}

function aggiungiAGruppo(iscrizioneId, gruppoTempId) {
  const g = gruppiLavoro.find(x => x.tempId === gruppoTempId);
  if (!g || g.membri.includes(iscrizioneId)) return;
  g.membri.push(iscrizioneId);
  renderGruppi();
  renderIscritti();
}

function rimuoviDaGruppo(iscrizioneId, gruppoTempId) {
  const g = gruppiLavoro.find(x => x.tempId === gruppoTempId);
  if (!g) return;
  g.membri = g.membri.filter(id => id !== iscrizioneId);
  renderGruppi();
  renderIscritti();
}

function eliminaGruppo(gruppoTempId) {
  const g = gruppiLavoro.find(x => x.tempId === gruppoTempId);
  if (!g) return;
  if (g.membri.length && !confirm(`Il gruppo "${nomeGruppo(g)}" ha ${g.membri.length} iscritti. Toglierli e rimuovere il gruppo?`)) return;
  g.membri = [];
  if (g.firestoreId) g._deleted = true;
  else gruppiLavoro = gruppiLavoro.filter(x => x.tempId !== gruppoTempId);
  renderGruppi();
  renderIscritti();
}

function avvisiGruppo(g) {
  const membri = g.membri.map(id => iscrizioni.find(i => i.id === id)).filter(Boolean);
  const avvisi = [];
  if (g.capienza && membri.length > g.capienza) avvisi.push(`oltre capienza (${membri.length}/${g.capienza})`);
  if (corso.minIscrittiConferma && membri.length < corso.minIscrittiConferma) avvisi.push(`sotto la soglia minima (${membri.length}/${corso.minIscrittiConferma})`);
  const livelli = membri.map(i => i.livello).filter(v => v != null);
  if (livelli.length >= 2 && Math.max(...livelli) - Math.min(...livelli) > SOGLIA_LIVELLO_GRUPPO) avvisi.push("livelli eterogenei");
  const eta = membri.map(i => etaDa(i.dataNascita)).filter(v => v != null);
  if (eta.length >= 2 && Math.max(...eta) - Math.min(...eta) > SOGLIA_ETA_GRUPPO) avvisi.push("età eterogenee");
  if (g.giorno && g.orario) {
    const fuori = membri.filter(i => !dispSet(i).has(`${g.giorno}|${g.orario}`));
    if (fuori.length) avvisi.push(`${fuori.length} fuori disponibilità`);
  }
  return avvisi;
}

function selectSlotHtml(g) {
  const comb = combinazioniCorso();
  const opts = comb.map(c => `<option value="${c.giorno}|${c.orario}"${g.giorno === c.giorno && g.orario === c.orario ? " selected" : ""}>${giornoLabel(c.giorno)} ${c.orario}</option>`).join("");
  return `<select class="prog-g-slot" data-id="${g.tempId}" style="font-size:0.72rem;padding:6px 8px;"><option value="">— slot —</option>${opts}</select>`;
}

function selectCampoHtml(g) {
  const campi = campiCorso();
  if (campi.length === 1 && campi[0] == null) return "";
  const opts = campi.map(n => `<option value="${n}"${String(g.campo) === String(n) ? " selected" : ""}>Campo ${n}</option>`).join("");
  return `<select class="prog-g-campo" data-id="${g.tempId}" style="font-size:0.72rem;padding:6px 8px;"><option value="">— campo —</option>${opts}</select>`;
}

function renderGruppi() {
  const el = document.getElementById("prog-gruppi-list");
  const attivi = gruppiLavoro.filter(g => !g._deleted);

  renderAvvisi();

  if (attivi.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="display">Nessun gruppo — genera una proposta o creane uno a mano</div></div>`;
    return;
  }

  el.innerHTML = attivi
    .slice()
    .sort((a, b) => (a.ordine ?? 99) - (b.ordine ?? 99))
    .map(g => {
      const membri = g.membri
        .map(id => iscrizioni.find(i => i.id === id))
        .filter(Boolean)
        .sort((a, b) => (a.livello ?? 99) - (b.livello ?? 99) || (etaDa(a.dataNascita) ?? 999) - (etaDa(b.dataNascita) ?? 999));
      const avvisi = avvisiGruppo(g);
      const cap = g.capienza ? `${membri.length} / ${g.capienza}` : `${membri.length}`;
      const capOltre = g.capienza && membri.length > g.capienza;
      const righe = membri.map(i => `
        <div class="candidato-row">
          <span class="candidato-nome">${escapeHtml(i.cognome)} ${escapeHtml(i.nome)}${etaDa(i.dataNascita) != null ? " · " + etaDa(i.dataNascita) : ""}${i.livello != null ? " · L" + i.livello : ""}</span>
          <button type="button" class="btn btn-ghost prog-g-rimuovi" data-g="${g.tempId}" data-i="${i.id}" style="width:auto;padding:4px 8px;font-size:0.66rem;">Togli</button>
        </div>
      `).join("") || `<div class="entry-meta">Nessun iscritto</div>`;

      return `
        <div class="entry-card" style="display:block;">
          <div style="display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap;">
            <input type="text" class="prog-g-nome" data-id="${g.tempId}" value="${escapeHtml(g.nome)}" placeholder="${escapeHtml(nomeGruppo(g))}" style="flex:1;min-width:140px;font-size:0.82rem;padding:6px 8px;">
            <span class="badge" style="${capOltre ? "border-color:var(--danger);color:var(--danger);" : "border-color:#7f9e4a;color:#c1e08f;"}">${cap}</span>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
            ${selectSlotHtml(g)}
            ${selectCampoHtml(g)}
            <input type="number" class="prog-g-capienza" data-id="${g.tempId}" value="${g.capienza != null ? g.capienza : ""}" min="1" step="1" placeholder="capienza" style="width:90px;font-size:0.72rem;padding:6px 8px;">
            <input type="text" class="prog-g-istruttore" data-id="${g.tempId}" value="${escapeHtml(g.istruttoreNome)}" placeholder="istruttore" style="width:130px;font-size:0.72rem;padding:6px 8px;">
          </div>
          ${!g.firestoreId ? `<div class="entry-meta" style="margin-top:6px;">nuovo — mai salvato</div>`
            : g.bozza ? `<div class="entry-meta" style="margin-top:6px;color:#d4b83a;">bozza</div>`
            : `<div class="entry-meta" style="margin-top:6px;color:#c1e08f;">confermato</div>`}
          ${avvisi.length ? `<div class="entry-meta" style="color:var(--danger);margin-top:6px;">⚠ ${avvisi.join(" · ")}</div>` : ""}
          <div style="margin-top:10px;">${righe}</div>
          <div style="margin-top:10px;">
            <button type="button" class="btn btn-danger prog-g-elimina" data-id="${g.tempId}" style="width:auto;padding:6px 12px;font-size:0.68rem;">Elimina gruppo</button>
          </div>
        </div>
      `;
    }).join("");

  el.querySelectorAll(".prog-g-rimuovi").forEach(b => b.addEventListener("click", () => rimuoviDaGruppo(b.dataset.i, b.dataset.g)));
  el.querySelectorAll(".prog-g-elimina").forEach(b => b.addEventListener("click", () => eliminaGruppo(b.dataset.id)));
  el.querySelectorAll(".prog-g-nome").forEach(inp => inp.addEventListener("change", () => { patchGruppo(inp.dataset.id, { nome: inp.value.trim() }); }));
  el.querySelectorAll(".prog-g-capienza").forEach(inp => inp.addEventListener("change", () => { patchGruppo(inp.dataset.id, { capienza: inp.value !== "" ? parseInt(inp.value, 10) : null }); renderGruppi(); }));
  el.querySelectorAll(".prog-g-istruttore").forEach(inp => inp.addEventListener("change", () => { patchGruppo(inp.dataset.id, { istruttoreNome: inp.value.trim() }); }));
  el.querySelectorAll(".prog-g-slot").forEach(sel => sel.addEventListener("change", () => {
    const [giorno, orario] = sel.value ? sel.value.split("|") : [null, null];
    patchGruppo(sel.dataset.id, { giorno, orario });
    renderGruppi(); renderIscritti();
  }));
  el.querySelectorAll(".prog-g-campo").forEach(sel => sel.addEventListener("change", () => {
    patchGruppo(sel.dataset.id, { campo: sel.value || null });
    renderGruppi();
  }));
}

function patchGruppo(tempId, patch) {
  const g = gruppiLavoro.find(x => x.tempId === tempId);
  if (g) Object.assign(g, patch);
}

function renderAvvisi() {
  const el = document.getElementById("prog-avvisi");
  const nonCollocati = iscrizioniProgrammabili().filter(i => gruppiDi(i.id).length === 0);
  const sottoOre = iscrizioniProgrammabili().filter(i => gruppiDi(i.id).length > 0 && gruppiDi(i.id).length < sessioniNecessarie(i));
  const parti = [];
  if (nonCollocati.length) parti.push(`${nonCollocati.length} iscritti non ancora in un gruppo`);
  if (sottoOre.length) parti.push(`${sottoOre.length} con meno sessioni di quelle richieste`);
  el.innerHTML = parti.length
    ? `<div class="entry-card"><div class="entry-main"><div class="entry-meta">${parti.join(" · ")}</div></div></div>`
    : "";
}

// ---------- Proposta automatica ----------

function generaProposta() {
  const esistentiConMembri = gruppiLavoro.filter(g => !g._deleted && g.membri.length);
  if (esistentiConMembri.length && !confirm("Rigenerare la proposta sostituisce i gruppi attuali (quelli salvati verranno eliminati al salvataggio). Continuare?")) return;

  // Segna eliminati i gruppi salvati, scarta le bozze
  gruppiLavoro = gruppiLavoro.filter(g => g.firestoreId).map(g => ({ ...g, membri: [], _deleted: true }));

  const combos = combinazioniCorso();
  const campi = campiCorso();
  const contenitori = [];
  let ord = 0;
  combos.forEach(c => {
    campi.forEach(campo => {
      const g = creaGruppoVuoto(c.giorno, c.orario, campo);
      g.ordine = ord++;
      contenitori.push(g);
    });
  });

  if (contenitori.length === 0) {
    alert("Il corso non propone né giorni/orari né campi: impossibile generare gruppi.");
    return;
  }

  const candidati = iscrizioniProgrammabili()
    .filter(i => !etaFuoriRange(i))
    .slice()
    .sort((a, b) => (a.livello ?? 99) - (b.livello ?? 99) || (etaDa(a.dataNascita) ?? 999) - (etaDa(b.dataNascita) ?? 999));

  candidati.forEach(i => {
    const disponibile = dispSet(i);
    const compatibili = contenitori.filter(g => disponibile.has(`${g.giorno}|${g.orario}`));
    if (compatibili.length === 0) return;
    const nSess = sessioniNecessarie(i);
    const slotUsati = new Set();
    for (let s = 0; s < nSess; s++) {
      const scelto = miglioreContenitore(compatibili, i, slotUsati);
      if (!scelto) break;
      scelto.membri.push(i.id);
      slotUsati.add(`${scelto.giorno}|${scelto.orario}`);
    }
  });

  const proposti = contenitori.filter(g => g.membri.length);
  proposti.forEach((g, idx) => {
    g.ordine = idx;
    g.nome = `Gruppo ${String.fromCharCode(65 + idx)} — ${giornoLabel(g.giorno)} ${g.orario}${g.campo ? " · C" + g.campo : ""}`;
  });
  gruppiLavoro = [...gruppiLavoro, ...proposti];

  renderGruppi();
  renderIscritti();
}

function miglioreContenitore(compatibili, iscritto, slotUsati) {
  const etaI = etaDa(iscritto.dataNascita);
  const livI = iscritto.livello;
  const candidati = compatibili
    .filter(g => !slotUsati.has(`${g.giorno}|${g.orario}`))
    .filter(g => !g.capienza || g.membri.length < g.capienza);
  if (candidati.length === 0) return null;

  function costo(g) {
    const membri = g.membri.map(id => iscrizioni.find(i => i.id === id)).filter(Boolean);
    let c = 0;
    if (membri.length) {
      const livelli = membri.map(m => m.livello).filter(v => v != null);
      if (livI != null && livelli.length) {
        const scartoLiv = Math.max(...livelli.map(l => Math.abs(l - livI)));
        c += scartoLiv * 10;
        if (scartoLiv > SOGLIA_LIVELLO_GRUPPO) c += 100;
      }
      const eta = membri.map(m => etaDa(m.dataNascita)).filter(v => v != null);
      if (etaI != null && eta.length) {
        const scartoEta = Math.max(...eta.map(e => Math.abs(e - etaI)));
        c += scartoEta * 3;
        if (scartoEta > SOGLIA_ETA_GRUPPO) c += 50;
      }
    }
    c -= membri.length; // preferisci consolidare i gruppi già avviati
    return c;
  }

  return candidati.slice().sort((a, b) => costo(a) - costo(b))[0];
}

// ---------- Salvataggio ----------
//
// Due azioni distinte:
// - "Salva bozza": scrive solo i documenti gruppiCorso (bozza:true, con
//   l'elenco membri sul gruppo stesso). NON tocca le iscrizioni, nessun
//   addebito. Serve a lavorare in più mani / far rivedere al supervisore.
// - "Conferma definitiva": doppio avviso, poi scrive i gruppi (bozza:false)
//   E sincronizza le iscrizioni (stato "confermata", gruppoIds, slot
//   assegnato) avviando gli addebiti per chi ha la carta salvata.

// Scrive create/update/delete dei gruppiCorso nel batch. definitivo=false
// lascia i gruppi in bozza. Ritorna i gruppi non eliminati con id Firestore.
function scriviGruppiInBatch(batch, definitivo) {
  gruppiLavoro.forEach(g => {
    if (g._deleted) return;
    if (!g.firestoreId) {
      g.firestoreId = db.collection("gruppiCorso").doc().id;
      g._isNew = true;
    }
  });

  gruppiLavoro.forEach(g => {
    if (g._deleted) {
      if (g.firestoreId && !g._isNew) batch.delete(db.collection("gruppiCorso").doc(g.firestoreId));
      return;
    }
    if (!g.firestoreId) return;

    const dati = {
      corsoId,
      disciplina: corso.disciplina,
      bozza: !definitivo,
      nome: g.nome || nomeGruppo(g),
      giorno: g.giorno || null,
      orario: g.orario || null,
      campo: g.campo || null,
      durataMinuti: corso.durataSessioneMinuti || null,
      capienza: g.capienza != null ? g.capienza : null,
      istruttoreNome: g.istruttoreNome || null,
      note: g.note || null,
      ordine: g.ordine ?? 99,
      membriIds: g.membri.slice(),
      aggiornatoDaUid: currentProfile.uid,
      aggiornatoDaNome: currentProfile.nome,
      aggiornatoAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    const ref = db.collection("gruppiCorso").doc(g.firestoreId);
    if (g._isNew) {
      batch.set(ref, { ...dati, creatoDaUid: currentProfile.uid, creatoDaNome: currentProfile.nome, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    } else {
      batch.update(ref, dati);
    }
  });

  return gruppiLavoro.filter(g => !g._deleted && g.firestoreId);
}

// Sincronizza le iscrizioni con l'appartenenza ai gruppi (solo conferma
// definitiva). Ritorna { logs, daNotificare }.
function sincronizzaIscrizioniInBatch(batch, gruppiAttivi) {
  const daNotificare = [];
  const logs = [];

  iscrizioni.forEach(i => {
    if (i.stato === "annullata") return;
    const nuoviIds = gruppiAttivi.filter(g => g.membri.includes(i.id)).map(g => g.firestoreId);
    const vecchiIds = (i.gruppoIds || []).slice();
    const cambiatoGruppi = nuoviIds.slice().sort().join("|") !== vecchiIds.slice().sort().join("|");
    const cambiatoStato = nuoviIds.length && i.stato !== "confermata";
    if (!cambiatoGruppi && !cambiatoStato) return;

    const primario = gruppiAttivi
      .filter(g => nuoviIds.includes(g.firestoreId))
      .sort((a, b) => (a.ordine ?? 99) - (b.ordine ?? 99))[0] || null;

    const nuovoStato = nuoviIds.length ? "confermata" : (i.stato === "confermata" ? "in_attesa" : i.stato);

    const patch = {
      gruppoIds: nuoviIds,
      stato: nuovoStato,
      giornoAssegnato: primario ? primario.giorno : null,
      orarioAssegnato: primario ? primario.orario : null,
      campoAssegnato: primario ? (primario.campo || null) : null,
      gestitaDaUid: currentProfile.uid,
      gestitaDaNome: currentProfile.nome
    };
    if (nuoviIds.length) patch.motivoRifiuto = null;

    batch.update(db.collection("iscrizioniCorsi").doc(i.id), patch);

    const nomeCompleto = `${i.nome} ${i.cognome}`;
    const dettaglio = nuoviIds.length
      ? `In ${nuoviIds.length} ${nuoviIds.length === 1 ? "gruppo" : "gruppi"}${primario && primario.giorno ? " — primario " + giornoLabel(primario.giorno) + " " + primario.orario : ""}`
      : "Rimosso da tutti i gruppi";
    logs.push({ id: i.id, nome: nomeCompleto, azione: "raggruppato", dettaglio });

    if (nuoviIds.length && i.stato !== "confermata" && i.tokenStato === "ATTIVO") daNotificare.push(i);
  });

  return { logs, daNotificare };
}

async function salvaBozza() {
  const btn = document.getElementById("prog-salva-bozza-btn");
  if (statoPianoSalvato() === "confermato" &&
      !confirm("Questo piano è già stato confermato. Salvandolo come bozza i gruppi non compariranno più nei riepiloghi finché non lo riconfermi (le iscrizioni restano «confermata»). Continuare?")) {
    return;
  }
  btn.disabled = true;
  mostraCaricamento("Salvataggio bozza…");
  try {
    const batch = db.batch();
    scriviGruppiInBatch(batch, false);
    await batch.commit();
    await loadTutto();
    renderTutto();
    nascondiCaricamento();
    alert("Bozza salvata. Chi apre la programmazione di questo corso vede e può continuare questa bozza.");
  } catch (err) {
    nascondiCaricamento();
    showError(document.getElementById("prog-error"), "Errore nel salvataggio: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

async function confermaDefinitiva() {
  const btn = document.getElementById("prog-conferma-btn");
  const inGruppo = iscrizioniProgrammabili().filter(i => gruppiDi(i.id).length > 0).length;
  const conCarta = iscrizioniProgrammabili().filter(i => gruppiDi(i.id).length > 0 && i.stato !== "confermata" && i.tokenStato === "ATTIVO").length;

  if (!confirm(
    `Confermare definitivamente la programmazione?\n\n` +
    `• ${inGruppo} iscritti nei gruppi passano a stato «confermata» con giorno/orario/campo assegnati.\n` +
    (conCarta ? `• Per ${conCarta} di loro (carta salvata) parte subito l'addebito automatico dell'importo.\n` : "") +
    `• I gruppi diventano quelli definitivi e compaiono nei riepiloghi.`
  )) return;

  if (!confirm("Sei sicuro? L'operazione modifica le iscrizioni e non è annullabile automaticamente.")) return;

  btn.disabled = true;
  mostraCaricamento("Conferma programmazione…");
  try {
    const batch = db.batch();
    const gruppiAttivi = scriviGruppiInBatch(batch, true);
    const { logs, daNotificare } = sincronizzaIscrizioniInBatch(batch, gruppiAttivi);

    await batch.commit();
    await Promise.all(logs.map(l => registraLog(l.id, l.nome, l.azione, l.dettaglio)));

    if (daNotificare.length) {
      const fn = cloudFunctions().httpsCallable("addebitaIscrizioneCorso");
      daNotificare.forEach(i => fn({ iscrizioneId: i.id }).catch(err => console.error("addebitaIscrizioneCorso:", err)));
    }

    await loadTutto();
    renderTutto();
    nascondiCaricamento();
    alert("Programmazione confermata.");
  } catch (err) {
    nascondiCaricamento();
    showError(document.getElementById("prog-error"), "Errore nella conferma: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------- Stampa ----------

function stampaProgrammazione() {
  const attivi = gruppiLavoro.filter(g => !g._deleted).sort((a, b) => (a.ordine ?? 99) - (b.ordine ?? 99));
  let righe = "";
  attivi.forEach(g => {
    const membri = g.membri.map(id => iscrizioni.find(i => i.id === id)).filter(Boolean)
      .sort((a, b) => (a.livello ?? 99) - (b.livello ?? 99) || (etaDa(a.dataNascita) ?? 999) - (etaDa(b.dataNascita) ?? 999));
    if (membri.length === 0) return;
    membri.forEach((i, idx) => {
      righe += `<tr>
        <td>${idx === 0 ? escapeHtml(g.nome || nomeGruppo(g)) : ""}</td>
        <td>${idx === 0 && g.giorno ? giornoLabel(g.giorno) + " " + g.orario : ""}</td>
        <td>${idx === 0 && g.campo ? "Campo " + escapeHtml(String(g.campo)) : ""}</td>
        <td>${escapeHtml(i.cognome)} ${escapeHtml(i.nome)}</td>
        <td>${etaDa(i.dataNascita) != null ? etaDa(i.dataNascita) : "—"}</td>
        <td>${i.livello != null ? i.livello : "—"}</td>
      </tr>`;
    });
  });

  document.getElementById("print-area").innerHTML = `
    ${intestazioneStampaHtml()}
    <h1>Programmazione — ${escapeHtml(corso.nome)}</h1>
    <p>${escapeHtml(disciplinaLabel(corso.disciplina))} · ${new Date().toLocaleString("it-CH")}</p>
    <table>
      <thead><tr><th>Gruppo</th><th>Slot</th><th>Campo</th><th>Nominativo</th><th>Età</th><th>Livello</th></tr></thead>
      <tbody>${righe || `<tr><td colspan="6">Nessun gruppo con iscritti</td></tr>`}</tbody>
    </table>
  `;
  window.print();
}

// ---------- Render generale ----------

function renderTutto() {
  document.getElementById("prog-corso-nome").textContent = corso.nome || "Corso";
  const combLabel = combinazioniCorso().map(c => `${giornoLabel(c.giorno)} ${c.orario}`).join(" · ") || "—";
  document.getElementById("prog-corso-meta").textContent =
    `${disciplinaLabel(corso.disciplina)} · ${corso.nrSessioni || "—"} sessioni da ${corso.durataSessioneMinuti || "—"}' · campi ${(corso.campiNumeri || []).join(", ") || "—"} · età ${corso.etaMin ?? "–"}–${corso.etaMax ?? "–"} · max ${corso.maxIscrittiPerSessione ?? "—"}/gruppo · slot: ${combLabel}`;
  renderStatoPiano();
  renderFiltri();
  renderIscritti();
  renderGruppi();
}

function renderStatoPiano() {
  const el = document.getElementById("prog-stato");
  const stato = statoPianoSalvato();
  const ultima = ultimaModificaPiano();
  const quando = ultima && ultima.at && ultima.at.toDate ? ultima.at.toDate().toLocaleString("it-CH") : null;
  const info = ultima ? ` · ultima modifica: ${escapeHtml(ultima.nome)}${quando ? " il " + quando : ""}` : "";

  if (stato === "nessuno") {
    el.innerHTML = `<span class="badge" style="border-color:var(--chalk-grey-dim);color:var(--chalk-grey);">Nessun piano salvato</span>`;
    return;
  }
  if (stato === "bozza") {
    el.innerHTML = `<span class="badge" style="border-color:#d4b83a;color:#d4b83a;">BOZZA</span><span class="entry-meta" style="display:inline;margin-left:8px;">non ancora confermata — le iscrizioni non sono state toccate${info}</span>`;
    return;
  }
  el.innerHTML = `<span class="badge" style="border-color:#7f9e4a;color:#c1e08f;">CONFERMATA</span><span class="entry-meta" style="display:inline;margin-left:8px;">iscritti confermati e slot assegnati${info}</span>`;
}

// ---------- Init ----------

requireAuth(async (profile) => {
  currentProfile = profile;
  document.getElementById("user-chip").textContent = profile.nome + (profile.ruoloNome ? " · " + profile.ruoloNome : "");

  corsoId = qs("corso");
  const puoTutte = hasPermission(profile, "iscrizioni:gestisci");
  const puoPadel = hasPermission(profile, "iscrizioni:gestisci_padel");

  if (!corsoId || (!puoTutte && !puoPadel)) {
    document.getElementById("access-denied").classList.remove("hidden");
    return;
  }

  try {
    await loadDatiCentro();
    await loadDiscipline();
    await loadTutto();
  } catch (err) {
    document.getElementById("access-denied").classList.remove("hidden");
    document.getElementById("access-denied").querySelector("p").textContent = err.message;
    return;
  }

  if (corso.forfettario) {
    document.getElementById("access-denied").classList.remove("hidden");
    document.getElementById("access-denied").querySelector("p").textContent =
      "I corsi forfettari non hanno gruppi: si confermano una per una dalla pagina Corsi.";
    return;
  }

  if (!puoTutte && !(puoPadel && corso.disciplina === "padel")) {
    document.getElementById("access-denied").classList.remove("hidden");
    return;
  }

  document.getElementById("content").classList.remove("hidden");

  document.getElementById("prog-filtro-livello").addEventListener("change", (e) => { filtroLivello = e.target.value; renderIscritti(); });
  document.getElementById("prog-filtro-giorno").addEventListener("change", (e) => { filtroGiorno = e.target.value; renderIscritti(); });
  document.getElementById("prog-genera-btn").addEventListener("click", generaProposta);
  document.getElementById("prog-nuovo-gruppo-btn").addEventListener("click", aggiungiGruppoManuale);
  document.getElementById("prog-salva-bozza-btn").addEventListener("click", salvaBozza);
  document.getElementById("prog-conferma-btn").addEventListener("click", confermaDefinitiva);
  document.getElementById("prog-stampa-btn").addEventListener("click", stampaProgrammazione);

  renderTutto();
});

document.getElementById("logout-link").addEventListener("click", (e) => {
  e.preventDefault();
  logout();
});

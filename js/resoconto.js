// ============================================================
// resoconto.js — totale ore per periodo (dal/al), con breakdown
// per disciplina (vista personale) e, per chi ha il permesso
// diario:leggi_tutti, per dipendente e per tipo di attività con
// cumulo dei costi (in base alle tariffe configurate), quota campo
// dovuta al circolo dai collaboratori/tipi attività marcati come
// soggetti, compenso dovuto ai collaboratori (tariffa oraria per
// utente sui tipi attività marcati come retribuibili), e totale
// complessivo. Ogni dipendente è spaccato per disciplina (ore, compenso
// dal club, quota campo al club): le tariffe orarie sono per disciplina,
// quindi è lì che i conti si possono verificare. La vista personale
// mostra le stesse tre colonne per le proprie voci, calcolate dalla
// stessa funzione (importiPerEntry), così il maestro e la segretaria
// non possono leggere numeri diversi.
// Richiede firebase-config.js, utils.js e auth.js già caricati.
// ============================================================

let currentProfile = null;
let ultimoTutti = null; // risultato dell'ultimo calcolo admin, per dettaglio/stampa
let ultimoPersonal = null; // { entries } dell'ultimo calcolo personale, per dettaglio/stampa
let ultimoPeriodo = null; // { dal, al } dell'ultimo calcolo

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toISO(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function formatDataBreve(dataStr) {
  const [y, m, d] = dataStr.split("-");
  return `${d}.${m}.${y}`;
}

function currentMonthRange() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return [toISO(first), toISO(last)];
}

function last7DaysRange() {
  const oggi = new Date();
  const settimanaFa = new Date();
  settimanaFa.setDate(oggi.getDate() - 6);
  return [toISO(settimanaFa), toISO(oggi)];
}

// Configurazione che serve sia al calcolo personale sia a quello admin:
// tipi attività, campi e quote campo. Caricata una volta sola da
// calcola() e passata a entrambi — sono le stesse tre collection, e chi
// ha diario:leggi_tutti esegue i due calcoli uno dopo l'altro.
// Tutte e tre sono leggibili da qualsiasi utente loggato (firestore.rules),
// quindi anche un collaboratore senza permessi speciali può calcolarsi
// la propria quota campo e il proprio compenso.
async function loadConfigCalcoli() {
  const [tipiSnap, campiSnap, quoteCampoSnap] = await Promise.all([
    db.collection("tipiAttivita").get(),
    db.collection("campi").get(),
    db.collection("quoteCampo").get()
  ]);

  const tipiById = {};
  tipiSnap.docs.forEach(d => { tipiById[d.id] = { id: d.id, ...d.data() }; });

  const campiById = {};
  campiSnap.docs.forEach(d => {
    const c = d.data();
    campiById[c.disciplina + "|" + c.numero] = c;
  });

  // Le quote disattivate dalla lista in Configurazione sono escluse dal
  // calcolo: finché non lo erano, il pulsante Attivo/Disattivato non
  // aveva alcun effetto e una quota "spenta" continuava ad applicarsi.
  const quoteCampoList = quoteCampoSnap.docs
    .map(d => d.data())
    .filter(q => q.attivo !== false);

  return { tipiById, campiById, quoteCampoList };
}

// Quota campo e compenso di una singola voce di diario. È l'unico punto
// in cui queste due regole sono scritte: la vista personale e quella
// admin lo chiamano entrambe, così i numeri che il maestro vede sul
// proprio telefono e quelli che la segretaria stampa non possono
// divergere.
// L'importo torna null quando la voce *è* soggetta ma la tariffa o la
// quota corrispondente non è configurata: è un errore da segnalare,
// diverso da "non dovuto" (soggettaQuota/retribuita a false).
function importiPerEntry(e, utente, config) {
  const tipo = e.tipoAttivitaId ? config.tipiById[e.tipoAttivitaId] : null;

  const soggettaQuota = !!(utente && utente.soggettoQuotaCampo && tipo && tipo.soggettoQuotaCampo);
  const retribuita = !!(tipo && tipo.retribuitoCollaboratore);
  const tariffaDisciplina = utente && utente.tariffeOrarie ? utente.tariffeOrarie[e.disciplina] : null;

  return {
    tipo,
    soggettaQuota,
    quotaCampo: soggettaQuota ? quotaCampoPerEntry(e, config.campiById, config.quoteCampoList) : null,
    retribuita,
    compenso: retribuita && tariffaDisciplina ? (e.ore || 0) * tariffaDisciplina : null
  };
}

// Somma una voce nella riga della sua disciplina. Conta a parte le voci
// rimaste senza importo: sono quelle da correggere in configurazione, e
// senza questo contatore una disciplina con la tariffa mancante
// mostrerebbe uno zero indistinguibile da un "non dovuto".
function accumulaDisciplina(mappa, e, importi) {
  const id = e.disciplina || "";
  if (!mappa[id]) {
    mappa[id] = { disciplina: id, ore: 0, quotaCampo: 0, compenso: 0, pagatoOnline: 0, vociSenzaQuotaCampo: 0, vociSenzaCompenso: 0 };
  }
  const riga = mappa[id];

  riga.ore += (e.ore || 0);
  if (e.pagamentoOnlineStato === "PAID") riga.pagatoOnline += (e.pagamentoOnlineImporto || 0);

  if (importi.soggettaQuota) {
    if (importi.quotaCampo != null) riga.quotaCampo += importi.quotaCampo;
    else riga.vociSenzaQuotaCampo++;
  }
  if (importi.retribuita) {
    if (importi.compenso != null) riga.compenso += importi.compenso;
    else riga.vociSenzaCompenso++;
  }
  return riga;
}

function sommaRighe(righe, campo) {
  return righe.reduce((s, r) => s + (r[campo] || 0), 0);
}

// Vista personale: le stesse ore di prima, ma ora anche quota campo e
// compenso per disciplina, calcolati con la stessa funzione della vista
// admin. Serve il proprio doc users (tariffe orarie e flag quota campo),
// leggibile dal proprietario.
async function loadPersonal(uid, dal, al, config) {
  const [diarioSnap, userDoc] = await Promise.all([
    db.collection("diario")
      .where("userId", "==", uid)
      .where("data", ">=", dal)
      .where("data", "<=", al)
      .get(),
    db.collection("users").doc(uid).get()
  ]);

  const entries = diarioSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const utente = userDoc.exists ? userDoc.data() : null;

  const mappa = {};
  entries.forEach(e => accumulaDisciplina(mappa, e, importiPerEntry(e, utente, config)));
  const perDisciplina = ordinaPerDisciplina(mappa);

  return {
    totale: entries.reduce((s, e) => s + (e.ore || 0), 0),
    perDisciplina,
    quotaCampo: sommaRighe(perDisciplina, "quotaCampo"),
    compenso: sommaRighe(perDisciplina, "compenso"),
    entries
  };
}

// Tra le tariffe di un tipo attività, trova quella "per tutti" (senza
// tipo utenza specifico, dato che il diario non lo registra più) il
// cui periodo copre la data della voce. Se più tariffe si sovrappongono
// vince quella con periodoInizio più recente.
function prezzoPerData(tipoAttivita, dataStr) {
  if (!tipoAttivita || !Array.isArray(tipoAttivita.prezzi)) return null;

  const candidate = tipoAttivita.prezzi
    .filter(p => !p.tipoUtenzaId)
    .filter(p => !p.periodoInizio || dataStr >= p.periodoInizio)
    .filter(p => !p.periodoFine || dataStr <= p.periodoFine)
    .sort((a, b) => (b.periodoInizio || "").localeCompare(a.periodoInizio || ""))[0];

  return candidate ? candidate.prezzoOra : null;
}

function fasciaOrariaFor(oraInizio) {
  if (!oraInizio) return null;
  return oraInizio < "17:00" ? "prima_17" : "dopo_17";
}

// Trova la quota campo dovuta per una voce diario, incrociando
// disciplina, posizione del campo usato, data (periodo) e — solo per
// il padel — durata effettiva della lezione e fascia oraria.
// IMPOSTAZIONI.festivi (js/utils.js) distingue solo la domenica dai
// festivi infrasettimanali, come richiesto — il sabato resta feriale.
function domenicaOFestivo(dataIso) {
  const giorno = new Date(dataIso + "T00:00:00").getDay();
  return giorno === 0 || (IMPOSTAZIONI.festivi || []).includes(dataIso);
}

function quotaCampoPerEntry(entry, campiById, quoteCampoList) {
  if (!entry.campoNumero) return null;

  const campo = campiById[entry.disciplina + "|" + entry.campoNumero];
  const posizione = campo ? campo.posizione : null;
  const tipoGiorno = domenicaOFestivo(entry.data) ? "domenica_festivo" : "feriale";

  let candidates = quoteCampoList
    .filter(q => q.disciplina === entry.disciplina)
    .filter(q => !q.posizione || q.posizione === posizione)
    .filter(q => !q.tipoGiorno || q.tipoGiorno === tipoGiorno)
    .filter(q => !q.periodoInizio || entry.data >= q.periodoInizio)
    .filter(q => !q.periodoFine || entry.data <= q.periodoFine);

  if (entry.disciplina === "padel") {
    const durataEffettiva = entry.oraInizio && entry.oraFine
      ? Math.round(calcOre(entry.oraInizio, entry.oraFine) * 60)
      : null;
    const fascia = fasciaOrariaFor(entry.oraInizio);
    candidates = candidates
      .filter(q => q.fasciaOraria === fascia)
      .filter(q => durataEffettiva != null && q.durataMinuti === durataEffettiva);
  }

  if (candidates.length === 0) return null;

  // preferisci la quota più specifica: giorno indicato invece di "tutti",
  // poi posizione indicata invece di "tutti", poi il periodo con inizio
  // più recente
  candidates.sort((a, b) => {
    const aGiorno = a.tipoGiorno ? 1 : 0;
    const bGiorno = b.tipoGiorno ? 1 : 0;
    if (aGiorno !== bGiorno) return bGiorno - aGiorno;
    const aSpecific = a.posizione ? 1 : 0;
    const bSpecific = b.posizione ? 1 : 0;
    if (aSpecific !== bSpecific) return bSpecific - aSpecific;
    return (b.periodoInizio || "").localeCompare(a.periodoInizio || "");
  });

  const match = candidates[0];
  return entry.disciplina === "padel" ? match.importo : (entry.ore || 0) * match.importo;
}

async function loadTutti(dal, al, config) {
  const [diarioSnap, usersSnap] = await Promise.all([
    db.collection("diario").where("data", ">=", dal).where("data", "<=", al).get(),
    db.collection("users").get()
  ]);

  const entries = diarioSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const usersById = {};
  usersSnap.docs.forEach(d => { usersById[d.id] = d.data(); });

  const perUtente = {};
  const perTipo = {};
  const perAllievo = {};
  let totaleOre = 0;
  let totaleCosto = 0;
  let totalePagatoOnline = 0;
  let vociSenzaTariffa = 0;

  entries.forEach(e => {
    const ore = e.ore || 0;
    totaleOre += ore;

    if (!perUtente[e.userId]) perUtente[e.userId] = { uid: e.userId, nome: e.userNome || e.userId, totale: 0, quotaCampo: 0, compenso: 0, pagatoOnline: 0, perDisciplina: {}, entries: [] };
    perUtente[e.userId].totale += ore;
    perUtente[e.userId].entries.push(e);

    const importi = importiPerEntry(e, usersById[e.userId], config);

    // Le righe per disciplina sono la base del conteggio: i totali del
    // dipendente sono la loro somma (vedi sotto), così quello che si
    // legge riga per riga torna col totale per costruzione, invece di
    // essere una seconda somma che potrebbe divergere.
    accumulaDisciplina(perUtente[e.userId].perDisciplina, e, importi);

    if (e.pagamentoOnlineStato === "PAID") totalePagatoOnline += (e.pagamentoOnlineImporto || 0);

    const tipoKey = (e.tipoAttivitaId || ("legacy:" + (e.tipoAttivita || "altro"))) + "|" + (e.disciplina || "");
    if (!perTipo[tipoKey]) perTipo[tipoKey] = { nome: tipoAttivitaLabelFor(e), disciplina: e.disciplina, ore: 0, costo: 0 };
    perTipo[tipoKey].ore += ore;

    // Lezioni di gruppo: più allievi sulla stessa voce (allievoIds), tutti
    // presenti per l'intera durata — ognuno riceve le stesse ore. Le voci
    // storiche hanno solo il singolare allievoId/allievoNome.
    const idsAllievo = Array.isArray(e.allievoIds) && e.allievoIds.length > 0
      ? e.allievoIds
      : (e.allievoId ? [e.allievoId] : []);
    const nomiAllievoArr = Array.isArray(e.allievoNomi) && e.allievoNomi.length > 0
      ? e.allievoNomi
      : (e.allievoNome ? [e.allievoNome] : []);
    idsAllievo.forEach((aid, i) => {
      const nome = (nomiAllievoArr[i] || aid || "").toString();
      // Raggruppato per nome normalizzato, non per allievoId: la stessa
      // persona può avere più record "allievi" (creati al volo dal
      // diario se il nome non trovava una corrispondenza esatta, es.
      // maiuscole/spazi diversi) — senza questo, lo stesso allievo
      // comparirebbe come righe separate invece di una sola con le ore
      // sommate. "aid" resta il nome normalizzato: usato solo come chiave
      // opaca per data-aid/toggle/stampa qui sotto, mai come vero id
      // Firestore — niente spazi (finiscono anche in un id HTML, dove
      // uno spazio letterale non è valido anche se i browser lo tollerano).
      const chiave = nome.trim().toLowerCase().replace(/\s+/g, "-");
      if (!perAllievo[chiave]) perAllievo[chiave] = { aid: chiave, nome: nome.trim(), totale: 0, entries: [] };
      perAllievo[chiave].totale += ore;
      perAllievo[chiave].entries.push(e);
    });

    const prezzoOra = prezzoPerData(importi.tipo, e.data);
    if (prezzoOra != null) {
      const costo = ore * prezzoOra;
      perTipo[tipoKey].costo += costo;
      totaleCosto += costo;
    } else {
      vociSenzaTariffa++;
    }

  });

  // Totali del dipendente ricavati dalle sue righe per disciplina, non
  // accumulati a parte: è ciò che rende impossibile una scheda in cui le
  // righe non tornano col totale.
  const perDipendente = Object.values(perUtente).map(u => {
    const perDisciplina = ordinaPerDisciplina(u.perDisciplina);
    return {
      ...u,
      perDisciplina,
      quotaCampo: sommaRighe(perDisciplina, "quotaCampo"),
      compenso: sommaRighe(perDisciplina, "compenso"),
      pagatoOnline: sommaRighe(perDisciplina, "pagatoOnline"),
      vociSenzaQuotaCampo: sommaRighe(perDisciplina, "vociSenzaQuotaCampo"),
      vociSenzaCompenso: sommaRighe(perDisciplina, "vociSenzaCompenso")
    };
  }).sort((a, b) => b.totale - a.totale);

  const totaleQuotaCampo = sommaRighe(perDipendente, "quotaCampo");
  const totaleCompenso = sommaRighe(perDipendente, "compenso");
  const vociSenzaQuotaCampo = sommaRighe(perDipendente, "vociSenzaQuotaCampo");
  const vociSenzaCompenso = sommaRighe(perDipendente, "vociSenzaCompenso");

  return {
    perDipendente,
    perTipoAttivita: Object.values(perTipo).sort((a, b) => b.ore - a.ore),
    perAllievo: Object.values(perAllievo).sort((a, b) => a.nome.localeCompare(b.nome)),
    totaleOre,
    totaleCosto,
    totaleQuotaCampo,
    totaleCompenso,
    totalePagatoOnline,
    vociSenzaTariffa,
    vociSenzaQuotaCampo,
    vociSenzaCompenso
  };
}

// Ore per disciplina ricavate dalle sole voci: la vista personale e
// quella per allievo non passano da loadTutti, quindi non hanno importi
// da mostrare — bastano le ore per il riepilogo in testa alla stampa.
function perDisciplinaDaEntries(entries) {
  const mappa = {};
  (entries || []).forEach(en => {
    const id = en.disciplina || "";
    if (!mappa[id]) mappa[id] = { disciplina: id, ore: 0, quotaCampo: 0, compenso: 0, pagatoOnline: 0, vociSenzaQuotaCampo: 0, vociSenzaCompenso: 0 };
    mappa[id].ore += (en.ore || 0);
  });
  return ordinaPerDisciplina(mappa);
}

// Le righe per disciplina seguono lo stesso ordine di DISCIPLINE
// (configurabile), non l'ordine casuale in cui compaiono le voci: così
// un maestro ritrova sempre le sue discipline nella stessa posizione da
// un periodo all'altro. Le discipline non più configurate finiscono in
// fondo invece di sparire — le ore storiche vanno comunque mostrate.
function ordinaPerDisciplina(mappa) {
  const ordine = DISCIPLINE.map(d => d.id);
  const rango = id => {
    const i = ordine.indexOf(id);
    return i === -1 ? ordine.length : i;
  };
  return Object.values(mappa).sort((a, b) => rango(a.disciplina) - rango(b.disciplina));
}

// Tabella per disciplina, usata sia nella scheda del dipendente (vista
// admin) sia in cima alla vista personale del collaboratore: stessi
// numeri, stesso ordine di colonne, così chi guarda i due schermi non
// deve reinterpretare nulla.
// Le colonne di denaro sono etichettate in modo esplicito ("dal club" /
// "al club") invece che dal punto di vista di chi legge: la stessa riga
// la guardano il maestro e la segretaria, e un "da ricevere" per l'uno
// è un "da pagare" per l'altra.
function disciplineTableHtml(dip, opts = {}) {
  const righe = dip.perDisciplina || [];
  if (righe.length === 0) return "";

  // Le colonne compaiono se la persona è soggetta a quota campo o
  // compenso, anche quando l'importo non si è potuto calcolare: è
  // proprio il caso da mostrare, non da nascondere.
  const mostraImporti = righe.some(r =>
    r.quotaCampo > 0 || r.compenso > 0 || r.vociSenzaQuotaCampo > 0 || r.vociSenzaCompenso > 0);

  const cella = (valore, mancanti, motivo) => {
    const testo = valore > 0 ? "CHF " + valore.toFixed(2) : "—";
    if (!mancanti) return testo;
    return `${testo}<div class="cella-nota">${mancanti} ${mancanti === 1 ? "voce" : "voci"} ${motivo}</div>`;
  };
  const cellaCompenso = r => cella(r.compenso, r.vociSenzaCompenso, "senza tariffa oraria");
  const cellaQuota = r => cella(r.quotaCampo, r.vociSenzaQuotaCampo, "senza quota configurata");

  const totali = {
    compenso: sommaRighe(righe, "compenso"),
    quotaCampo: sommaRighe(righe, "quotaCampo"),
    vociSenzaCompenso: sommaRighe(righe, "vociSenzaCompenso"),
    vociSenzaQuotaCampo: sommaRighe(righe, "vociSenzaQuotaCampo")
  };

  return `
    <div class="${opts.wrapperClass || "dipendente-discipline"}">
      <table class="app-table">
        <thead>
          <tr>
            <th>Disciplina</th>
            <th>Ore</th>
            ${mostraImporti ? "<th>Compenso dal club</th><th>Quota campo al club</th>" : ""}
          </tr>
        </thead>
        <tbody>
          ${righe.map(r => `
            <tr>
              <td><span class="badge ${escapeHtml(r.disciplina)}">${escapeHtml(disciplinaLabel(r.disciplina) || "—")}</span></td>
              <td>${r.ore.toFixed(1)}h</td>
              ${mostraImporti ? `<td>${cellaCompenso(r)}</td><td>${cellaQuota(r)}</td>` : ""}
            </tr>
          `).join("")}
        </tbody>
        <tfoot>
          <tr>
            <td><strong>Totale</strong></td>
            <td><strong>${sommaRighe(righe, "ore").toFixed(1)}h</strong></td>
            ${mostraImporti ? `<td><strong>${cellaCompenso(totali)}</strong></td><td><strong>${cellaQuota(totali)}</strong></td>` : ""}
          </tr>
        </tfoot>
      </table>
    </div>
  `;
}

function renderDipendenti(lista) {
  const el = document.getElementById("dipendenti-list");

  if (lista.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="display">Nessuna voce nel periodo</div></div>`;
    return;
  }

  el.innerHTML = lista.map(d => `
    <div class="dipendente-block" data-uid="${d.uid}">
      <div class="entry-card">
        <div class="entry-main">
          <div class="entry-tipo">${escapeHtml(d.nome)}</div>
          ${d.pagatoOnline > 0 ? `<div style="margin-top:6px;"><span class="chip-audit approvato">Incassato online CHF ${d.pagatoOnline.toFixed(2)}</span></div>` : ""}
        </div>
        <div class="entry-ore">${d.totale.toFixed(1)}h</div>
      </div>
      ${disciplineTableHtml(d)}
      <div class="dipendente-actions">
        <button type="button" class="btn btn-ghost toggle-dettaglio-btn" data-uid="${d.uid}">Dettaglio</button>
        <button type="button" class="btn btn-ghost stampa-btn" data-uid="${d.uid}">Stampa / PDF</button>
      </div>
      <div class="dettaglio-giorni hidden" id="dettaglio-${d.uid}"></div>
    </div>
  `).join("");

  el.querySelectorAll(".toggle-dettaglio-btn").forEach(btn => {
    btn.addEventListener("click", () => toggleDettaglioDipendente(btn.dataset.uid));
  });
  el.querySelectorAll(".stampa-btn").forEach(btn => {
    btn.addEventListener("click", () => stampaReportDipendente(btn.dataset.uid));
  });
}

function renderAllievi(lista) {
  const el = document.getElementById("allievi-list-report");

  if (lista.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="display">Nessun allievo nel periodo</div></div>`;
    return;
  }

  el.innerHTML = lista.map(a => `
    <div class="allievo-block" data-aid="${a.aid}">
      <button type="button" class="allievo-row toggle-dettaglio-allievo-btn" data-aid="${a.aid}" aria-expanded="false">
        <span class="allievo-nome">${escapeHtml(a.nome)}</span>
        <span class="allievo-ore">${a.totale.toFixed(1)}h</span>
        <span class="allievo-toggle-icon">+</span>
      </button>
      <div class="dettaglio-giorni hidden" id="dettaglio-allievo-${a.aid}"></div>
    </div>
  `).join("");

  el.querySelectorAll(".toggle-dettaglio-allievo-btn").forEach(btn => {
    btn.addEventListener("click", () => toggleDettaglioAllievo(btn.dataset.aid));
  });
}

// Filtra perAllievo per nome (case-insensitive) in base al campo ricerca
// e ridisegna la lista — puramente client-side, i dati sono già in memoria.
function filtraERenderAllievi() {
  const tutti = (ultimoTutti && ultimoTutti.perAllievo) || [];
  const query = document.getElementById("allievi-search-input").value.trim().toLowerCase();
  const filtrati = query ? tutti.filter(a => a.nome.toLowerCase().includes(query)) : tutti;
  renderAllievi(filtrati);
}

function toggleDettaglioAllievo(aid) {
  const container = document.getElementById(`dettaglio-allievo-${aid}`);
  const row = document.querySelector(`.toggle-dettaglio-allievo-btn[data-aid="${aid}"]`);
  const icon = row ? row.querySelector(".allievo-toggle-icon") : null;
  if (!container) return;

  if (!container.classList.contains("hidden")) {
    container.classList.add("hidden");
    if (row) row.setAttribute("aria-expanded", "false");
    if (icon) icon.textContent = "+";
    return;
  }

  const allievo = (ultimoTutti.perAllievo || []).find(a => a.aid === aid);
  container.innerHTML = `
    <button type="button" class="btn btn-ghost stampa-allievo-btn" data-aid="${aid}" style="margin-bottom:10px;">Stampa / PDF</button>
    ${renderDettaglioGiorniHtml(allievo, { mostraMaestro: true })}
  `;
  container.querySelector(".stampa-allievo-btn").addEventListener("click", () => stampaReportAllievo(aid));
  container.querySelectorAll(".delete-diario-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Eliminare questa voce? L'operazione non è reversibile.")) return;
      btn.disabled = true;
      try {
        await db.collection("diario").doc(btn.dataset.id).delete();
        await calcola();
      } catch (err) {
        showError(document.getElementById("resoconto-error"), "Errore nell'eliminazione: " + err.message);
        btn.disabled = false;
      }
    });
  });
  container.classList.remove("hidden");
  if (row) row.setAttribute("aria-expanded", "true");
  if (icon) icon.textContent = "−";
}

function stampaReportAllievo(aid) {
  const allievo = (ultimoTutti.perAllievo || []).find(a => a.aid === aid);
  if (!allievo) return;
  stampaReport({ nome: allievo.nome, entries: allievo.entries, totale: allievo.totale, quotaCampo: 0, compenso: 0, perDisciplina: perDisciplinaDaEntries(allievo.entries) });
}

// Raggruppa le voci di un dipendente per data (più recente prima), con
// un mini-totale per giorno, riusando lo stesso stile card del diario.
function renderDettaglioGiorniHtml(dipendente, opts = {}) {
  if (!dipendente || dipendente.entries.length === 0) {
    return `<div class="empty-state"><div class="display">Nessuna voce</div></div>`;
  }

  const perGiorno = {};
  dipendente.entries.forEach(en => {
    if (!perGiorno[en.data]) perGiorno[en.data] = [];
    perGiorno[en.data].push(en);
  });

  const giorni = Object.keys(perGiorno).sort().reverse();

  return giorni.map(data => {
    const entries = perGiorno[data];
    const totaleGiorno = entries.reduce((s, en) => s + (en.ore || 0), 0);
    return `
      <div class="row-label">${formatDataBreve(data)} · ${totaleGiorno.toFixed(1)}h</div>
      ${entries.map(en => entryRowHtml(en, opts)).join("")}
    `;
  }).join("");
}

function entryRowHtml(en, opts = {}) {
  const metaParts = [];
  if (en.campoNumero) metaParts.push("Campo " + en.campoNumero);
  if (en.tipoGruppoNome) metaParts.push(en.tipoGruppoNome);
  if (nomiAllievi(en)) metaParts.push("Allievo: " + nomiAllievi(en));
  if (opts.mostraMaestro && en.userNome) metaParts.push("Maestro: " + en.userNome);
  if (en.oraInizio || en.oraFine) metaParts.push(`${en.oraInizio || "—"}–${en.oraFine || "—"}`);
  if (en.note) metaParts.push(en.note);

  return `
    <div class="entry-card">
      <div class="entry-main">
        <span class="badge ${en.disciplina}">${disciplinaLabel(en.disciplina)}</span>
        <div class="entry-tipo">${escapeHtml(tipoAttivitaLabelFor(en))}</div>
        <div class="entry-meta">${escapeHtml(metaParts.join(" · "))}</div>
        ${en.pagamentoOnlineStato === "PAID" ? `<div style="margin-top:6px;"><span class="chip-audit approvato">Pagato online CHF ${(en.pagamentoOnlineImporto || 0).toFixed(2)}</span></div>` : ""}
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
        <div class="entry-ore">${(en.ore || 0).toFixed(1)}h</div>
        ${puoEliminareVoceDiario(en, currentProfile) ? `<button type="button" class="btn btn-danger delete-diario-btn" style="width:auto;padding:6px 10px;font-size:0.65rem;" data-id="${en.id}">Elimina</button>` : ""}
      </div>
    </div>
  `;
}

function toggleDettaglioDipendente(uid) {
  const container = document.getElementById(`dettaglio-${uid}`);
  if (!container) return;

  if (!container.classList.contains("hidden")) {
    container.classList.add("hidden");
    return;
  }

  const dipendente = (ultimoTutti.perDipendente || []).find(d => d.uid === uid);
  container.innerHTML = renderDettaglioGiorniHtml(dipendente);
  container.querySelectorAll(".delete-diario-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Eliminare questa voce? L'operazione non è reversibile.")) return;
      btn.disabled = true;
      try {
        await db.collection("diario").doc(btn.dataset.id).delete();
        await calcola();
      } catch (err) {
        showError(document.getElementById("resoconto-error"), "Errore nell'eliminazione: " + err.message);
        btn.disabled = false;
      }
    });
  });
  container.classList.remove("hidden");
}

// Riepilogo per disciplina in testa alla stampa: è la parte che il
// maestro si porta via e su cui fa il controllo. Le colonne di denaro
// compaiono solo se ci sono importi — nel report personale il
// collaboratore ha solo le ore, quota campo e compenso li calcola la
// vista admin.
function riepilogoDisciplineStampaHtml(perDisciplina) {
  if (!perDisciplina || perDisciplina.length === 0) return "";

  const mostraImporti = perDisciplina.some(r =>
    r.compenso > 0 || r.quotaCampo > 0 || r.vociSenzaCompenso > 0 || r.vociSenzaQuotaCampo > 0);
  const totali = {
    ore: sommaRighe(perDisciplina, "ore"),
    compenso: sommaRighe(perDisciplina, "compenso"),
    quotaCampo: sommaRighe(perDisciplina, "quotaCampo"),
    vociSenzaCompenso: sommaRighe(perDisciplina, "vociSenzaCompenso"),
    vociSenzaQuotaCampo: sommaRighe(perDisciplina, "vociSenzaQuotaCampo")
  };

  // Le voci senza importo restano scritte accanto al numero anche sul
  // cartaceo: è la copia su cui maestro e segretaria si confrontano, e
  // un totale più basso del dovuto senza spiegazione è peggio di un
  // totale con la riga da sistemare indicata.
  const cella = (valore, mancanti) => {
    const testo = valore > 0 ? valore.toFixed(2) : "—";
    return mancanti ? `${testo} (${mancanti} da sistemare)` : testo;
  };

  return `
    <h2>Riepilogo per disciplina</h2>
    <table>
      <thead>
        <tr>
          <th>Disciplina</th>
          <th>Ore</th>
          ${mostraImporti ? "<th>Compenso dal club (CHF)</th><th>Quota campo al club (CHF)</th>" : ""}
        </tr>
      </thead>
      <tbody>
        ${perDisciplina.map(r => `
          <tr>
            <td>${escapeHtml(disciplinaLabel(r.disciplina) || "—")}</td>
            <td>${r.ore.toFixed(2)}</td>
            ${mostraImporti ? `<td>${cella(r.compenso, r.vociSenzaCompenso)}</td><td>${cella(r.quotaCampo, r.vociSenzaQuotaCampo)}</td>` : ""}
          </tr>
        `).join("")}
      </tbody>
      <tfoot>
        <tr>
          <th>Totale</th>
          <th>${totali.ore.toFixed(2)}</th>
          ${mostraImporti ? `<th>${cella(totali.compenso, totali.vociSenzaCompenso)}</th><th>${cella(totali.quotaCampo, totali.vociSenzaQuotaCampo)}</th>` : ""}
        </tr>
      </tfoot>
    </table>
  `;
}

// Tabella di stampa condivisa tra il report di un singolo dipendente
// (vista admin) e il report personale (vista collaboratore).
function stampaReport({ nome, entries, totale, quotaCampo, compenso, pagatoOnline, perDisciplina }) {
  const perGiorno = {};
  entries.forEach(en => {
    if (!perGiorno[en.data]) perGiorno[en.data] = [];
    perGiorno[en.data].push(en);
  });
  const giorni = Object.keys(perGiorno).sort();

  const righe = giorni.flatMap(data =>
    perGiorno[data].map(en => `
      <tr>
        <td>${formatDataBreve(data)}</td>
        <td>${escapeHtml(disciplinaLabel(en.disciplina))}</td>
        <td>${escapeHtml(tipoAttivitaLabelFor(en))}</td>
        <td>${en.campoNumero ? escapeHtml(String(en.campoNumero)) : "—"}</td>
        <td>${escapeHtml(nomiAllievi(en) || "—")}</td>
        <td>${en.oraInizio || "—"}–${en.oraFine || "—"}</td>
        <td>${(en.ore || 0).toFixed(2)}</td>
        <td>${en.pagamentoOnlineStato === "PAID" ? "CHF " + (en.pagamentoOnlineImporto || 0).toFixed(2) : "—"}</td>
        <td>${escapeHtml(en.note || "")}</td>
      </tr>
    `)
  ).join("");

  const totaliParts = [`<p><strong>Totale ore:</strong> ${totale.toFixed(2)}</p>`];
  if (quotaCampo > 0) totaliParts.push(`<p><strong>Quota campo al club:</strong> CHF ${quotaCampo.toFixed(2)}</p>`);
  if (compenso > 0) totaliParts.push(`<p><strong>Compenso dal club:</strong> CHF ${compenso.toFixed(2)}</p>`);
  if (pagatoOnline > 0) totaliParts.push(`<p><strong>Pagato online dai clienti:</strong> CHF ${pagatoOnline.toFixed(2)}</p>`);

  document.getElementById("print-area").innerHTML = `
    <h1>${escapeHtml(nome)}</h1>
    <p>Periodo: ${formatDataBreve(ultimoPeriodo.dal)} – ${formatDataBreve(ultimoPeriodo.al)}</p>
    ${riepilogoDisciplineStampaHtml(perDisciplina)}
    <h2>Dettaglio</h2>
    <table>
      <thead>
        <tr><th>Data</th><th>Disciplina</th><th>Tipo attività</th><th>Campo</th><th>Allievo</th><th>Orario</th><th>Ore</th><th>Pagato online</th><th>Note</th></tr>
      </thead>
      <tbody>${righe}</tbody>
    </table>
    ${totaliParts.join("")}
  `;

  window.print();
}

function stampaReportDipendente(uid) {
  const dipendente = (ultimoTutti.perDipendente || []).find(d => d.uid === uid);
  if (!dipendente) return;
  stampaReport({ nome: dipendente.nome, entries: dipendente.entries, totale: dipendente.totale, quotaCampo: dipendente.quotaCampo, compenso: dipendente.compenso, pagatoOnline: dipendente.pagatoOnline, perDisciplina: dipendente.perDisciplina });
}

function stampaReportPersonale() {
  if (!ultimoPersonal) return;
  stampaReport({
    nome: currentProfile.nome,
    entries: ultimoPersonal.entries,
    totale: ultimoPersonal.totale,
    quotaCampo: ultimoPersonal.quotaCampo,
    compenso: ultimoPersonal.compenso,
    perDisciplina: ultimoPersonal.perDisciplina
  });
}

function togglePersonalDettaglio() {
  const container = document.getElementById("personal-dettaglio");
  if (!container || !ultimoPersonal) return;

  if (!container.classList.contains("hidden")) {
    container.classList.add("hidden");
    return;
  }

  container.innerHTML = renderDettaglioGiorniHtml(ultimoPersonal);
  container.querySelectorAll(".delete-diario-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Eliminare questa voce? L'operazione non è reversibile.")) return;
      btn.disabled = true;
      try {
        await db.collection("diario").doc(btn.dataset.id).delete();
        await calcola();
      } catch (err) {
        showError(document.getElementById("resoconto-error"), "Errore nell'eliminazione: " + err.message);
        btn.disabled = false;
      }
    });
  });
  container.classList.remove("hidden");
}

// Tabella consolidata pensata per segretaria/contabile: un colpo
// d'occhio su ore, quanto retribuire e quanto ricevere per ciascun
// dipendente, con totali di riga.
function renderRiepilogoContabilita(lista) {
  const el = document.getElementById("riepilogo-contabilita-table");

  if (lista.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="display">Nessuna voce nel periodo</div></div>`;
    return;
  }

  const totOre = lista.reduce((s, d) => s + d.totale, 0);
  const totCompenso = lista.reduce((s, d) => s + d.compenso, 0);
  const totQuota = lista.reduce((s, d) => s + d.quotaCampo, 0);
  const totOnline = lista.reduce((s, d) => s + d.pagatoOnline, 0);

  el.innerHTML = `
    <table class="app-table">
      <thead>
        <tr><th>Dipendente</th><th>Ore</th><th>Compenso dal club</th><th>Quota campo al club</th><th>Pagato online</th></tr>
      </thead>
      <tbody>
        ${lista.map(d => `
          <tr>
            <td>${escapeHtml(d.nome)}</td>
            <td>${d.totale.toFixed(1)}h</td>
            <td>${d.compenso > 0 ? "CHF " + d.compenso.toFixed(2) : "—"}</td>
            <td>${d.quotaCampo > 0 ? "CHF " + d.quotaCampo.toFixed(2) : "—"}</td>
            <td>${d.pagatoOnline > 0 ? `<span class="chip-audit approvato">Incassato online CHF ${d.pagatoOnline.toFixed(2)}</span>` : "—"}</td>
          </tr>
        `).join("")}
      </tbody>
      <tfoot>
        <tr>
          <td><strong>Totale</strong></td>
          <td><strong>${totOre.toFixed(1)}h</strong></td>
          <td><strong>CHF ${totCompenso.toFixed(2)}</strong></td>
          <td><strong>CHF ${totQuota.toFixed(2)}</strong></td>
          <td><strong>CHF ${totOnline.toFixed(2)}</strong></td>
        </tr>
      </tfoot>
    </table>
  `;
}

function stampaRiepilogoCompleto() {
  if (!ultimoTutti || !ultimoTutti.perDipendente) return;
  const lista = ultimoTutti.perDipendente;

  // Riga del dipendente col totale, poi una sotto-riga per disciplina:
  // in un unico PDF la segretaria ha sia il colpo d'occhio sia il
  // dettaglio con cui verificare ore × tariffa, senza stampare il report
  // di ogni maestro uno per uno.
  const importo = v => (v > 0 ? v.toFixed(2) : "—");
  const cella = (valore, mancanti) => (mancanti ? `${importo(valore)} (${mancanti} da sistemare)` : importo(valore));
  const righe = lista.map(d => `
    <tr>
      <td><strong>${escapeHtml(d.nome)}</strong></td>
      <td><strong>${d.totale.toFixed(2)}</strong></td>
      <td><strong>${importo(d.compenso)}</strong></td>
      <td><strong>${importo(d.quotaCampo)}</strong></td>
      <td><strong>${importo(d.pagatoOnline)}</strong></td>
    </tr>
    ${(d.perDisciplina || []).map(r => `
      <tr>
        <td style="padding-left:22px;">${escapeHtml(disciplinaLabel(r.disciplina) || "—")}</td>
        <td>${r.ore.toFixed(2)}</td>
        <td>${cella(r.compenso, r.vociSenzaCompenso)}</td>
        <td>${cella(r.quotaCampo, r.vociSenzaQuotaCampo)}</td>
        <td>${importo(r.pagatoOnline)}</td>
      </tr>
    `).join("")}
    <tr class="spacer"><td colspan="5"></td></tr>
  `).join("");

  const totOre = lista.reduce((s, d) => s + d.totale, 0);
  const totCompenso = lista.reduce((s, d) => s + d.compenso, 0);
  const totQuota = lista.reduce((s, d) => s + d.quotaCampo, 0);
  const totOnline = lista.reduce((s, d) => s + d.pagatoOnline, 0);

  document.getElementById("print-area").innerHTML = `
    <h1>Riepilogo complessivo dipendenti</h1>
    <p>Periodo: ${formatDataBreve(ultimoPeriodo.dal)} – ${formatDataBreve(ultimoPeriodo.al)}</p>
    <table>
      <thead>
        <tr><th>Dipendente / disciplina</th><th>Ore</th><th>Compenso dal club (CHF)</th><th>Quota campo al club (CHF)</th><th>Pagato online (CHF)</th></tr>
      </thead>
      <tbody>${righe}</tbody>
      <tfoot>
        <tr>
          <th>Totale</th>
          <th>${totOre.toFixed(2)}</th>
          <th>${totCompenso.toFixed(2)}</th>
          <th>${totQuota.toFixed(2)}</th>
          <th>${totOnline.toFixed(2)}</th>
        </tr>
      </tfoot>
    </table>
  `;

  window.print();
}

// Listato compatto (nome + ore) di tutti gli allievi correntemente
// mostrati (rispetta il filtro di ricerca), per stampa/PDF — separato
// dallo stampa-singolo-allievo, che porta invece il dettaglio giorno per
// giorno di un solo allievo.
function stampaListaAllievi() {
  const query = document.getElementById("allievi-search-input").value.trim().toLowerCase();
  const tutti = (ultimoTutti && ultimoTutti.perAllievo) || [];
  const lista = query ? tutti.filter(a => a.nome.toLowerCase().includes(query)) : tutti;
  if (lista.length === 0) return;

  const righe = lista.map(a => `
    <tr>
      <td>${escapeHtml(a.nome)}</td>
      <td>${a.totale.toFixed(2)}</td>
    </tr>
  `).join("");

  const totOre = lista.reduce((s, a) => s + a.totale, 0);

  document.getElementById("print-area").innerHTML = `
    <h1>Lista allievi</h1>
    <p>Periodo: ${formatDataBreve(ultimoPeriodo.dal)} – ${formatDataBreve(ultimoPeriodo.al)}</p>
    <table>
      <thead><tr><th>Allievo</th><th>Ore</th></tr></thead>
      <tbody>${righe}</tbody>
      <tfoot><tr><th>Totale</th><th>${totOre.toFixed(2)}</th></tr></tfoot>
    </table>
  `;

  window.print();
}

function renderPerTipoAttivita(lista) {
  const el = document.getElementById("tipoattivita-list");

  if (lista.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="display">Nessuna voce nel periodo</div></div>`;
    return;
  }

  el.innerHTML = lista.map(t => `
    <div class="entry-card">
      <div class="entry-main">
        <span class="badge ${t.disciplina}">${escapeHtml(disciplinaLabel(t.disciplina))}</span>
        <div class="entry-tipo">${escapeHtml(t.nome)}</div>
        <div class="entry-meta">${t.ore.toFixed(1)}h</div>
      </div>
      <div class="entry-ore">CHF ${t.costo.toFixed(2)}</div>
    </div>
  `).join("");
}

async function calcola() {
  const dal = document.getElementById("dal").value;
  const al = document.getElementById("al").value;
  const btn = document.getElementById("calcola-btn");
  const errorEl = document.getElementById("resoconto-error");
  errorEl.innerHTML = "";
  btn.disabled = true;
  btn.textContent = "Calcolo…";

  try {
    ultimoPeriodo = { dal, al };

    // Una sola lettura di tipi attività/campi/quote campo per entrambi i
    // calcoli: chi ha diario:leggi_tutti li esegue tutti e due di fila.
    const config = await loadConfigCalcoli();

    const personal = await loadPersonal(currentProfile.uid, dal, al, config);
    ultimoPersonal = personal;
    document.getElementById("totale-ore").innerHTML = `${personal.totale.toFixed(1)}<small>h</small>`;
    document.getElementById("disciplina-breakdown").innerHTML =
      disciplineTableHtml(personal, { wrapperClass: "tabella-discipline" });

    const personalDettaglioEl = document.getElementById("personal-dettaglio");
    personalDettaglioEl.innerHTML = "";
    personalDettaglioEl.classList.add("hidden");

    if (hasPermission(currentProfile, "diario:leggi_tutti")) {
      const tutti = await loadTutti(dal, al, config);
      ultimoTutti = tutti;
      renderDipendenti(tutti.perDipendente);
      renderRiepilogoContabilita(tutti.perDipendente);
      renderPerTipoAttivita(tutti.perTipoAttivita);
      filtraERenderAllievi();

      document.getElementById("totale-complessivo-ore").innerHTML = `${tutti.totaleOre.toFixed(1)}<small>h</small>`;
      document.getElementById("totale-complessivo-costo").textContent = `CHF ${tutti.totaleCosto.toFixed(2)}`;
      document.getElementById("totale-quotacampo").textContent = `CHF ${tutti.totaleQuotaCampo.toFixed(2)}`;
      document.getElementById("totale-compenso").textContent = `CHF ${tutti.totaleCompenso.toFixed(2)}`;
      document.getElementById("totale-pagato-online").textContent = `CHF ${tutti.totalePagatoOnline.toFixed(2)}`;

      const warningEl = document.getElementById("tariffe-warning");
      warningEl.textContent = tutti.vociSenzaTariffa > 0
        ? `${tutti.vociSenzaTariffa} voci senza tariffa configurata (escluse dal totale costi).`
        : "";

      const quotaWarningEl = document.getElementById("quotacampo-warning");
      quotaWarningEl.textContent = tutti.vociSenzaQuotaCampo > 0
        ? `${tutti.vociSenzaQuotaCampo} voci soggette a quota campo ma senza tariffa corrispondente (escluse dal totale).`
        : "";

      const compensoWarningEl = document.getElementById("compenso-warning");
      compensoWarningEl.textContent = tutti.vociSenzaCompenso > 0
        ? `${tutti.vociSenzaCompenso} voci retribuibili ma senza tariffa oraria impostata sul collaboratore per quella disciplina (escluse dal totale).`
        : "";
    }
  } catch (err) {
    showError(errorEl, "Errore nel calcolo: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Calcola";
  }
}

requireAuth(async (profile) => {
  currentProfile = profile;
  document.getElementById("user-chip").textContent = profile.nome + (profile.ruoloNome ? " · " + profile.ruoloNome : "");

  const [dal, al] = currentMonthRange();
  document.getElementById("dal").value = dal;
  document.getElementById("al").value = al;

  if (hasPermission(profile, "diario:leggi_tutti")) {
    document.getElementById("admin-section").classList.remove("hidden");
    document.getElementById("totale-label").textContent = "Le tue ore nel periodo";
  }

  document.getElementById("period-form").addEventListener("submit", (e) => {
    e.preventDefault();
    calcola();
  });

  document.getElementById("personal-dettaglio-btn").addEventListener("click", togglePersonalDettaglio);
  document.getElementById("personal-stampa-btn").addEventListener("click", stampaReportPersonale);

  document.getElementById("preset-7giorni").addEventListener("click", () => {
    const [d, a] = last7DaysRange();
    document.getElementById("dal").value = d;
    document.getElementById("al").value = a;
    calcola();
  });

  document.getElementById("preset-mese-corrente").addEventListener("click", () => {
    const [d, a] = currentMonthRange();
    document.getElementById("dal").value = d;
    document.getElementById("al").value = a;
    calcola();
  });

  document.getElementById("stampa-tutti-btn").addEventListener("click", stampaRiepilogoCompleto);
  document.getElementById("allievi-search-input").addEventListener("input", filtraERenderAllievi);
  document.getElementById("stampa-lista-allievi-btn").addEventListener("click", stampaListaAllievi);

  await loadDiscipline();
  await loadImpostazioni();
  calcola();
});

document.getElementById("logout-link").addEventListener("click", (e) => {
  e.preventDefault();
  logout();
});

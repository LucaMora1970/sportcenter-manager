// ============================================================
// chi-in-campo.js — vista sociale di sola lettura: chi sta giocando ora
// e più tardi oggi, su tutti gli sport (tennis, squash, padel). Non serve
// a scegliere un campo (per quello c'è prenota-campo.html/prenota-padel.html),
// solo a "vedere chi c'è" — Layout 1 scelto esplicitamente: "in campo ora"
// in evidenza, resto della giornata secondario.
//
// I nominativi sono visibili SOLO se questo dispositivo è già riconosciuto
// (firebase.auth().currentUser esiste): la lista base di "bookings" resta
// pubblica e senza nomi come sempre (vedi firestore.rules), i nomi
// arrivano dalla funzione dettagliGiocatori, che applica lei stessa il
// controllo "dispositivo riconosciuto" — chi non lo è vede solo "Occupato".
//
// Richiede firebase-config.js e utils.js già caricati.
// ============================================================

function oraLocaleZurigo() {
  const parti = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Zurich",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
    }).formatToParts(new Date()).map(p => [p.type, p.value])
  );
  return { dataIso: `${parti.year}-${parti.month}-${parti.day}`, minuti: parseInt(parti.hour, 10) * 60 + parseInt(parti.minute, 10) };
}
function orarioToMin(orario) {
  const [h, m] = orario.split(":").map(Number);
  return h * 60 + m;
}

const DISCIPLINE_PILLS = [
  { id: "", nome: "Tutti" },
  { id: "tennis", nome: "Tennis" },
  { id: "squash", nome: "Squash" },
  { id: "padel", nome: "Padel" }
];

let CAMPI_BY_ID = {}; // id -> {numero, disciplina, posizione}
let filtroDisciplina = "";

function renderPills() {
  const el = document.getElementById("cic-pills");
  el.innerHTML = DISCIPLINE_PILLS.map(d => `
    <button type="button" data-id="${d.id}" aria-pressed="${d.id === filtroDisciplina}">${escapeHtml(d.nome)}</button>
  `).join("");
  el.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => {
      filtroDisciplina = btn.dataset.id;
      el.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.id === filtroDisciplina)));
      caricaERenderizza();
    });
  });
}

function campoLabelDa(courtId) {
  const c = CAMPI_BY_ID[courtId];
  if (!c) return `Campo ${courtId}`;
  const disc = { tennis: "Tennis", squash: "Squash", padel: "Padel" }[c.disciplina] || c.disciplina;
  return `${disc} · Campo ${c.numero}`;
}

async function caricaERenderizza() {
  const listEl = document.getElementById("cic-list");
  listEl.innerHTML = `<div class="empty-state"><div class="display">Caricamento…</div></div>`;

  const ora = oraLocaleZurigo();
  const courtIds = filtroDisciplina
    ? Object.keys(CAMPI_BY_ID).filter(id => CAMPI_BY_ID[id].disciplina === filtroDisciplina)
    : Object.keys(CAMPI_BY_ID);

  if (courtIds.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><div class="display">Nessun campo</div></div>`;
    return;
  }

  const snap = await db.collection("bookings")
    .where("date", "==", ora.dataIso)
    .where("courtId", "in", courtIds.slice(0, 30))
    .get();

  const prenotazioni = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(b => b.status === "CONFIRMED" || b.status === "COMPLETED")
    .sort((a, b) => orarioToMin(a.startTime) - orarioToMin(b.startTime));

  const inCorso = prenotazioni.filter(b => orarioToMin(b.startTime) <= ora.minuti && ora.minuti < orarioToMin(b.endTime));
  const dopo = prenotazioni.filter(b => orarioToMin(b.startTime) > ora.minuti);

  let dettagli = {};
  const riconosciuto = !!firebase.auth().currentUser;
  if (riconosciuto && prenotazioni.length > 0) {
    try {
      const fn = cloudFunctions().httpsCallable("dettagliGiocatori");
      const { data } = await fn({ bookingIds: prenotazioni.map(b => b.id) });
      dettagli = data.dettagli || {};
    } catch { /* i nomi sono un valore aggiunto, non bloccano la vista */ }
  }

  function nomeRiga(b) {
    const d = dettagli[b.id];
    if (!d || !d.nome1) return "Occupato";
    return (d.altri && d.altri.length > 0) ? `${d.nome1} vs ${d.altri.join(", ")}` : d.nome1;
  }

  function riga(b, dim) {
    return `
      <div class="cic-row${dim ? " dim" : ""}">
        <div class="n">${escapeHtml(nomeRiga(b))}</div>
        <div class="m">${escapeHtml(campoLabelDa(b.courtId))} · ${b.startTime}–${b.endTime}</div>
      </div>
    `;
  }

  let html = "";
  html += `<p class="cic-section-label"><span class="cic-live-dot"></span>In campo ora</p>`;
  html += inCorso.length > 0 ? inCorso.map(b => riga(b, false)).join("") : `<div class="cic-row dim"><div class="m">Nessuno al momento</div></div>`;

  html += `<p class="cic-section-label">Più tardi oggi</p>`;
  html += dopo.length > 0 ? dopo.map(b => riga(b, true)).join("") : `<div class="cic-row dim"><div class="m">Nessun'altra prenotazione oggi</div></div>`;

  if (!riconosciuto) {
    html += `<p class="cic-nascosto">I nomi sono visibili solo da un dispositivo riconosciuto — <a href="attiva-socio.html">attiva il tuo accesso</a>.</p>`;
  }

  listEl.innerHTML = html;
}

// Si arriva qui sia da prenota-padel.html sia da prenota-campo.html:
// invece di scegliere una destinazione fissa, torna semplicemente alla
// pagina di provenienza (browser back) — l'href statico nell'HTML resta
// solo come fallback per chi apre questa pagina direttamente (link
// condiviso, nessuna cronologia da cui tornare indietro).
function wireIndietro() {
  const link = document.getElementById("indietro-link");
  if (document.referrer && new URL(document.referrer).origin === location.origin) {
    link.addEventListener("click", (e) => { e.preventDefault(); history.back(); });
  }
}

(async function init() {
  await loadDatiCentro();
  document.getElementById("centro-kicker").textContent = DATI_CENTRO.nome;
  wireIndietro();

  const campiSnap = await db.collection("campi").where("attivo", "==", true).get();
  campiSnap.docs.forEach(d => {
    const c = d.data();
    if (c.disciplina === "tennis" || c.disciplina === "squash") CAMPI_BY_ID[d.id] = c;
  });
  // Il padel oggi ha un solo campo, non modellato nella collection "campi"
  // (courtId fisso "1" lato prenota-padel.js/functions) — voce sintetica
  // solo per l'etichetta qui.
  CAMPI_BY_ID["1"] = CAMPI_BY_ID["1"] || { numero: "1", disciplina: "padel" };

  renderPills();

  firebase.auth().onAuthStateChanged(() => caricaERenderizza());
  await caricaERenderizza();
})();

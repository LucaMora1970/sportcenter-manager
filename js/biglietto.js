// ============================================================
// biglietto.js — pagina pubblica del biglietto (senza login).
// Legge bookingTickets/{token}: conoscere il token (dal link o dal QR)
// è di per sé l'autorizzazione a leggerlo (vedi firestore.rules,
// "allow get: if true" — ma "allow list" resta riservato al pannello
// operatore, quindi non è enumerabile).
//
// Il biglietto viene creato dal webhook SOLO dopo la conferma del
// pagamento, che arriva in modo indipendente dal redirect del browser:
// per questo qui si prova a leggere con qualche tentativo/attesa invece
// di arrendersi al primo "non trovato".
//
// Richiede firebase-config.js e utils.js già caricati (NON auth.js: qui
// non c'è login). Richiede anche la libreria qrcodejs (script CDN in
// biglietto.html) per il QR.
// ============================================================

const TENTATIVI_MAX = 6;
const ATTESA_TRA_TENTATIVI_MS = 2500;
// Fallback per i biglietti creati prima dell'introduzione di
// disciplina/campoLabel sul documento (solo padel, unica disciplina di
// allora) — le prenotazioni più recenti (anche tennis/squash) portano
// questi due campi già valorizzati, vedi confermaPrenotazionePubblica.
const DISCIPLINA_FALLBACK = "Padel";

let ticketData = null;
let bigliettoSalvato = false; // true dopo il primo salvataggio (vedi salva-btn/torna-prenotazione-link)

function formatDataBreve(dataStr) {
  const [y, m, d] = dataStr.split("-");
  return `${d}.${m}.${y}`;
}

// Stessa tecnica "tenta come UTC, correggi per lo scarto CET/CEST" già
// usata lato server (functions/index.js) — qui serve solo per mostrare
// un'anteprima della scadenza: l'autorizzazione vera resta sempre il
// controllo server-side in annullaPrenotazioneCliente.
function zurigoAEpoch(dataIso, orario) {
  const tentativo = new Date(`${dataIso}T${orario}:00Z`).getTime();
  const parti = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Zurich",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
    }).formatToParts(new Date(tentativo)).map(p => [p.type, p.value])
  );
  const comeVisto = new Date(`${parti.year}-${parti.month}-${parti.day}T${parti.hour}:${parti.minute}:00Z`).getTime();
  return tentativo + (tentativo - comeVisto);
}

function formatScadenza(epochMs) {
  const parti = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Zurich",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
    }).formatToParts(new Date(epochMs)).map(p => [p.type, p.value])
  );
  return `${parti.day}.${parti.month}.${parti.year} alle ${parti.hour}:${parti.minute}`;
}

// Mostra il termine di annullamento (discipline/{id}.oreAnnullamento,
// default 24h) e il pulsante solo se si è ancora in tempo — pura
// anteprima lato client, il controllo vero è sempre server-side.
function aggiornaAnnullamento(data) {
  const rigaEl = document.getElementById("t-annulla-row");
  const scadenzaEl = document.getElementById("t-annulla-scadenza");
  const boxEl = document.getElementById("annulla-box");

  if (!data.date || !data.startTime) {
    rigaEl.classList.add("hidden");
    boxEl.classList.add("hidden");
    return;
  }

  const disc = DISCIPLINE.find(d => d.id === data.disciplina);
  const oreAnnullamento = (disc && disc.oreAnnullamento != null) ? disc.oreAnnullamento : 24;
  const scadenzaEpoch = zurigoAEpoch(data.date, data.startTime) - oreAnnullamento * 3600000;
  const entroTermine = Date.now() < scadenzaEpoch;

  rigaEl.classList.remove("hidden");
  scadenzaEl.textContent = entroTermine ? formatScadenza(scadenzaEpoch) : "Termine scaduto";
  boxEl.classList.toggle("hidden", !entroTermine);
}

async function onAnnullaBiglietto(token) {
  if (!confirm("Annullare questa prenotazione? Riceverai un credito da usare per una prenotazione futura — l'operazione non è reversibile.")) return;

  const btn = document.getElementById("annulla-btn");
  const errorEl = document.getElementById("annulla-error");
  errorEl.textContent = "";
  btn.disabled = true;
  btn.textContent = "Annullamento in corso…";

  try {
    const fn = cloudFunctions().httpsCallable("annullaPrenotazioneCliente");
    const { data: esito } = await fn({ token });
    document.getElementById("annulla-box").classList.add("hidden");
    document.getElementById("ticket-save-bar").classList.add("hidden");
    document.querySelector(".ticket-status").textContent = "Prenotazione annullata";
    document.getElementById("annulla-esito-testo").textContent =
      `Codice credito: ${esito.creditCode} — CHF ${esito.importo.toFixed(2)}. Comunicalo al circolo per usarlo su una prenotazione futura.`;
    document.getElementById("annulla-esito").classList.remove("hidden");
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
    btn.disabled = false;
    btn.textContent = "Annulla prenotazione";
  }
}

function formatTimestamp(ts) {
  if (!ts || typeof ts.toDate !== "function") return "—";
  const d = ts.toDate();
  const pad = n => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} alle ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function attendi(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function caricaBiglietto(token) {
  for (let tentativo = 0; tentativo < TENTATIVI_MAX; tentativo++) {
    try {
      const doc = await db.collection("bookingTickets").doc(token).get();
      if (doc.exists) return doc.data();
    } catch (err) {
      console.warn("caricaBiglietto: tentativo fallito:", err.message);
    }
    if (tentativo < TENTATIVI_MAX - 1) await attendi(ATTESA_TRA_TENTATIVI_MS);
  }
  return null;
}

function disciplinaLabelBiglietto(disciplina) {
  return { tennis: "Tennis", squash: "Squash", padel: "Padel" }[disciplina] || DISCIPLINA_FALLBACK;
}

function renderBiglietto(data, token) {
  document.getElementById("t-data").textContent = formatDataBreve(data.date);
  document.getElementById("t-disciplina").textContent = data.disciplina ? disciplinaLabelBiglietto(data.disciplina) : DISCIPLINA_FALLBACK;
  document.getElementById("t-campo").textContent = data.campoLabel || `Campo ${data.courtId}`;
  document.getElementById("t-orario").textContent = `${data.startTime} – ${data.endTime}`;
  document.getElementById("t-prezzo").textContent = `CHF ${(data.price || 0).toFixed(2)}`;
  document.getElementById("t-codice").textContent = data.bookingCode || "—";
  document.getElementById("t-timestamp").textContent = "Prenotato il " + formatTimestamp(data.createdAt);

  const qrUrl = `${basePageUrl()}biglietto.html?t=${token}`;
  new QRCode(document.getElementById("qr-container"), {
    text: qrUrl,
    width: 180,
    height: 180,
    colorDark: "#0d1f30",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.M
  });

  // Solo informativa (vedi Configurazione → "Mostra ripartizione tra i
  // giocatori"): chi ha il biglietto ha già pagato l'intero importo,
  // questa non è una richiesta di pagamento — serve solo a sapere quanto
  // chiedere a ciascun compagno.
  if (Array.isArray(data.ripartizione) && data.ripartizione.length > 1) {
    document.getElementById("ripartizione-list").innerHTML = data.ripartizione.map(r => `
      <div class="ticket-row"><span class="k">${escapeHtml(r.nome || "—")}</span><span class="v">CHF ${(r.importo || 0).toFixed(2)}</span></div>
    `).join("");
    document.getElementById("ripartizione-box").classList.remove("hidden");
  }

  document.getElementById("stato-caricamento").classList.add("hidden");
  document.getElementById("ticket-content").classList.remove("hidden");
  document.getElementById("ticket-save-bar").classList.remove("hidden");
}

// Vero solo se l'ultimo disegno sul canvas condiviso è già quello
// richiesto (con o senza QR) — evita di ridisegnare da capo logo/testi/QR
// se si clicca Salva e poi Inoltra (o viceversa) sullo stesso biglietto,
// il contenuto non cambia tra un click e l'altro.
let ultimoDisegnoConQr = null;

// Ridisegna l'intero biglietto su <canvas> (logo + testi + QR) — nessun
// backend di generazione immagini necessario, tutto lato client. Sempre
// in versione chiara (indipendente dal tema scelto per la pagina): un'immagine
// chiara si stampa meglio ed è più adatta a essere inoltrata/condivisa.
// Riusata sia per il download ("Salva biglietto", con QR — è il proprio
// biglietto, il QR/link serve a chi prenota per riaprirlo/annullarlo) sia
// per la condivisione ("Inoltra", vedi condividiBiglietto — SENZA QR: chi
// riceve il biglietto da un'altra persona non deve poter arrivare al
// link che permette di annullarne la prenotazione).
async function disegnaBigliettoCanvas({ includiQr = true } = {}) {
  const canvas = document.getElementById("ticket-canvas");
  if (ultimoDisegnoConQr === includiQr) return canvas;
  // Senza QR il biglietto è molto più corto (niente blocco QR 320px):
  // un'altezza fissa più bassa invece di lasciare un vuoto in fondo.
  canvas.height = includiQr ? 1150 : 900;
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;

  ctx.fillStyle = "#eef2f4";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#c7d3d9";
  ctx.lineWidth = 3;
  ctx.strokeRect(20, 20, W - 40, H - 40);

  const logo = document.getElementById("ticket-logo");
  const logoSize = 110;
  try {
    ctx.drawImage(logo, (W - logoSize) / 2, 60, logoSize, logoSize);
  } catch { /* logo non ancora caricato: si procede comunque senza */ }

  ctx.textAlign = "center";
  ctx.fillStyle = "#52697a";
  ctx.font = "600 22px Arial";
  ctx.fillText((DATI_CENTRO.nome || "").toUpperCase(), W / 2, 210);

  // Indirizzo/contatti "anche in piccolo" ma sempre sul biglietto
  // rilasciato, non solo sulla ricevuta stampata — righe facoltative,
  // il titolo sotto si sposta di conseguenza solo se compilate.
  let headerY = 210;
  ctx.fillStyle = "#7d93a3";
  ctx.font = "14px Arial";
  Object.values(datiCentroRighe()).filter(Boolean).forEach(riga => {
    headerY += 20;
    ctx.fillText(riga, W / 2, headerY);
  });

  ctx.fillStyle = "#576f00";
  ctx.font = "700 34px Arial";
  ctx.fillText("PRENOTAZIONE CONFERMATA", W / 2, headerY + 40);

  const righe = [
    ["Data", document.getElementById("t-data").textContent],
    ["Disciplina", document.getElementById("t-disciplina").textContent],
    ["Campo", document.getElementById("t-campo").textContent],
    ["Orario", document.getElementById("t-orario").textContent],
    ["Pagato", document.getElementById("t-prezzo").textContent]
  ];
  ctx.textAlign = "left";
  let y = headerY + 110;
  righe.forEach(([k, v]) => {
    ctx.fillStyle = "#52697a";
    ctx.font = "22px Arial";
    ctx.fillText(k, 80, y);
    ctx.fillStyle = "#16283a";
    ctx.font = "700 22px Arial";
    ctx.textAlign = "right";
    ctx.fillText(v, W - 80, y);
    ctx.textAlign = "left";
    y += 50;
  });

  ctx.textAlign = "center";
  ctx.fillStyle = "#6f8f00";
  ctx.font = "700 40px 'Courier New', monospace";
  ctx.fillText(document.getElementById("t-codice").textContent, W / 2, y + 40);

  const qrSize = 320;
  const qrTop = y + 80;
  let footerBaseY;
  if (includiQr) {
    const qrCanvas = document.querySelector("#qr-container canvas");
    const qrImg = document.querySelector("#qr-container img");
    if (qrCanvas) {
      ctx.drawImage(qrCanvas, (W - qrSize) / 2, qrTop, qrSize, qrSize);
    } else if (qrImg) {
      ctx.drawImage(qrImg, (W - qrSize) / 2, qrTop, qrSize, qrSize);
    }
    footerBaseY = qrTop + qrSize + 40;
  } else {
    footerBaseY = y + 90;
  }

  ctx.fillStyle = "#52697a";
  ctx.font = "18px Arial";
  ctx.fillText(document.getElementById("t-timestamp").textContent, W / 2, footerBaseY);

  ctx.fillStyle = "#8a99a3";
  ctx.font = "15px Arial";
  ctx.fillText("Powered by Sport-OS", W / 2, footerBaseY + 34);
  ctx.fillText("Copyright L.M. 2026", W / 2, footerBaseY + 56);

  ultimoDisegnoConQr = includiQr;
  return canvas;
}

async function salvaBigliettoPng() {
  const canvas = await disegnaBigliettoCanvas();
  const link = document.createElement("a");
  link.download = `biglietto-${document.getElementById("t-codice").textContent}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
}

// "Inoltra": apre il selettore nativo del telefono (WhatsApp, Mail, ecc.
// — qualunque app di condivisione installata, non ne forziamo una) con
// l'immagine del biglietto già pronta — così chi la riceve la vede
// subito, senza dover prima aprire un link. A differenza di "Salva
// biglietto", qui il QR (e più in generale il link a biglietto.html) non
// vengono mai condivisi: quel link è anche il modo per annullare la
// prenotazione da soli, e chi lo riceve solo per essere informato del
// campo/orario non deve poter arrivare per sbaglio ad annullarla. Il
// codice prenotazione stampato resta invece nell'immagine: da solo non
// permette di annullare nulla (serve solo per una verifica manuale in
// segreteria). Se il browser non supporta la condivisione di file
// (soprattutto desktop) si scende di un gradino: condivide solo il testo
// descrittivo, mai un link; se nemmeno quello è supportato, lo copia
// negli appunti.
async function condividiBiglietto(data) {
  const titolo = `${data.disciplina ? disciplinaLabelBiglietto(data.disciplina) : DISCIPLINA_FALLBACK} — ${document.getElementById("t-data").textContent} ${document.getElementById("t-orario").textContent}`;
  const descrizione = `${titolo} — ${DATI_CENTRO.nome || ""}`;

  try {
    if (navigator.canShare) {
      const canvas = await disegnaBigliettoCanvas({ includiQr: false });
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
      const file = new File([blob], `biglietto-${data.bookingCode || "prenotazione"}.png`, { type: "image/png" });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: titolo, text: descrizione });
        return;
      }
    }
    if (navigator.share) {
      await navigator.share({ title: titolo, text: descrizione });
      return;
    }
    mostraScelteCondivisione(descrizione);
  } catch (err) {
    if (err.name === "AbortError") return; // utente ha chiuso il pannello di condivisione, non è un errore
    mostraScelteCondivisione(descrizione);
  }
}

// Desktop (Web Share API assente, o rifiutata dal browser — Safari in
// particolare la nega se tra il click e la chiamata è passato un await,
// come qui sopra per disegnare il canvas): prima si copiava solo negli
// appunti, un feedback minuscolo e facile da non notare — sembrava che
// "Inoltra" non facesse nulla. Al posto del bottone, due link diretti già
// pronti col testo — mai il link a biglietto.html (vedi sopra, è anche il
// modo per annullare la prenotazione).
function mostraScelteCondivisione(descrizione) {
  document.getElementById("inoltra-btn").classList.add("hidden");
  document.getElementById("inoltra-email").href = `mailto:?body=${encodeURIComponent(descrizione)}`;
  document.getElementById("inoltra-email").classList.remove("hidden");
  document.getElementById("inoltra-whatsapp").href = `https://wa.me/?text=${encodeURIComponent(descrizione)}`;
  document.getElementById("inoltra-whatsapp").classList.remove("hidden");
}

// Ricevuta come vero PDF (jsPDF, via CDN in biglietto.html) — a differenza
// del biglietto (PNG, pensato per essere aperto/mostrato al volo su
// telefono) questa è un documento contabile da archiviare/inoltrare,
// dove il formato PDF è quello atteso. Un solo download diretto, niente
// dialogo di stampa del browser. Il circolo non è soggetto IVA: solo la
// dicitura, niente scorporo/numerazione fiscale.
function stampaRicevutaBiglietto(data) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const marginX = 20;
  let y = 20;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text(DATI_CENTRO.nome || "", marginX, y);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  Object.values(datiCentroRighe()).filter(Boolean).forEach(riga => {
    y += 6;
    doc.text(riga, marginX, y);
  });

  y += 14;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text("Ricevuta prenotazione", marginX, y);

  const righe = [
    ["Data", formatDataBreve(data.date)],
    ["Disciplina", document.getElementById("t-disciplina").textContent],
    ["Campo", document.getElementById("t-campo").textContent],
    ["Orario", document.getElementById("t-orario").textContent],
    ["Codice", data.bookingCode || "—"],
    ["Importo", `CHF ${(data.price || 0).toFixed(2)}`]
  ];
  doc.setFontSize(11);
  righe.forEach(([k, v]) => {
    y += 9;
    doc.setFont("helvetica", "normal");
    doc.text(k, marginX, y);
    doc.setFont("helvetica", "bold");
    doc.text(String(v), marginX + 55, y);
  });

  y += 14;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text("Non soggetto ad IVA.", marginX, y);

  doc.save(`ricevuta-${data.bookingCode || "prenotazione"}.pdf`);
}

function aggiungiAlCalendario(data) {
  const dataCompatta = data.date.replace(/-/g, "");
  const oraInizio = data.startTime.replace(":", "") + "00";
  const oraFine = data.endTime.replace(":", "") + "00";
  const ora = new Date();
  const pad = n => String(n).padStart(2, "0");
  const dtstamp = `${ora.getUTCFullYear()}${pad(ora.getUTCMonth() + 1)}${pad(ora.getUTCDate())}T${pad(ora.getUTCHours())}${pad(ora.getUTCMinutes())}${pad(ora.getUTCSeconds())}Z`;

  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Sport-OS//Prenotazione Padel//IT",
    "BEGIN:VEVENT",
    `UID:${data.bookingCode}@sportcenter-manager`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${dataCompatta}T${oraInizio}`,
    `DTEND:${dataCompatta}T${oraFine}`,
    `SUMMARY:${data.disciplina ? disciplinaLabelBiglietto(data.disciplina) : DISCIPLINA_FALLBACK} — ${data.campoLabel || "Campo " + data.courtId} — ${DATI_CENTRO.nome}`,
    `DESCRIPTION:Codice prenotazione: ${data.bookingCode}`,
    `LOCATION:${[DATI_CENTRO.nome, DATI_CENTRO.indirizzo, DATI_CENTRO.localita].filter(Boolean).join(", ")}`,
    "END:VEVENT",
    "END:VCALENDAR"
  ].join("\r\n");

  const blob = new Blob([ics], { type: "text/calendar" });
  const link = document.createElement("a");
  link.download = `prenotazione-${data.bookingCode}.ics`;
  link.href = URL.createObjectURL(blob);
  link.click();
  URL.revokeObjectURL(link.href);
}

(async function init() {
  await loadDatiCentro();
  await loadImpostazioni();
  await loadDiscipline(); // serve a leggere discipline/{id}.oreAnnullamento per l'anteprima del termine
  document.getElementById("centro-kicker").textContent = DATI_CENTRO.nome;
  document.getElementById("ticket-centro-nome").textContent = DATI_CENTRO.nome;
  document.getElementById("ticket-centro-dettagli").textContent =
    Object.values(datiCentroRighe()).filter(Boolean).join(" — ");

  const token = new URLSearchParams(location.search).get("t");
  if (!token) {
    document.getElementById("stato-caricamento").classList.add("hidden");
    document.getElementById("stato-non-trovato").classList.remove("hidden");
    return;
  }

  const data = await caricaBiglietto(token);
  if (!data) {
    document.getElementById("stato-caricamento").classList.add("hidden");
    document.getElementById("stato-non-trovato").classList.remove("hidden");
    return;
  }

  ticketData = data;
  renderBiglietto(data, token);
  aggiornaAnnullamento(data);
  document.getElementById("annulla-btn").addEventListener("click", () => onAnnullaBiglietto(token));

  // Il link "torna alla prenotazione" (ora un'icona, vedi biglietto.html)
  // punta sempre alla v2 (griglia campi/durata × orari) — gestisce già
  // tennis/squash/padel in un solo ingresso, non serve più distinguere
  // per disciplina come quando padel aveva ancora la sua pagina a parte.
  const tornaLink = document.getElementById("torna-prenotazione-link");
  tornaLink.href = "tcm.html";
  tornaLink.setAttribute("aria-label", "Torna alla prenotazione");

  // Dopo il salvataggio, si riporta l'utente su un link deciso in
  // Configurazione → Impostazioni generali → "Link dopo 'Salva
  // biglietto'" — non necessariamente il sito del circolo (per quello
  // c'è impostazioni/centro.homepage, usato altrove per l'intestazione),
  // qui può essere qualunque pagina. Vuoto = nessun redirect, resta sul
  // biglietto. Piccolo ritardo prima di navigare: avviare un download e
  // cambiare pagina nello stesso istante può interrompere il download su
  // alcuni browser.
  document.getElementById("salva-btn").addEventListener("click", () => {
    salvaBigliettoPng();
    bigliettoSalvato = true;
    const link = IMPOSTAZIONI.linkDopoSalvaBiglietto;
    if (link) {
      const url = /^https?:\/\//i.test(link) ? link : `https://${link}`;
      setTimeout(() => { window.location.href = url; }, 600);
    } else {
      // Nessun redirect configurato: si resta sulla pagina, quindi serve
      // una conferma visibile — un click su un <a download> non dà di
      // per sé nessun riscontro, sembra non aver fatto nulla.
      const btn = document.getElementById("salva-btn");
      const testoOriginale = btn.textContent;
      btn.textContent = "Biglietto salvato ✓";
      setTimeout(() => { btn.textContent = testoOriginale; }, 2500);
    }
  });
  document.getElementById("inoltra-btn").addEventListener("click", () => condividiBiglietto(ticketData));
  document.getElementById("calendario-btn").addEventListener("click", () => aggiungiAlCalendario(ticketData));
  document.getElementById("ricevuta-btn").addEventListener("click", () => stampaRicevutaBiglietto(ticketData));

  // Il biglietto è l'unica prova della prenotazione (nessun account, nessuna
  // email automatica per ora): chi torna al tabellone senza aver già
  // cliccato "Salva biglietto" lo salva comunque prima di uscire dalla
  // pagina. Se l'ha già salvato da solo, si naviga subito — un secondo
  // download non richiesto sarebbe solo fastidioso. Il ritardo prima di
  // cambiare pagina (solo nel caso si salvi qui) serve perché avviare un
  // download e navigare nello stesso istante può interrompere il download
  // su alcuni browser.
  document.getElementById("torna-prenotazione-link").addEventListener("click", (e) => {
    e.preventDefault();
    const link = e.currentTarget;
    if (bigliettoSalvato) {
      window.location.href = link.href;
      return;
    }
    salvaBigliettoPng();
    bigliettoSalvato = true;
    link.querySelector("span").textContent = "Salvato…";
    setTimeout(() => { window.location.href = link.href; }, 600);
  });
})();

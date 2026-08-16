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

  document.getElementById("stato-caricamento").classList.add("hidden");
  document.getElementById("ticket-content").classList.remove("hidden");
  document.getElementById("ticket-save-bar").classList.remove("hidden");
}

// Ridisegna l'intero biglietto su <canvas> (logo + testi + QR) per
// poterlo scaricare come immagine — nessun backend di generazione
// immagini necessario, tutto lato client. Sempre in versione chiara
// (indipendente dal tema scelto per la pagina): un'immagine chiara si
// stampa meglio ed è più adatta a essere inoltrata/condivisa.
async function salvaBigliettoPng() {
  const canvas = document.getElementById("ticket-canvas");
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

  const qrCanvas = document.querySelector("#qr-container canvas");
  const qrImg = document.querySelector("#qr-container img");
  const qrSize = 320;
  const qrTop = y + 80;
  if (qrCanvas) {
    ctx.drawImage(qrCanvas, (W - qrSize) / 2, qrTop, qrSize, qrSize);
  } else if (qrImg) {
    ctx.drawImage(qrImg, (W - qrSize) / 2, qrTop, qrSize, qrSize);
  }

  ctx.fillStyle = "#52697a";
  ctx.font = "18px Arial";
  ctx.fillText(document.getElementById("t-timestamp").textContent, W / 2, qrTop + qrSize + 40);

  ctx.fillStyle = "#8a99a3";
  ctx.font = "15px Arial";
  ctx.fillText("Powered by Sport-OS", W / 2, qrTop + qrSize + 74);
  ctx.fillText("Copyright L.M. 2026", W / 2, qrTop + qrSize + 96);

  const link = document.createElement("a");
  link.download = `biglietto-${document.getElementById("t-codice").textContent}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
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

  // Il link "torna alla prenotazione" deve puntare alla pagina giusta:
  // il padel ha ancora la sua pagina dedicata, tennis/squash usano
  // l'ingresso unico — data.disciplina (assente = vecchi biglietti,
  // solo padel esisteva) decide quale.
  const tornaLink = document.getElementById("torna-prenotazione-link");
  if (data.disciplina && data.disciplina !== "padel") {
    tornaLink.href = "prenota-campo.html";
    tornaLink.textContent = "← Torna alla prenotazione";
  } else {
    tornaLink.href = "prenota-padel.html";
    tornaLink.textContent = "← Torna a Prenotazione Padel";
  }

  // Dopo il salvataggio, si riporta l'utente sul sito vetrina del circolo
  // (Configurazione → Dati del centro → Homepage) invece di lasciarlo
  // fermo sul biglietto — se il campo non è compilato, il pulsante si
  // limita a scaricare come prima. Piccolo ritardo prima di navigare,
  // stesso motivo del link "torna alla prenotazione" qui sotto: avviare
  // un download e cambiare pagina nello stesso istante può interrompere
  // il download su alcuni browser.
  document.getElementById("salva-btn").addEventListener("click", () => {
    salvaBigliettoPng();
    bigliettoSalvato = true;
    if (DATI_CENTRO.homepage) {
      const url = /^https?:\/\//i.test(DATI_CENTRO.homepage) ? DATI_CENTRO.homepage : `https://${DATI_CENTRO.homepage}`;
      setTimeout(() => { window.location.href = url; }, 600);
    }
  });
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
    link.textContent = "Biglietto salvato — torno alla prenotazione…";
    setTimeout(() => { window.location.href = link.href; }, 600);
  });
})();

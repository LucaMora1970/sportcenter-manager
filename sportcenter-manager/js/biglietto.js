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
// Unica disciplina prenotabile con questo sistema per ora — indicata
// sempre esplicitamente perché i campi sono numerati per disciplina
// (es. "Campo 1" esiste sia per tennis sia per padel).
const DISCIPLINA = "Padel";

let ticketData = null;

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

function renderBiglietto(data, token) {
  document.getElementById("t-data").textContent = formatDataBreve(data.date);
  document.getElementById("t-disciplina").textContent = DISCIPLINA;
  document.getElementById("t-campo").textContent = `Campo ${data.courtId}`;
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
}

// Ridisegna l'intero biglietto su <canvas> (logo + testi + QR) per
// poterlo scaricare come immagine — nessun backend di generazione
// immagini necessario, tutto lato client.
async function salvaBigliettoPng() {
  const canvas = document.getElementById("ticket-canvas");
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;

  ctx.fillStyle = "#0d1f30";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#274a68";
  ctx.lineWidth = 3;
  ctx.strokeRect(20, 20, W - 40, H - 40);

  const logo = document.getElementById("ticket-logo");
  const logoSize = 110;
  try {
    ctx.drawImage(logo, (W - logoSize) / 2, 60, logoSize, logoSize);
  } catch { /* logo non ancora caricato: si procede comunque senza */ }

  ctx.textAlign = "center";
  ctx.fillStyle = "#9fb1bf";
  ctx.font = "600 22px Arial";
  ctx.fillText((DATI_CENTRO.nome || "").toUpperCase(), W / 2, 210);

  ctx.fillStyle = "#c1e08f";
  ctx.font = "700 34px Arial";
  ctx.fillText("PRENOTAZIONE CONFERMATA", W / 2, 260);

  const righe = [
    ["Data", document.getElementById("t-data").textContent],
    ["Disciplina", document.getElementById("t-disciplina").textContent],
    ["Campo", document.getElementById("t-campo").textContent],
    ["Orario", document.getElementById("t-orario").textContent],
    ["Pagato", document.getElementById("t-prezzo").textContent]
  ];
  ctx.textAlign = "left";
  let y = 330;
  righe.forEach(([k, v]) => {
    ctx.fillStyle = "#9fb1bf";
    ctx.font = "22px Arial";
    ctx.fillText(k, 80, y);
    ctx.fillStyle = "#edf1f2";
    ctx.font = "700 22px Arial";
    ctx.textAlign = "right";
    ctx.fillText(v, W - 80, y);
    ctx.textAlign = "left";
    y += 50;
  });

  ctx.textAlign = "center";
  ctx.fillStyle = "#c6df2e";
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

  ctx.fillStyle = "#9fb1bf";
  ctx.font = "18px Arial";
  ctx.fillText(document.getElementById("t-timestamp").textContent, W / 2, qrTop + qrSize + 40);

  const link = document.createElement("a");
  link.download = `biglietto-${document.getElementById("t-codice").textContent}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
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
    `SUMMARY:${DISCIPLINA} — Campo ${data.courtId} — ${DATI_CENTRO.nome}`,
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

  document.getElementById("salva-btn").addEventListener("click", salvaBigliettoPng);
  document.getElementById("calendario-btn").addEventListener("click", () => aggiungiAlCalendario(ticketData));

  // Il biglietto è l'unica prova della prenotazione (nessun account, nessuna
  // email automatica per ora) — chi torna al tabellone lo salva sempre,
  // anche se non ha cliccato "Salva biglietto" da solo. Un piccolo ritardo
  // prima di cambiare pagina: avviare un download e navigare nello stesso
  // istante può interrompere il download su alcuni browser.
  document.getElementById("torna-prenotazione-link").addEventListener("click", (e) => {
    e.preventDefault();
    const link = e.currentTarget;
    salvaBigliettoPng();
    link.textContent = "Biglietto salvato — torno alla prenotazione…";
    setTimeout(() => { window.location.href = link.href; }, 600);
  });
})();

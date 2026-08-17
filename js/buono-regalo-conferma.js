// ============================================================
// buono-regalo-conferma.js — pagina pubblica del buono regalo (senza
// login). Legge voucherTickets/{token}: conoscere il token (dal link) è
// di per sé l'autorizzazione a leggerlo — stesso pattern di biglietto.js
// per bookingTickets/{token} (vedi firestore.rules).
//
// Il documento viene creato dal webhook SOLO dopo la conferma del
// pagamento (o subito, se il buono è stato emesso omaggio dallo staff),
// che arriva in modo indipendente dal redirect del browser: per questo
// qui si prova a leggere con qualche tentativo/attesa invece di
// arrendersi al primo "non trovato".
//
// Richiede firebase-config.js e utils.js già caricati (NON auth.js: qui
// non c'è login).
// ============================================================

const TENTATIVI_MAX = 6;
const ATTESA_TRA_TENTATIVI_MS = 2500;

function attendi(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function caricaVoucher(token) {
  for (let tentativo = 0; tentativo < TENTATIVI_MAX; tentativo++) {
    try {
      const doc = await db.collection("voucherTickets").doc(token).get();
      if (doc.exists) return doc.data();
    } catch (err) {
      console.warn("caricaVoucher: tentativo fallito:", err.message);
    }
    if (tentativo < TENTATIVI_MAX - 1) await attendi(ATTESA_TRA_TENTATIVI_MS);
  }
  return null;
}

function renderVoucher(data) {
  document.getElementById("v-centro").textContent = DATI_CENTRO.nome;
  document.getElementById("v-importo").textContent = `CHF ${(data.importo || 0).toFixed(2)}`;
  document.getElementById("v-codice").textContent = data.creditCode || "—";

  document.getElementById("stato-caricamento").classList.add("hidden");
  document.getElementById("voucher-content").classList.remove("hidden");
}

// Ridisegna il buono su <canvas> per poterlo scaricare come immagine —
// sempre in versione chiara (indipendente dal tema della pagina): un
// buono regalo va stampato/inoltrato, la versione chiara è più adatta a
// entrambi gli usi (stessa scelta fatta per il biglietto prenotazione).
function salvaVoucherPng(data) {
  const canvas = document.getElementById("voucher-canvas");
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;

  ctx.fillStyle = "#eef2f4";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#c7d3d9";
  ctx.lineWidth = 3;
  ctx.strokeRect(20, 20, W - 40, H - 40);

  const logo = document.getElementById("voucher-logo");
  const logoSize = 110;
  try {
    ctx.drawImage(logo, (W - logoSize) / 2, 60, logoSize, logoSize);
  } catch { /* logo non ancora caricato: si procede comunque senza */ }

  ctx.textAlign = "center";
  ctx.fillStyle = "#52697a";
  ctx.font = "600 22px Arial";
  ctx.fillText((DATI_CENTRO.nome || "").toUpperCase(), W / 2, 210);

  ctx.fillStyle = "#16283a";
  ctx.font = "700 40px Arial";
  ctx.fillText("BUONO REGALO PADEL", W / 2, 270);

  ctx.fillStyle = "#576f00";
  ctx.font = "700 90px Arial";
  ctx.fillText(`CHF ${(data.importo || 0).toFixed(2)}`, W / 2, 400);

  ctx.fillStyle = "#6f8f00";
  ctx.font = "700 44px 'Courier New', monospace";
  ctx.fillText(data.creditCode || "—", W / 2, 480);

  ctx.fillStyle = "#52697a";
  ctx.font = "20px Arial";
  wrapText(ctx, "Da usare come credito in fase di prenotazione — senza scadenza.", W / 2, 560, W - 160, 28);

  const link = document.createElement("a");
  link.download = `buono-regalo-${data.creditCode || "campo"}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
}

function wrapText(ctx, text, cx, y, maxWidth, lineHeight) {
  const words = text.split(" ");
  let line = "";
  let lineY = y;
  words.forEach(word => {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, cx, lineY);
      line = word;
      lineY += lineHeight;
    } else {
      line = test;
    }
  });
  if (line) ctx.fillText(line, cx, lineY);
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

  const data = await caricaVoucher(token);
  if (!data) {
    document.getElementById("stato-caricamento").classList.add("hidden");
    document.getElementById("stato-non-trovato").classList.remove("hidden");
    return;
  }

  renderVoucher(data);
  document.getElementById("salva-btn").addEventListener("click", () => salvaVoucherPng(data));
})();

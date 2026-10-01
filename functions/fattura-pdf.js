// ============================================================
// fattura-pdf.js — genera il PDF di una fattura con la sezione di
// pagamento QR-bill svizzera (standard SIX, via libreria swissqrbill).
//
// Modulo puro (nessun accesso a Firestore): riceve il documento fattura
// già completo (snapshot di creditore, IBAN, riferimento, righe) e
// restituisce un Buffer. Così la fattura si può rigenerare identica in
// qualsiasi momento anche se la configurazione cambia dopo l'emissione.
//
// Regole del QR-bill rispettate qui:
//  - IBAN normale -> riferimento SCOR (ISO 11649) oppure nessuno;
//    QR-IBAN (IID 30000-31999) -> riferimento QRR di 27 cifre obbligatorio.
//  - Indirizzi solo strutturati (via, civico, CAP, località): dal
//    novembre 2025 gli indirizzi combinati non sono più ammessi.
//  - La sezione di pagamento occupa gli ultimi 105 mm della pagina A4:
//    il contenuto della fattura resta sopra, e va a pagina nuova se
//    non ci sta.
// ============================================================

const PDFDocument = require("pdfkit");
const { SwissQRBill } = require("swissqrbill/pdf");
const swissUtils = require("swissqrbill/utils");

const mm = swissUtils.mm2pt;

const MARGINE_SX = mm(20);
const MARGINE_DX = mm(20);
const LARGHEZZA_PAGINA = mm(210);
const ALTEZZA_PAGINA = mm(297);
const LARGHEZZA_UTILE = LARGHEZZA_PAGINA - MARGINE_SX - MARGINE_DX;
// Sotto questo y (dall'alto) comincia la sezione di pagamento (105 mm
// dal fondo) più un po' d'aria.
const LIMITE_CONTENUTO = ALTEZZA_PAGINA - mm(105) - mm(3);
const ALTEZZA_BLOCCO_TOTALE = mm(28);

const GRIGIO = "#555555";
const NERO = "#000000";

function formatoChf(n) {
  const [intero, dec] = Number(n).toFixed(2).split(".");
  return intero.replace(/\B(?=(\d{3})+(?!\d))/g, "’") + "." + dec;
}

function formatoData(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

function indirizzoRiga1(p) {
  return [p.via, p.civico].filter(Boolean).join(" ");
}

function indirizzoRiga2(p) {
  const paese = p.paese && p.paese !== "CH" ? p.paese + "-" : "";
  return [paese + (p.cap || ""), p.localita].filter(Boolean).join(" ");
}

function indirizzoCompleto(p) {
  return !!(p && p.nome && p.via && p.cap && p.localita);
}

function datiQr(fattura) {
  const c = fattura.creditore;
  const dati = {
    currency: fattura.valuta || "CHF",
    amount: fattura.totale,
    creditor: {
      account: fattura.iban,
      name: c.nome,
      address: c.via,
      buildingNumber: c.civico || undefined,
      zip: c.cap,
      city: c.localita,
      country: c.paese || "CH"
    },
    message: `Fattura ${fattura.numero}`
  };
  const d = fattura.destinatario;
  if (indirizzoCompleto(d)) {
    dati.debtor = {
      name: d.nome,
      address: d.via,
      buildingNumber: d.civico || undefined,
      zip: d.cap,
      city: d.localita,
      country: d.paese || "CH"
    };
  }
  if (fattura.riferimento) dati.reference = fattura.riferimento;
  return dati;
}

function intestazioneTabella(pdf, y) {
  pdf.font("Helvetica-Bold").fontSize(9).fillColor(GRIGIO);
  pdf.text("Descrizione", MARGINE_SX, y, { width: mm(95), lineBreak: false });
  pdf.text("Qtà", MARGINE_SX + mm(97), y, { width: mm(15), align: "right", lineBreak: false });
  pdf.text("Prezzo", MARGINE_SX + mm(114), y, { width: mm(26), align: "right", lineBreak: false });
  pdf.text("Importo", MARGINE_SX + mm(142), y, { width: mm(28), align: "right", lineBreak: false });
  const yLinea = y + mm(5);
  pdf.moveTo(MARGINE_SX, yLinea).lineTo(MARGINE_SX + LARGHEZZA_UTILE, yLinea)
    .lineWidth(0.6).strokeColor(NERO).stroke();
  return yLinea + mm(2);
}

function formatoQuantita(q) {
  return Number.isInteger(q) ? String(q) : String(Number(q.toFixed(2)));
}

/**
 * @param {object} fattura  documento fattura completo (vedi emettiFattura in index.js)
 * @returns {Promise<Buffer>}
 */
function generaPdfFattura(fattura) {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      size: "A4",
      margin: 0,
      bufferPages: false,
      info: { Title: `Fattura ${fattura.numero}`, Author: fattura.creditore.nome }
    });
    const chunks = [];
    pdf.on("data", c => chunks.push(c));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);

    try {
      const c = fattura.creditore;
      const d = fattura.destinatario;

      // --- Mittente (alto a sinistra) ---
      pdf.fillColor(NERO).font("Helvetica-Bold").fontSize(12)
        .text(c.nome, MARGINE_SX, mm(18), { width: mm(90) });
      pdf.font("Helvetica").fontSize(9).fillColor(GRIGIO);
      const righeMittente = [indirizzoRiga1(c), indirizzoRiga2(c), fattura.contatti?.telefono, fattura.contatti?.email]
        .filter(Boolean);
      righeMittente.forEach(r => pdf.text(r, { width: mm(90) }));

      // --- Destinatario (finestra della busta, a destra) ---
      pdf.fillColor(NERO).font("Helvetica").fontSize(10.5)
        .text(d.nome, mm(118), mm(48), { width: mm(72) });
      [indirizzoRiga1(d), indirizzoRiga2(d)].filter(Boolean)
        .forEach(r => pdf.text(r, { width: mm(72) }));

      // --- Titolo e dati fattura ---
      pdf.font("Helvetica-Bold").fontSize(15).fillColor(NERO)
        .text(`Fattura ${fattura.numero}`, MARGINE_SX, mm(78), { width: LARGHEZZA_UTILE });
      pdf.font("Helvetica").fontSize(9.5).fillColor(GRIGIO);
      const ySotto = mm(78) + mm(8);
      pdf.text(`${c.localita}, ${formatoData(fattura.dataEmissione)}`, MARGINE_SX, ySotto, { width: LARGHEZZA_UTILE });
      pdf.text(`Scadenza: ${formatoData(fattura.dataScadenza)}`, { width: LARGHEZZA_UTILE });

      let y = mm(98);
      if (fattura.oggetto) {
        pdf.font("Helvetica-Bold").fontSize(10.5).fillColor(NERO)
          .text(fattura.oggetto, MARGINE_SX, y, { width: LARGHEZZA_UTILE });
        y = pdf.y + mm(5);
      }

      // --- Tabella righe ---
      y = intestazioneTabella(pdf, y);
      for (const riga of fattura.righe) {
        pdf.font("Helvetica").fontSize(10);
        const altezzaDescr = pdf.heightOfString(riga.descrizione, { width: mm(95) });
        const altezzaRiga = Math.max(altezzaDescr, mm(5)) + mm(2.5);
        if (y + altezzaRiga > LIMITE_CONTENUTO) {
          pdf.addPage();
          y = intestazioneTabella(pdf, mm(25));
        }
        pdf.fillColor(NERO).font("Helvetica").fontSize(10);
        pdf.text(riga.descrizione, MARGINE_SX, y, { width: mm(95) });
        pdf.text(formatoQuantita(riga.quantita), MARGINE_SX + mm(97), y, { width: mm(15), align: "right", lineBreak: false });
        pdf.text(formatoChf(riga.prezzoUnitario), MARGINE_SX + mm(114), y, { width: mm(26), align: "right", lineBreak: false });
        pdf.text(formatoChf(riga.importo), MARGINE_SX + mm(142), y, { width: mm(28), align: "right", lineBreak: false });
        y += altezzaRiga;
      }

      // --- Totale + note (devono stare sopra la sezione di pagamento) ---
      if (y + ALTEZZA_BLOCCO_TOTALE > LIMITE_CONTENUTO) {
        pdf.addPage();
        y = mm(25);
      }
      pdf.moveTo(MARGINE_SX, y).lineTo(MARGINE_SX + LARGHEZZA_UTILE, y)
        .lineWidth(0.6).strokeColor(NERO).stroke();
      y += mm(3);
      pdf.font("Helvetica-Bold").fontSize(11).fillColor(NERO);
      pdf.text(`Totale ${fattura.valuta || "CHF"}`, MARGINE_SX + mm(80), y, { width: mm(60), align: "right", lineBreak: false });
      pdf.text(formatoChf(fattura.totale), MARGINE_SX + mm(142), y, { width: mm(28), align: "right", lineBreak: false });
      y += mm(8);

      pdf.font("Helvetica").fontSize(9).fillColor(GRIGIO);
      const noteFinali = [
        fattura.notaIva,
        `Pagabile entro il ${formatoData(fattura.dataScadenza)} tramite la polizza di versamento QR qui sotto.`,
        fattura.note,
        fattura.pieDiPagina
      ].filter(Boolean);
      noteFinali.forEach(n => {
        pdf.text(n, MARGINE_SX, y, { width: LARGHEZZA_UTILE });
        y = pdf.y + mm(1.5);
      });

      // --- Sezione di pagamento QR (ultimi 105 mm della pagina) ---
      new SwissQRBill(datiQr(fattura), { language: "IT" }).attachTo(pdf);
      pdf.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generaPdfFattura, indirizzoCompleto, swissUtils };

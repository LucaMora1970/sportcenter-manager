// ============================================================
// giocatori-padel.js — hub pubblico della Community Padel: registrazione
// giocatore (socio o esterno), classifica, proposta di sessioni con
// quorum e blocco provvisorio del campo, risposta agli inviti ricevuti
// via link (?invito=token) e verifica email (?verifica=token).
//
// Identità: un socio riusa la propria sessione "dispositivo riconosciuto"
// (sociDevices, vedi abbonamento.js) — se firebase.auth() ha un utente ma
// giocatoriPadel/{uid} non esiste, è per forza un socio non ancora
// registrato come giocatore Padel (un esterno ottiene l'identità solo
// alla registrazione, creata insieme al documento giocatoriPadel, vedi
// registraGiocatorePadel lato server). Nessun account tradizionale.
//
// Richiede firebase-config.js e utils.js già caricati (NON auth.js: qui
// non c'è login staff).
// ============================================================

let currentUid = null;
let currentGiocatore = null; // giocatoriPadel/{uid} se già registrato
let classificaCache = [];

const STATO_SESSIONE_LABEL = { aperta: "In attesa di conferme", confermata: "Confermata", scaduta: "Scaduta", annullata: "Annullata" };

function mostraStato(id) {
  ["stato-caricamento", "stato-verifica-email", "stato-invito", "stato-registrazione", "area-content"].forEach(s => {
    document.getElementById(s).classList.toggle("hidden", s !== id);
  });
}

function invitoTokenCorrente() {
  return new URLSearchParams(location.search).get("invito");
}

// ---------- Verifica email (?verifica=token) ----------

async function gestisciVerificaEmail(token) {
  mostraStato("stato-verifica-email");
  try {
    const fn = cloudFunctions().httpsCallable("verificaEmailGiocatorePadel");
    await fn({ token });
    document.getElementById("verifica-email-titolo").textContent = "Email confermata";
    document.getElementById("verifica-email-testo").textContent = "Il tuo profilo giocatore Padel resta attivo. Puoi chiudere questa pagina.";
  } catch (err) {
    document.getElementById("verifica-email-titolo").textContent = "Link non valido";
    document.getElementById("verifica-email-testo").textContent = err.message || "Il link è scaduto oppure è già stato usato.";
  }
}

// ---------- Registrazione ----------

async function socioIdDelDispositivo(uid) {
  try {
    const doc = await db.collection("sociDevices").doc(uid).get();
    const profili = doc.exists ? (doc.data().profili || []) : [];
    return profili[0] ? profili[0].socioId : null;
  } catch {
    return null;
  }
}

async function ricaricaGiocatore() {
  if (!currentUid) { currentGiocatore = null; return; }
  const doc = await db.collection("giocatoriPadel").doc(currentUid).get();
  currentGiocatore = doc.exists ? doc.data() : null;
}

async function onSubmitRegistrazione(e) {
  e.preventDefault();
  const btn = document.getElementById("registrazione-btn");
  const errorEl = document.getElementById("registrazione-error");
  errorEl.textContent = "";

  if (!document.getElementById("reg-consenso").checked) {
    showError(errorEl, "Devi accettare il trattamento dei dati per registrarti.");
    return;
  }

  btn.disabled = true;
  try {
    const payload = {
      nome: document.getElementById("reg-nome").value.trim(),
      cognome: document.getElementById("reg-cognome").value.trim(),
      pseudonimo: document.getElementById("reg-pseudonimo").value.trim(),
      telefono: document.getElementById("reg-telefono").value.trim(),
      email: document.getElementById("reg-email").value.trim() || null,
      playtomicLivello: document.getElementById("reg-playtomic").value !== "" ? parseFloat(document.getElementById("reg-playtomic").value) : null,
      consenso: true
    };
    if (currentUid) payload.socioId = await socioIdDelDispositivo(currentUid);

    const fn = cloudFunctions().httpsCallable("registraGiocatorePadel");
    const { data } = await fn(payload);

    if (data.customToken) {
      await firebase.auth().signInWithCustomToken(data.customToken);
      // onAuthStateChanged si occupa del resto (currentUid/currentGiocatore
      // e della schermata successiva, invito compreso).
    } else {
      currentUid = currentUid || (firebase.auth().currentUser || {}).uid;
      await ricaricaGiocatore();
      const invito = invitoTokenCorrente();
      if (invito) await gestisciInvito(invito);
      else await mostraAreaContent();
    }
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
    btn.disabled = false;
  }
}

// ---------- Invito a una sessione (?invito=token) ----------

async function gestisciInvito(token) {
  mostraStato("stato-invito");
  const card = document.getElementById("invito-card");
  card.innerHTML = `<p style="color:var(--chalk-grey);font-size:0.84rem;">Caricamento…</p>`;

  let invito;
  try {
    const doc = await db.collection("sessioniPadelInviti").doc(token).get();
    if (!doc.exists) throw new Error("Invito non trovato.");
    invito = doc.data();
  } catch (err) {
    card.innerHTML = `<p>${escapeHtml(err.message)}</p>`;
    return;
  }

  if (!currentUid) {
    card.innerHTML = `
      <p>Per rispondere a questo invito devi prima riconoscere il dispositivo.</p>
      <p style="margin-top:10px;"><a href="attiva-socio.html" class="btn btn-ghost" style="display:inline-block;width:auto;">Sono socio — attiva dispositivo</a></p>
      <p style="margin-top:10px;color:var(--chalk-grey);font-size:0.84rem;">Non sei socio? Registrati qui sotto come giocatore esterno — il link ti riporterà automaticamente su questo invito.</p>
    `;
    document.getElementById("stato-registrazione").classList.remove("hidden");
    return;
  }

  if (!currentGiocatore) {
    card.innerHTML = `<p>Registrati come giocatore Padel qui sotto per rispondere a questo invito.</p>`;
    document.getElementById("stato-registrazione").classList.remove("hidden");
    return;
  }

  let sessione;
  try {
    const sDoc = await db.collection("sessioniPadel").doc(invito.sessioneId).get();
    if (!sDoc.exists) throw new Error("Proposta non trovata.");
    sessione = sDoc.data();
  } catch (err) {
    card.innerHTML = `<p>${escapeHtml(err.message)}</p>`;
    return;
  }

  if (sessione.stato !== "aperta") {
    card.innerHTML = `<p>Questa proposta non è più aperta (${escapeHtml(STATO_SESSIONE_LABEL[sessione.stato] || sessione.stato)}).</p>`;
    return;
  }

  const orgDoc = await db.collection("giocatoriPadel").doc(sessione.organizerId).get();
  const orgNome = orgDoc.exists ? `${orgDoc.data().nome} ${orgDoc.data().cognome}` : "Un giocatore";

  card.innerHTML = `
    <p><strong>${escapeHtml(orgNome)}</strong> ti invita a giocare il ${escapeHtml(sessione.date)} alle ${escapeHtml(sessione.startTime)}–${escapeHtml(sessione.endTime)}.</p>
    <div style="display:flex;gap:10px;margin-top:14px;">
      <button type="button" class="btn btn-primary" id="invito-si-btn">Sì, ci sto</button>
      <button type="button" class="btn btn-ghost" id="invito-no-btn">Non posso</button>
    </div>
    <div class="error-msg" id="invito-error"></div>
  `;
  document.getElementById("invito-si-btn").addEventListener("click", () => rispondiInvito(token, "si"));
  document.getElementById("invito-no-btn").addEventListener("click", () => rispondiInvito(token, "no"));
}

async function rispondiInvito(token, risposta) {
  const errorEl = document.getElementById("invito-error");
  try {
    const fn = cloudFunctions().httpsCallable("rispondiInvitoSessionePadel");
    const { data } = await fn({ token, risposta });
    document.getElementById("invito-card").innerHTML = `<p>${risposta === "si" ? "Presenza confermata!" : "Hai segnalato di non poter partecipare."}${data.confermata ? " La partita ha raggiunto il numero di giocatori richiesto ed è ora confermata." : ""}</p>`;
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
  }
}

// ---------- Classifica ----------

async function caricaClassifica() {
  const el = document.getElementById("classifica-list");
  try {
    const snap = await db.collection("giocatoriPadel").where("attivo", "==", true).orderBy("livelloEffettivo", "desc").get();
    classificaCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    el.innerHTML = `<p style="color:var(--chalk-grey);font-size:0.84rem;">Errore nel caricamento: ${escapeHtml(err.message)}</p>`;
    return;
  }
  el.innerHTML = classificaCache.length > 0
    ? classificaCache.map(g => `
        <div class="gp-classifica-row">
          <span>${escapeHtml(g.nome)} ${escapeHtml(g.cognome)}</span>
          <span class="livello">${g.livelloEffettivo != null ? g.livelloEffettivo.toFixed(2) : "—"}</span>
        </div>
      `).join("")
    : `<p style="color:var(--chalk-grey);font-size:0.84rem;">Nessun giocatore registrato ancora.</p>`;
  renderInvitatiCheckbox();
}

function renderInvitatiCheckbox() {
  const el = document.getElementById("proponi-invitati-list");
  const altri = classificaCache.filter(g => g.id !== currentUid);
  el.innerHTML = altri.length > 0
    ? altri.map(g => `
        <div class="checkbox-row">
          <input type="checkbox" class="pr-invitato-cb" value="${g.id}" id="pr-inv-${g.id}">
          <label for="pr-inv-${g.id}">${escapeHtml(g.nome)} ${escapeHtml(g.cognome)} (${g.livelloEffettivo != null ? g.livelloEffettivo.toFixed(2) : "—"})</label>
        </div>
      `).join("")
    : `<p style="color:var(--chalk-grey);font-size:0.82rem;">Nessun altro giocatore registrato ancora — invita via email qui sotto.</p>`;
}

// ---------- Proponi una sessione ----------

async function onSubmitProponi(e) {
  e.preventDefault();
  const btn = document.getElementById("proponi-btn");
  const errorEl = document.getElementById("proponi-error");
  errorEl.textContent = "";
  btn.disabled = true;

  try {
    const invitatiIds = Array.from(document.querySelectorAll(".pr-invitato-cb:checked")).map(cb => cb.value);
    const invitiEmail = document.getElementById("pr-email-extra").value.split(",").map(s => s.trim()).filter(Boolean);

    const fn = cloudFunctions().httpsCallable("proponiSessionePadel");
    const { data } = await fn({
      date: document.getElementById("pr-data").value,
      startTime: document.getElementById("pr-ora").value,
      durationMinutes: parseInt(document.getElementById("pr-durata").value, 10),
      targetHeadcount: parseInt(document.getElementById("pr-headcount").value, 10),
      invitatiIds,
      invitiEmail
    });

    const esitoEl = document.getElementById("proponi-esito");
    esitoEl.classList.remove("hidden");
    const righeInviti = (data.inviti || []).map(i => {
      const nome = (classificaCache.find(g => g.id === i.giocatoreId) || {}).nome || "Invitato";
      return `
        <div class="gp-invito-riga">
          <span>${escapeHtml(nome)}</span>
          <span>
            <button type="button" class="btn btn-ghost copia-invito-btn" data-link="${escapeHtml(i.link)}" style="width:auto;padding:6px 10px;font-size:0.7rem;">Copia link</button>
            <a href="https://wa.me/?text=${encodeURIComponent(i.link)}" target="_blank" rel="noopener" class="btn btn-ghost" style="width:auto;padding:6px 10px;font-size:0.7rem;display:inline-block;">WhatsApp</a>
          </span>
        </div>
      `;
    }).join("");
    const rigaLinkAperto = data.linkAperto ? `
      <div class="gp-invito-riga">
        <span>Link aperto — per chiunque, primo arrivato primo servito</span>
        <span>
          <button type="button" class="btn btn-ghost copia-invito-btn" data-link="${escapeHtml(data.linkAperto)}" style="width:auto;padding:6px 10px;font-size:0.7rem;">Copia link</button>
          <a href="https://wa.me/?text=${encodeURIComponent(data.linkAperto)}" target="_blank" rel="noopener" class="btn btn-ghost" style="width:auto;padding:6px 10px;font-size:0.7rem;display:inline-block;">WhatsApp</a>
        </span>
      </div>
    ` : "";
    esitoEl.innerHTML = `
      <p><strong>Proposta lanciata.</strong> Condividi questi link con gli invitati:</p>
      ${righeInviti || `<p style="color:var(--chalk-grey);font-size:0.82rem;">Nessun invitato dalla classifica — controlla gli eventuali inviti via email.</p>`}
      <p style="color:var(--chalk-grey);font-size:0.82rem;margin:14px 0 0;">Oppure posta questo link dove vuoi (es. gruppo WhatsApp del circolo) — chi risponde per primo occupa i posti rimasti, fino al numero richiesto:</p>
      ${rigaLinkAperto}
    `;
    esitoEl.querySelectorAll(".copia-invito-btn").forEach(b => b.addEventListener("click", () => copyToClipboard(b.dataset.link, b)));

    document.getElementById("proponi-form").reset();
    await caricaMieProposte();
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------- Le mie proposte ----------

async function caricaMieProposte() {
  const el = document.getElementById("mie-proposte-list");
  if (!currentUid) return;
  try {
    const snap = await db.collection("sessioniPadel").where("organizerId", "==", currentUid).get();
    const proposte = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0));
    el.innerHTML = proposte.length > 0
      ? proposte.map(s => {
          const confermeSi = (s.invitati || []).filter(i => i.stato === "si").length;
          return `
            <div class="gp-classifica-row">
              <span>${escapeHtml(s.date)} ${escapeHtml(s.startTime)}–${escapeHtml(s.endTime)} — ${escapeHtml(STATO_SESSIONE_LABEL[s.stato] || s.stato)} (${confermeSi}/${(s.targetHeadcount || 0) - 1} conferme)</span>
              ${s.stato === "aperta" ? `<button type="button" class="btn btn-danger annulla-proposta-btn" data-id="${s.id}" style="width:auto;padding:6px 10px;font-size:0.7rem;">Annulla</button>` : ""}
            </div>
          `;
        }).join("")
      : `<p style="color:var(--chalk-grey);font-size:0.84rem;">Nessuna proposta lanciata ancora.</p>`;
    el.querySelectorAll(".annulla-proposta-btn").forEach(b => b.addEventListener("click", () => annullaProposta(b.dataset.id)));
  } catch (err) {
    el.innerHTML = `<p style="color:var(--chalk-grey);font-size:0.84rem;">Errore nel caricamento: ${escapeHtml(err.message)}</p>`;
  }
}

async function annullaProposta(sessioneId) {
  if (!confirm("Annullare questa proposta? Il campo si libera subito.")) return;
  try {
    const fn = cloudFunctions().httpsCallable("annullaPropostaSessionePadel");
    await fn({ sessioneId });
    await caricaMieProposte();
  } catch (err) {
    alert("Errore: " + err.message);
  }
}

// ---------- Tab ----------

function attivaTab(tab) {
  document.querySelectorAll(".gp-tab-btn").forEach(b => b.dataset.active = String(b.dataset.tab === tab));
  document.querySelectorAll(".gp-tab-panel").forEach(p => p.classList.toggle("hidden", p.id !== "tab-" + tab));
  if (tab === "mie") caricaMieProposte();
}

// ---------- Init ----------

async function mostraAreaContent() {
  mostraStato("area-content");
  document.getElementById("pr-data").min = new Date().toISOString().slice(0, 10);
  await caricaClassifica();
  attivaTab("classifica");
}

(async function init() {
  await loadDatiCentro();
  document.getElementById("centro-kicker").textContent = DATI_CENTRO.nome;

  document.getElementById("registrazione-form").addEventListener("submit", onSubmitRegistrazione);
  document.getElementById("proponi-form").addEventListener("submit", onSubmitProponi);
  document.querySelectorAll(".gp-tab-btn").forEach(b => b.addEventListener("click", () => attivaTab(b.dataset.tab)));

  const params = new URLSearchParams(location.search);
  const verificaToken = params.get("verifica");
  if (verificaToken) {
    await gestisciVerificaEmail(verificaToken);
    return;
  }

  firebase.auth().onAuthStateChanged(async (user) => {
    currentUid = user ? user.uid : null;
    await ricaricaGiocatore();

    const invito = invitoTokenCorrente();
    if (invito) {
      await gestisciInvito(invito);
      return;
    }

    if (!currentGiocatore) {
      mostraStato("stato-registrazione");
      return;
    }
    await mostraAreaContent();
  });
})();

// ============================================================
// auth.js — login, sessione, caricamento ruolo/permessi utente
// Richiede firebase-config.js già caricato prima di questo file.
// ============================================================

/**
 * Recupera il documento utente (users/{uid}) e il documento ruolo
 * collegato (roles/{ruoloId}) con l'elenco dei permessi.
 * Ritorna { uid, nome, ruoloId, permessi: [...] } oppure null.
 */
async function getCurrentUserProfile() {
  const user = auth.currentUser;
  if (!user) return null;

  const userSnap = await db.collection("users").doc(user.uid).get();
  if (!userSnap.exists) return null;
  const userData = userSnap.data();

  let permessi = [];
  if (userData.ruoloId) {
    const roleSnap = await db.collection("roles").doc(userData.ruoloId).get();
    if (roleSnap.exists) permessi = roleSnap.data().permessi || [];
  }

  return {
    uid: user.uid,
    email: user.email,
    nome: userData.nome || user.email,
    ruoloId: userData.ruoloId || null,
    ruoloNome: userData.ruoloNome || "",
    attivo: userData.attivo !== false,
    soggettoQuotaCampo: !!userData.soggettoQuotaCampo,
    puoRichiederePagamento: !!userData.puoRichiederePagamento,
    permessi
  };
}

/** true se il profilo ha il permesso indicato (o è admin con "*") */
function hasPermission(profile, permesso) {
  if (!profile) return false;
  if (profile.permessi.includes("*")) return true;
  return profile.permessi.includes(permesso);
}

// Pagina su cui atterrare dopo il login: il diario resta la home per lo
// staff "normale", ma un account che ha SOLO il permesso azienda:propria
// (referente aziendale puro, senza altri permessi da staff) non potrebbe
// nemmeno usare il diario — la sua pagina naturale è il proprio portale.
function paginaIniziale(profile) {
  const soloAzienda = profile.permessi.length > 0
    && profile.permessi.every(p => p === "azienda:propria");
  return soloAzienda ? "azienda.html" : "diario.html";
}

// Vero amministratore, a differenza di hasPermission() che ritorna sempre
// true per l'admin qualunque permesso si chieda — serve per distinguere,
// es., "può gestire il diario di tutti" da "è l'amministratore" (le voci
// diario approvate sono modificabili solo dal vero admin, non da chi ha
// solo diario:gestisci_tutti). Stessa logica di isAdmin() in firestore.rules.
function isAdmin(profile) {
  return !!profile && profile.permessi.includes("*");
}

/**
 * Protegge una pagina: se non loggato, rimanda a index.html.
 * Se loggato, richiama callback(profile) con il profilo caricato.
 * Se l'utente non è "attivo", forza il logout.
 */
function requireAuth(callback) {
  auth.onAuthStateChanged(async (user) => {
    if (!user) {
      window.location.href = "index.html";
      return;
    }
    const profile = await getCurrentUserProfile();
    if (!profile || !profile.attivo) {
      await auth.signOut();
      window.location.href = "index.html";
      return;
    }
    callback(profile);
  });
}

function logout() {
  sessionStorage.removeItem("sportos-test-come");
  auth.signOut().then(() => {
    window.location.href = "index.html";
  });
}

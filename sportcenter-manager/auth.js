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
    permessi
  };
}

/** true se il profilo ha il permesso indicato (o è admin con "*") */
function hasPermission(profile, permesso) {
  if (!profile) return false;
  if (profile.permessi.includes("*")) return true;
  return profile.permessi.includes(permesso);
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
  auth.signOut().then(() => {
    window.location.href = "index.html";
  });
}

// ============================================================
// image-upload.js — ridimensiona/comprimi un'immagine lato client
// (canvas) prima di caricarla su Firebase Storage, così il file che
// arriva ai visitatori delle pagine pubbliche resta leggero anche se
// chi carica seleziona una foto scattata a piena risoluzione dal
// telefono. Richiede firebase-storage-compat.js caricato prima di
// questo script (solo su configurazione.html, unica pagina che carica
// immagini).
// ============================================================

// Ridimensiona un File immagine dentro maxWidth×maxHeight (mantenendo le
// proporzioni, mai ingrandisce) e lo ricodifica come JPEG alla qualità
// indicata. Ritorna un Blob pronto per l'upload.
async function resizeImageFile(file, maxWidth, maxHeight, quality = 0.75) {
  const bitmap = await createImageBitmap(file);
  const ratio = Math.min(1, maxWidth / bitmap.width, maxHeight / bitmap.height);
  const width = Math.round(bitmap.width * ratio);
  const height = Math.round(bitmap.height * ratio);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Impossibile comprimere l'immagine.")), "image/jpeg", quality);
  });
}

// Ridimensiona e carica su Storage al percorso indicato, sovrascrivendo
// eventuale file esistente allo stesso percorso — comodo per gli slot
// fissi (es. "discipline/tennis-interno.jpg") dove ogni nuovo caricamento
// sostituisce il precedente senza lasciare file orfani. Ritorna l'URL
// pubblico di download da salvare su Firestore.
async function uploadCompressedImage(file, storagePath, { maxWidth = 1600, maxHeight = 900, quality = 0.75 } = {}) {
  const blob = await resizeImageFile(file, maxWidth, maxHeight, quality);
  const ref = firebase.storage().ref(storagePath);
  await ref.put(blob, { contentType: "image/jpeg" });
  return ref.getDownloadURL();
}

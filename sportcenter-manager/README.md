# sportcenter-manager Luca

Gestionale mobile-first per centro sportivo (tennis, padel, squash): diario ore
dipendenti, corsi, camp, prenotazioni padel, amministrazione. Stack identico a
cinemanager: GitHub Pages (hosting statico) + Firebase (Firestore + Auth).

## Stato attuale
- [x] Login (Firebase Authentication — Email/Password)
- [x] Diario giornaliero: inserimento voci ore + riepilogo del giorno
- [ ] Riepilogo mensile ore per dipendente
- [ ] Gestione corsi
- [ ] Camp fuori sede
- [ ] Tabellone prenotazioni Padel (slot 60/90 min)
- [ ] Iscrizioni online + pagamenti
- [ ] Pannello admin: gestione utenti/ruoli/permessi personalizzati

## Setup

### 1. Firebase
1. Crea un nuovo progetto su [Firebase Console](https://console.firebase.google.com)
2. Attiva **Authentication** → provider Email/Password
3. Attiva **Firestore Database** (modalità produzione)
4. Project Settings → Your apps → Aggiungi web app → copia le chiavi in `js/firebase-config.js`
5. Firestore → Rules → incolla il contenuto di `firestore.rules`

### 2. Crea utenti e ruoli iniziali
In Firestore, crea a mano (o via script) i primi documenti:

```
roles/admin
  { permessi: ["*"] }

roles/maestro
  { permessi: ["diario:scrivi_proprio"] }

users/{uid-del-primo-admin}
  { nome: "Nome Cognome", ruoloId: "admin", ruoloNome: "Amministrazione", attivo: true }
```

L'uid si ottiene creando l'utente in Authentication e copiando lo User UID.

### 3. GitHub Pages
1. Crea repo `sportcenter-manager` su GitHub, push di questi file su `main`
2. Settings → Pages → Deploy from branch `main` / root
3. Sito live su `https://<tuo-utente>.github.io/sportcenter-manager/`

## Struttura dati Firestore

**users/{uid}**
```
nome, ruoloId, ruoloNome, attivo (bool)
```

**roles/{roleId}**
```
permessi: string[]   // es. ["diario:scrivi_proprio", "diario:leggi_tutti"], oppure ["*"] per admin
```

**diario/{entryId}**
```
userId, userNome, data (YYYY-MM-DD), disciplina (tennis|padel|squash),
tipoAttivita, oraInizio, oraFine, ore (number), note, createdAt
```

## Struttura file
```
index.html          → login
diario.html          → diario giornaliero (prima pagina operativa)
css/style.css        → design system condiviso
js/firebase-config.js → chiavi progetto Firebase (da compilare)
js/auth.js            → sessione, ruolo, permessi
js/diario.js          → logica diario
firestore.rules       → regole di sicurezza basate su ruoli/permessi
```

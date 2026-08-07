# Sport-OS

Gestionale mobile-first per centri sportivi (tennis, padel, squash): diario ore
dipendenti, configurazione tariffe e quote campo, resoconti per periodo con
costi. HTML/CSS/JS puro (nessun build step) + Firebase (Firestore + Auth),
hosting su GitHub Pages.

Questa istanza è personalizzata per: **NOME CIRCOLO** (vedi `index.html`).

## Stato attuale
- [x] Login (Firebase Authentication — Email/Password)
- [x] Diario giornaliero: righe multiple, campo, tipo attività, tipo gruppo (padel), Nr. ore o orari
- [x] Pannello Configurazione: tipi utenza, campi (con posizione interno/esterno), tipi gruppo padel, tipi attività (con tariffe cliente), quote campo
- [x] Pannello Team: gestione utenti, ruoli e permessi
- [x] Resoconto per periodo libero (dal/al): ore e costi per tipo attività, per dipendente, quota campo dovuta al circolo, totale complessivo
- [ ] Gestione corsi
- [ ] Camp fuori sede
- [ ] Tabellone prenotazioni Padel (slot 60/90 min)
- [ ] Iscrizioni online + pagamenti

## Setup

### 1. Firebase
1. Crea un nuovo progetto su [Firebase Console](https://console.firebase.google.com)
2. Attiva **Authentication** → provider Email/Password
3. Attiva **Firestore Database** (modalità produzione)
4. Project Settings → Your apps → Aggiungi web app → copia le chiavi in `js/firebase-config.js`
5. Firestore → Rules → incolla il contenuto di `firestore.rules`

### 2. Crea utente e ruolo admin iniziali
In Firestore, crea a mano i primi documenti:

```
roles/admin
  { permessi: ["*"] }

users/{uid-del-primo-admin}
  { nome: "Nome Cognome", ruoloId: "admin", ruoloNome: "Amministrazione", attivo: true }
```

L'uid si ottiene creando l'utente in Authentication e copiando lo User UID.

Da qui in poi, tutto il resto (altri ruoli/utenti, tipi attività, tariffe,
campi, quote campo) si configura direttamente dall'app, dai pannelli **Team**
e **Configurazione**.

### 3. GitHub Pages
1. Push di questi file sul branch `main`
2. Settings → Pages → Deploy from branch `main` / root
3. Sito live su `https://<tuo-utente>.github.io/<repo>/`

## Struttura dati Firestore

**users/{uid}**
```
nome, email, ruoloId, ruoloNome, attivo (bool), soggettoQuotaCampo (bool)
```

**roles/{roleId}**
```
permessi: string[]   // es. ["diario:leggi_tutti", "config:gestisci"], oppure ["*"] per admin
```

**diario/{entryId}**
```
userId, userNome, data (YYYY-MM-DD), disciplina (tennis|padel|squash),
tipoAttivitaId, tipoAttivitaNome, campoNumero, tipoGruppoId, tipoGruppoNome (padel),
oraInizio, oraFine, ore (number), note, createdAt
```

**tipiUtenza/{id}** — `nome, attivo`

**campi/{id}** — `numero, disciplina, posizione (interno|esterno), attivo`

**tipiGruppoPadel/{id}** — `nome, attivo`

**tipiAttivita/{id}** — `nome, disciplina, attivo, soggettoQuotaCampo (bool), prezzi[] (tipoUtenzaId, periodoInizio, periodoFine, prezzoOra)`

**quoteCampo/{id}** — `disciplina, posizione, periodoInizio, periodoFine, importo, durataMinuti (solo padel), fasciaOraria (solo padel)`

## Struttura file
```
index.html              → login
diario.html              → diario giornaliero
utenti.html               → gestione utenti e ruoli
configurazione.html       → tipi attività, tariffe, campi, quote campo
resoconto.html             → resoconto ore/costi per periodo
css/style.css             → design system condiviso
js/firebase-config.js     → chiavi progetto Firebase (da compilare)
js/utils.js                → costanti e helper condivisi
js/auth.js                  → sessione, ruolo, permessi
js/diario.js                 → logica diario
js/users.js                   → logica utenti/ruoli
js/configurazione.js          → logica pannello configurazione
js/resoconto.js                → logica resoconto
firestore.rules                → regole di sicurezza basate su ruoli/permessi
```

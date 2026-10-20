# NavPlotter App

App per Android (poi macOS e forse iPhone) per i nodi NavPlotter: la stessa web app servita dai nodi,
impacchettata con Capacitor, che si collega al nodo via WiFi e funziona senza internet.

## Come funziona

- `www/index.html` è la web app del firmware (`web/index.html` di Navplotter-tdeck-plus), copiata con
  `npm run sync-web` (dal file su GitHub, oppure `npm run sync-web -- percorso/index.html`).
- `www/navplotter-bridge.js` viene caricato prima della web app e:
  - manda le richieste `/api/...` e le carte `/tiles/...` al nodo (di solito `http://192.168.4.1`),
    attraverso l'HTTP nativo di Capacitor, così il nodo non deve cambiare nulla;
  - aggiunge in Setup una scheda "App" con l'indirizzo del nodo e i comandi della guardia;
  - avvia il servizio di guardia nativo.
- `www/navplotter-meteo.js` viene caricato dopo la web app (solo nell'app, il nodo non lo ha) e aggiunge:
  - sulla carta il pulsante ≋: vento (barbe in nodi), corrente (frecce) o temporali (pioggia, aria instabile,
    temporale e temporale forte da codice meteo, CAPE e precipitazione, con un fulmine dove è previsto un
    temporale), con una barra per scorrere le ore; un tocco sul mare mostra i valori in quel punto;
    la pianificazione avvisa se una tratta incontra temporali o aria instabile e a che ora;
  - nella pagina Waypoint la scheda "Pianifica": per una rotta, partenza e velocità media, calcola orari,
    vento, corrente e onda per ogni tratta, con avvisi e il confronto tra altri orari di partenza;
    con "A vela" simula i bordi: virate di bolina (angolo al vento e distanza massima dalla rotta
    impostabili, oppure solo sulle lay-line) e strambate in poppa piena, con miglia percorse e tempo in più;
    la velocità a vela viene dalla polare della barca (generata dalla lunghezza al galleggiamento, importata da
    un file .pol/.csv o scritta a mano, con il diagramma polare) e gli angoli di bolina e poppa migliori
    per ogni vento si ricavano da lei; un rendimento in % adatta la polare alla barca carica;
    i bordi possono venire dalle isocrone (la strada più veloce con vento e corrente previsti, tratta per
    tratta, dentro la distanza massima dalla rotta; le isocrone di ogni ora si vedono sulla carta) o dalle
    regole semplici sulle lay-line;
    "Mostra sulla carta" disegna il piano con la barca nella posizione stimata all'ora scelta.
  - Waypoint spostabili sulla carta: tocco lungo sul waypoint e trascinarlo; nella scheda del waypoint c'è
    "Annulla spostamento".
  - Previsioni da [Open-Meteo](https://open-meteo.com) (dati CC BY 4.0), scaricate quando c'è internet e
    tenute sul telefono per l'uso in mare. Sulla WiFi del nodo l'app esce su internet con i dati mobili
    (metodo nativo `NodeWatch.internetGet`).
- `NodeWatchService` (Android) è un servizio in primo piano che chiede `/api/state` ogni 2 secondi
  anche a schermo spento:
  - se un bersaglio è in allarme suona la suoneria di sveglia del telefono in loop (canale "allarme",
    suona anche col telefono in silenzioso), vibra e mostra una notifica con "Silenzia";
  - per ogni nuovo messaggio non letto mostra una notifica;
  - se il nodo non risponde per 30 secondi avvisa che l'allarme non può arrivare;
  - lega l'app alla WiFi del nodo quando questa non ha internet, altrimenti Android userebbe i dati mobili.

## APK di prova

Ogni push costruisce un APK di debug con GitHub Actions e lo pubblica come pre-release
`apk-<ramo>` nella pagina Releases del repository: si scarica direttamente dal telefono.

## Build in locale

Servono Node 22, JDK 21 e Android SDK (API 35).

```
npm ci
npm run build:android    # APK in android/app/build/outputs/apk/debug/
```

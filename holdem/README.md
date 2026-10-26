# Holdem-huone

Moninpeli Texas Hold'em selaimessa. Pelataan pelkillä pelimerkeillä, ei oikeaa rahaa.

## Käynnistys

```bash
npm install
npm start
```

Avaa http://localhost:3000. Kokeile yksin: istu pöytään ja paina "Lisää botti".

Testit: `npm test` (moottorin simulaatio) ja `node test/e2e.js` (koko palvelin WebSocketilla).

## Mitä sisältää

- Tilit nimellä (selain muistaa tunnisteen), aloituspankki 10 000, päivän bonus 2 000 ja uusi alku jos pelimerkit loppuvat
- 3 valmista pöytää, omien pöytien luonti (blindit ja paikkamäärä valittavissa)
- Täysi Hold'em: blindit, check/call/raise/all-in, sivupotit, tasapelit, minimikorotussäännöt, heads-up-säännöt
- 25 s vuoroaika, automaattinen fold/check, "poissa pelistä", yhteyden katkeamisen käsittely
- Botit, chat, tapahtumaloki, parhaan käden korostus, toimii puhelimella

## Asetukset

| Ympäristömuuttuja | Oletus | Merkitys |
|---|---|---|
| `PORT` | 3000 | Portti |
| `DATA_DIR` | `./data` | Minne pelaajat ja pankit tallennetaan (`users.json`) |

## Julkaisu nettiin

Tarvitset palvelun, joka ajaa pitkäikäistä Node-prosessia ja tukee WebSocketeja (esim. Fly.io, Railway, Render tai oma VPS).
Aseta `DATA_DIR` pysyvälle levylle, muuten tilit katoavat uudelleenkäynnistyksessä. Laita HTTPS eteen (palvelut tekevät tämän itse), niin selain käyttää `wss://`-yhteyttä automaattisesti.

## Rajoitukset

- Pelaajat tunnistetaan selaimeen tallennetulla tunnisteella, ei salasanalla. Jos tyhjennät selaimen tiedot, tili ei avaudu uudelleen.
- Yksi palvelinprosessi (ei jaettu useammalle koneelle).
- Älä yhdistä pelimerkkejä oikeaan rahaan (osto, nosto, palkinnot). Rahapelitoiminta vaatii luvan.

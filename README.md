# Modulair terrein — 3D-catalogus

Een bladerbare catalogus van 394 modellen uit een modulair terreinpakket:
kliffen, wanden, keermuren, paden, gras, zand, water, een grot en losse props.
Alles draait in de browser, zonder build-stap en zonder server — `index.html`
openen is genoeg.

Opgezet naar het voorbeeld van de 3D-catalogus van
[Taaleiland](https://github.com/Paumen/Taalei): dezelfde tabbladen, dezelfde
zoekbalk, hetzelfde detailvenster en dezelfde selectiebalk. Het verschil zit in
de bron. Daar beschrijft een handgeschreven manifest welke kits er zijn; hier
kwam de pack zonder ook maar één regel metadata binnen en is de hele indeling
afgeleid uit de bestandsnamen.

## De catalogus gebruiken

**Zes tabbladen** kijken elk anders naar dezelfde 394 modellen:

| Tabblad | Deelt in op | Waarvoor |
| --- | --- | --- |
| Onderdelen | familie | "laat me alle keermuren zien" |
| Vormen | binnenbocht, buitenbocht, esse, recht, helling… | "welke stukken maken deze bocht af?" |
| Lagen | onder, basis, midden, boven | "wat stapelt er op deze rij?" |
| Formaten | rastermaat uit de naam | "wat past er in dit gat van 3 × 3?" |
| Grot | de ondergrondse deelverzameling | een grot bouwen |
| Kust | water, zand, steigers en bruggen | een kustlijn bouwen |

Grot en Kust zijn geen aparte kit: hun stukken staan ook in de vier andere
tabbladen.

Verder:

- **Zoeken** op naam, familie, vorm, laag, rastermaat, kenmerk of materiaal.
  "binnenbocht", "getrapt", "3 × 3" en "hout" doen allemaal iets.
- **Filteren op materiaal** met de chips onder de zoekbalk. Links waar een stuk
  van gemaakt is, rechts de vlakken die de pack als verborgen markeert — de
  zijden die tegen een buurtegel aan komen te liggen.
- **Een tegel aanklikken** geeft het model groot, draaibaar, met zijn maten,
  driehoekstelling, materialen en de knoppen *Kopieer pad* en *Download .glb*.
- **Meerdere stukken selecteren** met het vinkje linksboven op een tegel;
  shift-klik trekt de selectie door over alles wat op dat moment in beeld staat.
  De balk onderin kopieert alle paden in één keer naar het klembord. De selectie
  hangt aan het bestand, niet aan de tegel: hetzelfde model in twee tabbladen
  aanvinken levert één pad op.
- **Deeplinks** werken: `#vormen` opent een tabblad, `#onderdelen-keermuur`
  springt naar een sectie.

## Wat er in de repo staat

```
index.html                 de pagina zelf
catalog/catalog.css        opmaak
catalog/catalog.js         de catalogus in de browser
catalog/catalog.json       gegenereerd; alles wat de pagina weet
models/*.glb               de 394 modellen, ongewijzigd zoals aangeleverd
vendor/model-viewer.min.js Google's <model-viewer> (BSD-3-Clause)
tools/build-catalog.mjs    bouwt catalog.json vanuit models/
tools/taxonomie.mjs        de indeling: families, vormen, lagen, formaten
tools/glb.mjs              GLB lezen en opmeten
HERKOMST.md                waar de pack vandaan komt en wat eraan mankeert
```

## De catalogus opnieuw bouwen

```sh
node tools/build-catalog.mjs
```

Leest elke `.glb` in `models/`, meet hem op, leidt zijn plaats in de indeling af
uit zijn naam, en schrijft `catalog/catalog.json` plus een verse versiehash in
`index.html`. Geen dependencies; Node 18 of nieuwer.

De build is ook de controle op zichzelf. Hij klaagt over modellen die in geen
enkel tabblad terechtkomen, over materialen zonder Nederlandse naam, over
modellen die ver naast hun rastermaat vallen, over ontbrekende texturen en over
modellen boven het driehoekenbudget.

### De indeling aanpassen

Alles wat de catalogus over de kit "weet" staat in `tools/taxonomie.mjs`: de
families met hun uitleg en kleur, de vormen met hun patroon, de lagen, de
formaatgroepen, de kenmerken en de tabbladen. Eén tabel per facet, regels van
boven naar beneden, de eerste die past wint. Een verkeerd ingedeeld model is
daar op één plek recht te zetten; daarna `node tools/build-catalog.mjs`.

## Waar je op moet letten

De pack kwam **zonder licentie** binnen en de maker is niet bekend. Ga er niet
vanuit dat deze modellen vrij te gebruiken zijn — zie
[HERKOMST.md](HERKOMST.md).

Daar staat ook wat er tijdens de FBX-conversie is scheefgelopen: de
materiaalkleuren staan in de verkeerde kleurruimte (de catalogus rekent ze bij
het tonen terug, de bestanden blijven zoals ze zijn), en 67 modellen verwijzen
naar texturen die niet in de pack zitten.

Eén rastervak is **100 eenheden** in de bronbestanden; alle maten in de
catalogus staan in rastervakken.

## Publiceren

`.github/workflows/static.yml` zet de repo bij elke push op GitHub Pages, maar
**Pages moet eerst één keer met de hand aan**: **Settings → Pages → Source** op
*GitHub Actions*. De workflow kan dat niet zelf — de GITHUB_TOKEN mag geen
Pages-site aanmaken — dus tot die klik faalt elke run binnen tien seconden op
"Get Pages site failed".

Daarna staat de catalogus op <https://paumen.github.io/modterrain/>.

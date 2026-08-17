# Herkomst van de modellen

## Wat er is binnengekomen

Eén zip, `glb_394_from_fbx.zip`, met 394 `.glb`-bestanden in een map
`glb_from_fbx/`. Geen licentiebestand, geen leesmij, geen packpagina, geen
naam van een maker. De bestanden staan ongewijzigd in `models/`.

De naam van de zip zegt dat het om een conversie uit FBX gaat, en de bestanden
bevestigen dat: elke `.glb` noemt als generator
`Open Asset Import Library (assimp v5.3.0)`.

## Wat de bestanden zelf over hun herkomst zeggen

De materialen van de borden verwijzen naar texturen in een map
`Workspace/Modular Terrain 2.0/Textures/` op de computer van de maker. **Modular
Terrain 2.0** is dus vermoedelijk de naam van de bronpack. Dat is een aanwijzing
en geen bewijs — het is een pad in een bestand, geen licentievermelding.

## Licentie: onbekend

**De licentie is niet vastgesteld.** Er zat er geen bij en er is er geen te
achterhalen uit de bestanden. Wie de pack herkent of de bron terugvindt, vult
dit bestand aan met de maker en de voorwaarden.

Tot dat moment: ga er niet vanuit dat deze modellen vrij te gebruiken zijn.
Deze repo is een catalogus over de bestanden, geen uitspraak over wat je ermee
mag.

## Wat er mis is met de conversie

Drie dingen zijn tijdens de FBX → glTF-conversie scheefgelopen. Ze zijn geen van
drieën gerepareerd — de bestanden in `models/` zijn exact zoals ze zijn
aangeleverd — maar de catalogus houdt er rekening mee en laat ze zien.

### 1. De materiaalkleuren staan in de verkeerde kleurruimte

De pack heeft geen texture-atlas maar 30 vlakke materiaalkleuren, en die zijn
als sRGB-waarden in `baseColorFactor` gezet. De glTF-spec noemt dat veld
lineair, dus een viewer die zich aan de spec houdt rekent er nog een keer gamma
overheen: het klifbeige `#bfb9ae` komt als `#e0ddd7` op het scherm, het
grasgroen `#63ba2e` als pastel `#a7de76`. Omdat 160 van de 394 stukken uit dat
ene beige bestaan, levert dat een catalogus van witte blokken op.

Dat dit een fout is en geen bedoeling, blijkt uit de zusterpack: de
`modular_terrain_collection` die in [Taalei](https://github.com/Paumen/Taalei)
is ingeladen kwam als OBJ binnen, met dezelfde soort materialen, en daar staat
`Grass` als `#228b22` in de `.mtl` — een bosgroen, geen pastel.

`catalog/catalog.js` rekent de kleuren daarom bij het tónen terug (zie
`herstelKleurruimte`). De `.glb`-bestanden zelf en alles wat achter de
downloadknop vandaan komt zijn onaangeroerd. Wie de pack wil zien zoals hij op
schijf staat, haalt die twee aanroepen weg.

Een echte reparatie zou de `baseColorFactor` in de 394 bestanden zelf omrekenen.
Dat is bewust niet gedaan: dan wijken de bestanden af van wat er is
aangeleverd, en dat is een beslissing van de eigenaar van de pack, niet van de
catalogus.

### 2. Zevenenzestig modellen verwijzen naar texturen die er niet zijn

Het hout, het touw, het water en de borden dragen een verwijzing naar een `.png`
die naast de `.glb` had moeten staan. De FBX-export heeft daar het absolute pad
op de computer van de maker neergezet, dus die bestanden zijn nergens te vinden
— ze zaten ook niet in de zip.

De viewer valt dan terug op de vlakke materiaalkleur en toont het model gewoon;
alleen de houtnerf en de tekst op de borden ontbreken. `node
tools/build-catalog.mjs` noemt de betrokken modellen, en het detailvenster in
de catalogus zet er een regel *Ontbrekende textuur* bij.

### 3. De oorsprong ligt niet in het model

Elk stuk staat waar het in het raster hoort en niet op de oorsprong. Dat is
géén fout — het is precies wat een modulaire kit moet doen, en het is dezelfde
keuze als in de zusterpack. Een klifhoek die op x = -0,5 begint sluit daar op
de buurtegel aan; wie dat "rechtzet" maakt de kit onmodulair.

De catalogus zet daarom bij elk model de regel *Ligging t.o.v. oorsprong*, met
de bounding box in rastervakken.

## Schaal

Eén rastervak is **100 eenheden** in de bronbestanden. Dat is nagemeten en niet
aangenomen: elk stuk dat `1x1` heet meet 100 breed of diep, `12x12` meet 1200,
`7x7` meet 700, en de hoogte volgt hetzelfde raster — een basisblok van één
laag is 100 hoog, een wandstuk van twee lagen 200.

`node tools/build-catalog.mjs` toetst die aanname bij elke run tegen de maat in
de bestandsnaam en klaagt als een model er ver naast zit.

Alle maten in de catalogus staan in rastervakken, dus gedeeld door 100. Wie de
`.glb`'s rechtstreeks in een engine laadt, krijgt de eenheden uit de bestanden
en moet dus zelf schalen.

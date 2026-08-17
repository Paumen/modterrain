/**
 * Bouwt catalog/catalog.json vanuit de .glb's in models/.
 *
 * Draai vanuit de repo-root:  node tools/build-catalog.mjs
 *
 * De catalogus wordt volledig afgeleid van wat er écht op schijf staat, zodat
 * hij niet uit de pas kan lopen met de modellen. Per model worden de
 * bestandsgrootte, de bounding box, de driehoekstelling en de gebruikte
 * materialen uit de .glb gelezen; de indeling komt uit tools/taxonomie.mjs.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { leesGlb, meetScene, driehoekenPerUnit, BUDGET_PER_UNIT, EENHEDEN_PER_CEL } from './glb.mjs';
import {
  FAMILIES, VORMEN, LAGEN, FORMAATGROEPEN, TABBLADEN,
  bepaalFamilie, bepaalVorm, bepaalLaag, bepaalFormaat, bepaalFormaatgroep,
  bepaalKenmerken, bepaalVariant, leesbaar,
} from './taxonomie.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODELLEN_DIR = join(ROOT, 'models');
const CATALOGUS_DIR = join(ROOT, 'catalog');

/* -- materialen -----------------------------------------------------------
 * De pack heeft geen texture-atlas: elk materiaal is één vlakke kleur in
 * `baseColorFactor`. Dat is precies genoeg om op te filteren, want de kleur
 * ís de betekenis — gras is groen, klifwand is beige, verborgen vlakken zijn
 * bijna wit.
 */

/**
 * De Nederlandse naam per materiaal uit de pack. Wat hier niet staat komt
 * onvertaald door, met een waarschuwing: een nieuw materiaal is iets om te
 * benoemen, niet om stilletjes als Engelse string in de filterbalk te zetten.
 */
const MATERIAALNAMEN = {
  'Cliff Face': 'Klifwand',
  Grass: 'Gras',
  Dirt: 'Aarde',
  'Rock Lightest': 'Steen lichtst',
  'Rock Light': 'Steen licht',
  'Rock Medium': 'Steen midden',
  'Stone Walkway': 'Steenpad',
  'Wood Light': 'Hout licht',
  'Wood Light End': 'Hout licht (kopse kant)',
  'Wood Medium': 'Hout midden',
  'Wood Dark': 'Hout donker',
  Rope: 'Touw',
  Iron: 'IJzer',
  Ice: 'IJs',
  'Water River': 'Rivierwater',
  'Water Lake': 'Meerwater',
  Waterfall: 'Waterval',
  'Waterfall Crest': 'Watervalkruin',
  'Sign 4x1': 'Bord 4 : 1',
  'Sign 4x3': 'Bord 4 : 3',
  'Sign 8x3': 'Bord 8 : 3',
  'Sign 16x9': 'Bord 16 : 9',
  Hidden: 'Verborgen',
  'Hidden Red': 'Verborgen rood',
  'Hidden Orange': 'Verborgen oranje',
  'Hidden Yellow': 'Verborgen geel',
  'Hidden Green': 'Verborgen groen',
  'Hidden Blue': 'Verborgen blauw',
  'Hidden Violet': 'Verborgen violet',
  'Hidden Pink': 'Verborgen roze',
};

/**
 * Twee groepen in de filterbalk, want het zijn twee soorten kleur. De
 * zichtbare materialen zeggen waar een stuk van gemaakt is; de `Hidden`-reeks
 * markeert vlakken die de pack als verborgen aanmerkt — de zijden die tegen
 * een buurtegel aan komen te liggen. Wat de kleurvarianten daarbinnen
 * onderscheidt zegt de pack zelf niet; ze zijn hier bij elkaar gezet zodat ze
 * de materiaalgroep niet vervuilen.
 */
const VERBORGEN = /^Hidden/;

const PALETTEN = [
  {
    id: 'materiaal',
    naam: 'Materiaal',
    toelichting: 'De zichtbare vlakke kleuren van de pack.',
    // Met naam erbij, want deze groep bevat materialen die dezelfde kleur delen:
    // rivier, meer, waterval en watervalkruin zijn alle vier hetzelfde cyaan, en
    // vier identieke blokjes naast elkaar zijn geen filter maar een raadsel.
    stijl: 'chip',
  },
  {
    id: 'verborgen',
    naam: 'Verborgen vlakken',
    toelichting: 'Vlakken die de pack als "Hidden" markeert: de zijden die tegen een buurtegel aan liggen.',
    // Hier is de kleur de hele betekenis — "Verborgen rood" heet zo omdat hij
    // rood is — dus is het blokje zelf het label. Scheelt een rij in de balk.
    stijl: 'staal',
  },
];

/**
 * De materiaalkleur zoals de maker hem heeft ingesteld: `baseColorFactor` maal
 * 255, zonder omrekening.
 *
 * Dat is niet wat de glTF-spec zegt — daar staat dat veld in lineaire ruimte —
 * maar het is wel wat er in de bestanden staat. De FBX-export heeft de
 * sRGB-waarden uit de bron ongewijzigd in dat lineaire veld gezet, dus
 * `Grass` = 0,388 / 0,729 / 0,180 is het bekende #63ba2e en niet het pastelgroen
 * dat je krijgt als je het als lineair leest. De catalogus rekent dat bij het
 * tonen terug (zie `herstelKleurruimte` in catalog/catalog.js); hier staan de
 * kleuren waar dat op uitkomt.
 */
function naarHex([r, g, b] = [1, 1, 1]) {
  const kanaal = (v) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${kanaal(r)}${kanaal(g)}${kanaal(b)}`;
}

const sleutelVan = (naam) =>
  naam.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/* -- versie ---------------------------------------------------------------
 * GitHub Pages serveert met `cache-control: max-age=600`. Zonder versie in de
 * URL kijk je na een deploy dus tot tien minuten naar oude CSS of JS, of erger:
 * naar nieuwe HTML met oude JS. De hash hangt aan de inhoud, dus hij verandert
 * precies wanneer er iets verandert.
 */
function schrijfVersie() {
  const inhoud = ['catalog.json', 'catalog.css', 'catalog.js']
    .map((naam) => readFileSync(join(CATALOGUS_DIR, naam)))
    .join('');
  const versie = createHash('sha256').update(inhoud).digest('hex').slice(0, 10);

  const pad = join(ROOT, 'index.html');
  const html = readFileSync(pad, 'utf8')
    .replace(/href="catalog\/catalog\.css(?:\?v=[a-f0-9]+)?"/, `href="catalog/catalog.css?v=${versie}"`)
    .replace(/src="catalog\/catalog\.js(?:\?v=[a-f0-9]+)?"/, `src="catalog/catalog.js?v=${versie}"`)
    .replace(/<meta name="catalogus-versie" content="[^"]*">/, `<meta name="catalogus-versie" content="${versie}">`);

  writeFileSync(pad, html);
  console.log(`versie ${versie} → index.html`);
}

/* -- modellen inlezen ------------------------------------------------------ */

const bestanden = readdirSync(MODELLEN_DIR).filter((naam) => naam.endsWith('.glb')).sort();
if (bestanden.length === 0) throw new Error('geen .glb-bestanden in models/');

/** materiaalsleutel → { sleutel, palet, naam, bron, hex, aantal } */
const materialen = new Map();
const onbekendeMaterialen = new Set();

const modellen = bestanden.map((bestand) => {
  const id = bestand.replace(/\.glb$/, '');
  const glb = leesGlb(join(MODELLEN_DIR, bestand));
  const maat = meetScene(glb);

  const gebruikt = [];
  for (const index of maat.materiaalIndexen) {
    const bron = glb.json.materials?.[index]?.name ?? `materiaal ${index}`;
    if (!(bron in MATERIAALNAMEN)) onbekendeMaterialen.add(bron);

    const palet = VERBORGEN.test(bron) ? 'verborgen' : 'materiaal';
    const sleutel = `${palet}|${sleutelVan(bron)}`;
    if (!materialen.has(sleutel)) {
      materialen.set(sleutel, {
        sleutel,
        palet,
        naam: MATERIAALNAMEN[bron] ?? bron,
        bron,
        hex: naarHex(glb.json.materials?.[index]?.pbrMetallicRoughness?.baseColorFactor),
        aantal: 0,
      });
    }
    if (!gebruikt.includes(sleutel)) gebruikt.push(sleutel);
  }
  for (const sleutel of gebruikt) materialen.get(sleutel).aantal++;

  /* Een handvol modellen — het hout, het touw en de borden — draagt nog een
   * verwijzing naar een .png die naast de .glb had moeten staan maar er niet
   * is: de FBX-export heeft het absolute pad op de computer van de maker
   * meegeschreven. De viewer valt dan terug op de vlakke materiaalkleur, dus
   * het model is gewoon te zien; alleen de houtnerf ontbreekt. Dat is een
   * eigenschap van de pack en geen fout van de catalogus, dus het staat erin
   * in plaats van dat het stilletjes wordt weggepoetst. */
  const ontbrekendeTexturen = (glb.json.images ?? [])
    .map((afbeelding) => afbeelding.uri)
    .filter((uri) => uri && !uri.startsWith('data:'))
    .map((uri) => decodeURIComponent(uri).split(/[\\/]/).pop());

  const formaat = bepaalFormaat(id);

  return {
    id,
    naam: leesbaar(id),
    bestand: `models/${bestand}`,
    familie: bepaalFamilie(id).id,
    vorm: bepaalVorm(id).id,
    laag: bepaalLaag(id).id,
    formaat: formaat?.label ?? null,
    formaatgroep: bepaalFormaatgroep(formaat).id,
    kenmerken: bepaalKenmerken(id),
    variant: bepaalVariant(id),
    wdh: maat.wdh,
    // De pack staat bewust niet op de oorsprong: de oorsprong van elk stuk ís
    // zijn rastervak. Waar het model daar precies omheen ligt — of het
    // overhangt, of het onder nul zakt — is met deze twee hoeken na te gaan.
    min: maat.min,
    max: maat.max,
    driehoeken: maat.driehoeken,
    driehoekenPerUnit: driehoekenPerUnit(maat.driehoeken, maat.wdh),
    calls: maat.calls,
    bytes: glb.bytes,
    materialen: gebruikt.sort(),
    ontbrekendeTexturen: [...new Set(ontbrekendeTexturen)],
  };
});

/* -- rastermaat toetsen ----------------------------------------------------
 * De hele catalogus rekent in rastervakken van EENHEDEN_PER_CEL, en dat getal
 * is uit de bestanden afgeleid, niet door de pack verteld. Deze toets houdt die
 * afleiding eerlijk: de langste zijde die we meten hoort in de buurt te liggen
 * van de langste zijde uit de naam.
 *
 * De marge is met opzet ruim, want binnen die marge is van alles normaal: een
 * hekpaal van 1 × 1 is maar een achtste cel dik, en de zijstukken van een
 * waterval hangen een cel buiten hun vak. Wat hier doorheen komt is dus geen
 * scheve tegel maar een schaal die niet klopt — een pack op centimeters in
 * plaats van decimeters valt er meteen uit.
 */
const scheef = modellen
  .map((model) => {
    const treffers = [...model.id.matchAll(/(\d+)x(\d+)/g)];
    if (treffers.length === 0) return null;
    const [, b, d] = treffers.at(-1);
    const vak = Math.max(Number(b), Number(d));
    const gemeten = Math.max(model.wdh[0], model.wdh[1]);
    const verhouding = gemeten / vak;
    return verhouding > 2.5 || verhouding < 0.05 ? { model, vak, gemeten, verhouding } : null;
  })
  .filter(Boolean)
  .sort((a, b) => b.verhouding - a.verhouding);

/* -- weergaven opbouwen ----------------------------------------------------
 * Elk tabblad is een lijst secties, en elke sectie een lijst indexen in
 * `modellen`. Indexen en niet hele records, want een model staat in vier
 * tabbladen tegelijk: uitgeschreven zou de catalogus vier keer zo groot zijn.
 */

/* De ids van alle facetten samen moeten uniek zijn: catalog.json zet ze in één
 * tabel en de browser zoekt er de titel bij op zonder te weten uit welk facet
 * een id komt. Een dubbele id zou daar stilletjes de verkeerde naam opleveren
 * — een model in de laag "Basis" dat zich "Basis — kliffen" noemt. */
const alleIds = [...FAMILIES, ...VORMEN, ...LAGEN, ...FORMAATGROEPEN].map((g) => g.id);
const dubbel = alleIds.filter((id, i) => alleIds.indexOf(id) !== i);
if (dubbel.length) throw new Error(`dubbele facet-id in tools/taxonomie.mjs: ${[...new Set(dubbel)].join(', ')}`);

const FACETTEN = {
  familie: { lijst: FAMILIES, veld: 'familie' },
  vorm: { lijst: VORMEN, veld: 'vorm' },
  laag: { lijst: LAGEN, veld: 'laag' },
  formaat: { lijst: FORMAATGROEPEN, veld: 'formaatgroep' },
};

const weergaven = TABBLADEN.map((tab) => {
  const { lijst, veld } = FACETTEN[tab.facet];
  const secties = [];

  for (const groep of lijst) {
    if (tab.families && !tab.families.includes(groep.id)) continue;

    const indexen = modellen
      .map((model, index) => [model, index])
      .filter(([model]) => model[veld] === groep.id && (!tab.filter || tab.filter(model.id)))
      .map(([, index]) => index);

    if (indexen.length === 0) continue;

    secties.push({
      id: `${tab.id}-${groep.id}`,
      titel: groep.titel,
      kort: groep.kort ?? groep.titel,
      kleur: groep.kleur,
      // De uitleg staat bij de familie en is daar geschreven voor het tabblad
      // Onderdelen; in Grot en Kust zou hij de sectie herhalen die er al staat.
      uitleg: tab.families ? null : groep.uitleg ?? null,
      modellen: indexen,
    });
  }

  return {
    id: tab.id,
    label: tab.label,
    // Waarop dit tabblad indeelt. De catalogus in de browser gebruikt het om te
    // weten of het familielabel op een kaart een herhaling is van de sectiekop.
    facet: tab.facet,
    uitleg: tab.uitleg ?? null,
    aantal: new Set(secties.flatMap((s) => s.modellen)).size,
    secties,
  };
});

/* Een model dat in geen enkel tabblad staat, bestaat voor de bezoeker niet. */
const geplaatst = new Set(weergaven.flatMap((w) => w.secties.flatMap((s) => s.modellen)));
const verweesd = modellen.filter((_, index) => !geplaatst.has(index));

const catalogus = {
  gegenereerd: 'node tools/build-catalog.mjs',
  totaal: modellen.length,
  // Zodat de catalogus in de browser de grens niet nog eens hoeft te kennen.
  budgetPerUnit: BUDGET_PER_UNIT,
  // Alle maten in deze catalogus staan in rastervakken; dit is wat één vak in
  // de bronbestanden meet. Wie de .glb's rechtstreeks in een engine laadt,
  // heeft dat getal nodig.
  eenhedenPerCel: EENHEDEN_PER_CEL,
  // Elk model draagt zijn facetten als id; hier staat wat die ids betekenen.
  // Eén tabel voor alle facetten samen — de ids zijn over de facetten heen
  // uniek, en zo hoeft de browser niet te weten in welk facet hij moet kijken.
  // De korte naam is voor plekken waar de volle titel niet past: op een tegel
  // van 112 pixels wordt "Basis — kliffen" afgekapt tot "Basis — k".
  facetten: Object.fromEntries(
    [...FAMILIES, ...VORMEN, ...LAGEN, ...FORMAATGROEPEN]
      .map((g) => [g.id, { titel: g.titel, kort: g.kort ?? g.titel }]),
  ),
  weergaven,
  paletten: PALETTEN.map((palet) => ({
    ...palet,
    kleuren: [...materialen.values()]
      .filter((m) => m.palet === palet.id)
      .sort((a, b) => b.aantal - a.aantal || a.naam.localeCompare(b.naam, 'nl'))
      .map(({ palet: _, ...rest }) => rest),
  })),
  modellen,
};

writeFileSync(join(CATALOGUS_DIR, 'catalog.json'), JSON.stringify(catalogus, null, 1) + '\n');
schrijfVersie();

/* -- verslag --------------------------------------------------------------- */

console.log(`${modellen.length} modellen → catalog/catalog.json`);
for (const weergave of catalogus.weergaven) {
  console.log(`\ntabblad ${weergave.label} — ${weergave.aantal} modellen in ${weergave.secties.length} secties:`);
  for (const sectie of weergave.secties) {
    console.log(`  ${String(sectie.modellen.length).padStart(3)}  ${sectie.titel}`);
  }
}
for (const palet of catalogus.paletten) {
  console.log(`\npalet ${palet.id} — ${palet.kleuren.length} kleuren:`);
  for (const kleur of palet.kleuren) {
    console.log(`  ${String(kleur.aantal).padStart(3)}  ${kleur.hex}  ${kleur.naam}`);
  }
}

const zonderTextuur = modellen.filter((m) => m.ontbrekendeTexturen.length > 0);
if (zonderTextuur.length) {
  const bestanden = [...new Set(zonderTextuur.flatMap((m) => m.ontbrekendeTexturen))].sort();
  console.warn(
    `\n! ${zonderTextuur.length} modellen verwijzen naar een textuur die niet in de pack zit;` +
    ` de viewer valt terug op de vlakke materiaalkleur.\n  gezocht: ${bestanden.join(', ')}`,
  );
}
if (scheef.length) {
  console.warn(`\n! ${scheef.length} modellen wijken sterk af van de rastermaat in hun naam (1 vak = ${EENHEDEN_PER_CEL} eenheden):`);
  for (const { model, vak, gemeten, verhouding } of scheef) {
    console.warn(`  ${verhouding.toFixed(2)}×  ${model.id}  (naam ${vak}, gemeten ${gemeten})`);
  }
}
if (verweesd.length) {
  console.warn(`\n! ${verweesd.length} modellen staan in geen enkel tabblad: ${verweesd.map((m) => m.id).join(', ')}`);
}
if (onbekendeMaterialen.size) {
  console.warn(`\n! materiaal zonder Nederlandse naam in tools/build-catalog.mjs: ${[...onbekendeMaterialen].join(', ')}`);
}

/* Boven het budget is geen harde fout: de pack is ingekocht zoals hij is, en
 * een model dat erboven zit is een kandidaat om te vereenvoudigen, geen
 * bouwstop. De build noemt ze bij naam zodat de lijst niet stilletjes groeit. */
const bovenBudget = modellen
  .filter((m) => m.driehoekenPerUnit !== null && m.driehoekenPerUnit > BUDGET_PER_UNIT)
  .sort((a, b) => b.driehoekenPerUnit - a.driehoekenPerUnit);
const ERGSTE = 15;
if (bovenBudget.length) {
  console.warn(`\n! ${bovenBudget.length} modellen boven ${BUDGET_PER_UNIT} driehoeken per unit, de ergste ${Math.min(ERGSTE, bovenBudget.length)}:`);
  for (const m of bovenBudget.slice(0, ERGSTE)) {
    console.warn(`  ${String(m.driehoekenPerUnit).padStart(6)}  ${m.id}  (${m.driehoeken} tri, ${m.wdh.join(' × ')})`);
  }
  if (bovenBudget.length > ERGSTE) {
    console.warn(`  … en nog ${bovenBudget.length - ERGSTE}; de hele lijst staat in catalog.json`);
  }
}
const plat = modellen.filter((m) => m.driehoekenPerUnit === null);
if (plat.length) {
  console.warn(`\n! ${plat.length} platte modellen zonder volume, dus zonder dichtheid: ${plat.map((m) => m.id).join(', ')}`);
}

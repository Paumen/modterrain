/**
 * Modulair terrein — 3D-catalogus.
 *
 * Opgezet naar het voorbeeld van de Taaleiland-catalogus
 * (github.com/Paumen/Taalei, kits/catalog.js). Het verschil zit in de bron: daar
 * beschrijft een handgeschreven manifest welke kits er zijn, hier heeft de pack
 * geen enkele metadata en komt de hele indeling uit de bestandsnamen
 * (tools/taxonomie.mjs → catalog/catalog.json).
 *
 * Eén model staat in meerdere tabbladen — hetzelfde stuk is een binnenbocht,
 * een middenlaag én een 3 × 3 — dus één model levert meerdere kaarten op. Alles
 * wat aan het model hangt in plaats van aan de kaart (de selectie) hangt
 * daarom aan het bestandspad.
 */

/**
 * Driehoeken waarboven een model absoluut zwaar is, los van zijn maat. De
 * grootste zandhellingen van deze pack beslaan 12 × 12 rastervakken; die mogen
 * meer driehoeken hebben dan een paaltje van 1 × 1, en dat regelt het budget
 * per unit hieronder. Deze grens vangt het andere geval: een stuk dat in
 * absolute zin niet meer in een scène past waar er honderd van staan.
 */
const ZWAAR_VANAF = 500;

/**
 * Driehoeken per 1×1×1 unit waarboven een model uit de pas loopt met de rest
 * van de pack. De grens zelf staat in tools/glb.mjs en komt via catalog.json
 * mee; het getal hier is alleen het antwoord op een catalogus van vóór dat veld.
 */
let budgetPerUnit = 250;

const getal = new Intl.NumberFormat('nl-NL');
const eenheid = new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 2 });

const paneel = document.querySelector('#paneel');
const schakelaar = document.querySelector('#schakelaar');
const springlijst = document.querySelector('#springlijst');
const zoekveld = document.querySelector('#zoek');
const zoekTelling = document.querySelector('#zoek-telling');
const leegmelding = document.querySelector('#leeg');
const samenvatting = document.querySelector('#samenvatting');
const weergaveUitleg = document.querySelector('#weergave-uitleg');
const detail = document.querySelector('#detail');

const kaarten = [];
const secties = [];
const weergaven = new Map();

let huidigeWeergave = null;

/**
 * Selectie hangt aan het pad, niet aan de kaart. Eén model heeft namelijk
 * meerdere kaarten — dezelfde binnenbocht staat in Onderdelen, Vormen, Lagen én
 * Formaten — en die moeten hetzelfde vinkje tonen. Meteen ook de ontdubbeling:
 * wie in twee tabbladen hetzelfde model aanvinkt, krijgt het pad één keer op
 * het klembord.
 */
const gekozenPaden = new Set();
const kaartenPerPad = new Map();

let laatsteKeuze = null;

const gekozenMaterialen = new Set();
const stalen = [];

const bytesLeesbaar = (bytes) =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} kB`;

const afmeting = (wdh) =>
  Array.isArray(wdh) ? `${wdh.map((v) => eenheid.format(v)).join(' × ')} vakken` : '—';

function span(klasse, tekst = '') {
  const element = document.createElement('span');
  element.className = klasse;
  element.textContent = tekst;
  return element;
}

/**
 * De materiaalkleuren van deze pack terugzetten naar wat de maker instelde.
 *
 * De FBX-export heeft de sRGB-kleuren uit de bron ongewijzigd in
 * `baseColorFactor` gezet, en dat veld noemt de glTF-spec lineair. Een viewer
 * die zich aan de spec houdt — en dat doet deze — rekent er dus nog een keer
 * gamma overheen: het klifbeige #bfb9ae komt als #e0ddd7 op het scherm, het
 * grasgroen #63ba2e als pastel #a7de76. Bij een pack waarvan tweederde van de
 * stukken uit één beige materiaal bestaat, levert dat een catalogus van witte
 * blokken op.
 *
 * Deze omrekening is het spiegelbeeld daarvan en gebeurt alleen tijdens het
 * tonen: de .glb's op schijf en achter de downloadknop zijn onaangeroerd. Wie
 * de pack ongecorrigeerd wil zien, haalt de aanroep in `koppelViewer` en
 * `toonDetail` weg.
 */
const srgbNaarLineair = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

function herstelKleurruimte(viewer) {
  for (const materiaal of viewer.model?.materials ?? []) {
    const factor = materiaal.pbrMetallicRoughness?.baseColorFactor;
    if (!factor) continue;
    materiaal.pbrMetallicRoughness.setBaseColorFactor([
      srgbNaarLineair(factor[0]),
      srgbNaarLineair(factor[1]),
      srgbNaarLineair(factor[2]),
      factor[3],
    ]);
  }
}

const waarnemer = new IntersectionObserver(
  (waarnemingen) => {
    for (const { target, isIntersecting } of waarnemingen) {
      if (isIntersecting) koppelViewer(target);
      else ontkoppelViewer(target);
    }
  },
  { rootMargin: '800px 0px' },
);

function koppelViewer(vak) {
  if (vak.querySelector('model-viewer')) return;

  const viewer = document.createElement('model-viewer');
  viewer.src = vak.dataset.src;
  viewer.alt = vak.dataset.alt;
  viewer.setAttribute('camera-orbit', '35deg 68deg auto');
  viewer.setAttribute('environment-image', 'neutral');
  viewer.setAttribute('shadow-intensity', '0.6');
  viewer.setAttribute('shadow-softness', '0.9');
  // De pack is vlak gearceerd en heeft geen texturen; op de standaardbelichting
  // van de neutrale omgeving lopen de lichte kliffen tot wit dicht. Iets
  // terugnemen geeft de beige weer kleur en de vlakken weer onderscheid.
  viewer.setAttribute('exposure', '0.85');
  viewer.setAttribute('interaction-prompt', 'none');
  viewer.setAttribute('disable-zoom', '');
  viewer.setAttribute('loading', 'eager');
  viewer.addEventListener('load', () => herstelKleurruimte(viewer), { once: true });
  vak.replaceChildren(viewer);
}

/**
 * Buiten beeld gaat de renderlus uit, maar het plaatje blijft staan: één
 * momentopname als webp, gemaakt op het moment dat de kaart wegscrollt. Zonder
 * dat springt het rooster bij elke scrollbeweging leeg — bij honderden tegels
 * per tabblad is dat het verschil tussen bladeren en wachten.
 */
function ontkoppelViewer(vak) {
  const viewer = vak.querySelector('model-viewer');
  if (!viewer) return;

  if (viewer.loaded && !vak.dataset.momentopname) {
    try {
      vak.dataset.momentopname = viewer.toDataURL('image/webp', 0.72);
    } catch {}
  }

  if (vak.dataset.momentopname) {
    const plaatje = document.createElement('img');
    plaatje.src = vak.dataset.momentopname;
    plaatje.alt = vak.dataset.alt;
    plaatje.loading = 'lazy';
    vak.replaceChildren(plaatje);
  } else {
    vak.replaceChildren();
  }
}

/* ---------- kaarten ---------- */

function maakKaart(model, weergave, sectie) {
  const dichtheid = Number.isFinite(model.driehoekenPerUnit) ? model.driehoekenPerUnit : null;
  const bovenBudget = dichtheid !== null && dichtheid > budgetPerUnit;
  // Eén rood label voor twee redenen: veel driehoeken, of veel driehoeken op
  // weinig ruimte. Wat er precies aan de hand is, staat in de tooltip en in het
  // detailpaneel; op de kaart is het genoeg dat het opvalt.
  const zwaar = model.driehoeken >= ZWAAR_VANAF || bovenBudget;

  const kaart = document.createElement('button');
  kaart.type = 'button';
  kaart.className = 'kaart';
  kaart.style.setProperty('--merk-kleur', sectie.kleur ?? 'currentColor');

  const vak = document.createElement('div');
  vak.className = 'kaart-viewer';
  vak.dataset.src = model.bestand;
  vak.dataset.alt = `3D-model ${model.naam}`;
  if (model.formaat) vak.append(span('kaart-formaat', model.formaat));

  const tekst = document.createElement('div');
  tekst.className = 'kaart-tekst';
  const meta = span('kaart-meta');
  const tri = span(`kaart-tri${zwaar ? ' zwaar' : ''}`, `${getal.format(model.driehoeken)} tri`);
  if (dichtheid !== null) {
    tri.title = `${getal.format(dichtheid)} driehoeken per unit${bovenBudget ? ` — boven het budget van ${getal.format(budgetPerUnit)}` : ''}`;
  }
  meta.append(
    span('kaart-merk', sectie.merk ?? ''),
    tri,
    span('kaart-grootte', bytesLeesbaar(model.bytes)),
  );
  tekst.append(span('kaart-naam', model.naam), meta);

  kaart.append(vak, tekst);
  kaart.addEventListener('click', () => toonDetail(model));

  // Het vinkje is een broer van de kaart, geen kind: een knop in een knop mag
  // niet, en zo blijft de kaart zelf onveranderd klikbaar naar het detail.
  const kies = document.createElement('label');
  kies.className = 'kaart-kies';
  const vinkje = document.createElement('input');
  vinkje.type = 'checkbox';
  vinkje.checked = gekozenPaden.has(model.bestand);
  vinkje.setAttribute('aria-label', `${model.naam} selecteren`);
  kies.append(vinkje);

  const houder = document.createElement('div');
  houder.className = 'kaart-houder';
  houder.append(kaart, kies);

  const item = {
    element: houder,
    vinkje,
    pad: model.bestand,
    weergave,
    materialen: model.materialen,
    zoektekst: model.zoektekst,
  };
  kaarten.push(item);

  const zusjes = kaartenPerPad.get(model.bestand);
  if (zusjes) zusjes.push(item);
  else kaartenPerPad.set(model.bestand, [item]);

  vinkje.addEventListener('click', (e) => {
    if (e.shiftKey && laatsteKeuze && laatsteKeuze !== item) kiesBereik(item, vinkje.checked);
    else zetSelectie([model.bestand], vinkje.checked);
    laatsteKeuze = item;
  });

  waarnemer.observe(vak);
  return item;
}

function maakSectie(weergave, sectie, facet) {
  const element = document.createElement('section');
  element.className = 'sectie';
  element.id = sectie.id;
  element.dataset.weergave = weergave.id;
  element.dataset.facet = facet;
  if (sectie.kleur) element.style.setProperty('--sectie-kleur', sectie.kleur);

  const kop = document.createElement('div');
  kop.className = 'sectie-kop';

  const titel = document.createElement('h2');
  titel.textContent = sectie.titel;

  const aantalEl = span('aantal', `${sectie.modellen.length} modellen`);
  kop.append(titel, aantalEl);

  if (sectie.uitleg) {
    const p = document.createElement('p');
    p.className = 'uitleg';
    p.textContent = sectie.uitleg;
    kop.append(p);
  }

  const rooster = document.createElement('div');
  rooster.className = 'rooster';
  element.append(kop, rooster);
  return { element, rooster, aantalEl };
}

function maakSpringitem(sectie, titel, aantal, kleur) {
  const link = document.createElement('a');
  link.href = `#${sectie.id}`;
  link.dataset.weergave = sectie.dataset.weergave;
  const stip = span('stip');
  if (kleur) stip.style.background = kleur;
  link.append(stip, document.createTextNode(`${titel} `), span('telling', String(aantal)));
  springlijst.append(link);
  return link;
}

/* ---------- detailvenster ---------- */

const detailViewer = document.querySelector('#detail-viewer');
const detailKopieer = document.querySelector('#detail-kopieer');
let actiefPad = '';

/** materiaalsleutel → { naam, hex }, gevuld door bouwKleurbalk(). */
const materiaalInfo = new Map();

/**
 * De ligging van het model ten opzichte van zijn rastervak. Deze pack staat
 * bewust niet op de oorsprong — de oorsprong van elk stuk ís zijn vak — dus
 * "van -0,5 tot 0,5" betekent gecentreerd en "van 0 tot 1" betekent dat het
 * stuk rechtsboven zijn oorsprong ligt. Wie de kit in een engine op een raster
 * legt, heeft precies dat nodig.
 */
const ligging = (min, max) =>
  [['breedte', 0], ['diepte', 2], ['hoogte', 1]]
    .map(([as, index]) => `${as} ${eenheid.format(min[index])} … ${eenheid.format(max[index])}`)
    .join(' · ');

function toonDetail(model) {
  actiefPad = model.bestand;
  document.querySelector('#detail-naam').textContent = model.naam;
  document.querySelector('#detail-herkomst').textContent =
    [model.familieTitel, model.vormTitel, model.laagTitel].filter(Boolean).join(' · ');

  const kenmerken = document.querySelector('#detail-kenmerken');
  kenmerken.replaceChildren(...model.kenmerken.map((k) => span('', k)));

  const materiaalLijst = document.createElement('span');
  for (const sleutel of model.materialen) {
    const info = materiaalInfo.get(sleutel);
    const chip = span('detail-materiaal', info?.naam ?? sleutel);
    if (info) chip.style.setProperty('--materiaal-kleur', info.hex);
    if (materiaalLijst.childNodes.length) materiaalLijst.append(', ');
    materiaalLijst.append(chip);
  }

  const rijen = [
    ['Bestand', model.bestand],
    ['Rastervak', model.formaat ? `${model.formaat} vakken` : '—'],
    ['Afmetingen (b × d × h)', afmeting(model.wdh)],
    ['Ligging t.o.v. oorsprong', ligging(model.min, model.max)],
    ['Driehoeken', `${getal.format(model.driehoeken)}${model.driehoeken >= ZWAAR_VANAF ? ' (zwaar)' : ''}`],
    // Het budget: elke as telt voor minstens één unit mee, dus een model dat
    // binnen één rastercel blijft wordt niet afgerekend op hoe klein het is
    // (tools/glb.mjs).
    [
      'Driehoeken per unit',
      !Number.isFinite(model.driehoekenPerUnit)
        ? '—'
        : `${getal.format(model.driehoekenPerUnit)}${model.driehoekenPerUnit > budgetPerUnit ? ` (boven budget van ${getal.format(budgetPerUnit)})` : ''}`,
    ],
    ['Tekenopdrachten', model.calls === undefined ? '—' : getal.format(model.calls)],
    [`Materialen (${model.materialen.length})`, materiaalLijst],
    // Alleen bij de modellen die het betreft; bij de rest heeft de rij niets te
    // melden. De viewer toont ze gewoon, maar dan in de vlakke materiaalkleur.
    ...(model.ontbrekendeTexturen?.length
      ? [['Ontbrekende textuur', `${model.ontbrekendeTexturen.join(', ')} — zit niet in de pack`]]
      : []),
    ...(model.variant !== null ? [['Variant', `nummer ${model.variant}`]] : []),
    ['Grootte', bytesLeesbaar(model.bytes)],
  ];

  const gegevens = document.querySelector('#detail-gegevens');
  gegevens.replaceChildren();
  for (const [sleutel, waarde] of rijen) {
    const naam = document.createElement('dt');
    naam.textContent = sleutel;
    const waardeEl = document.createElement('dd');
    if (waarde instanceof Node) waardeEl.append(waarde);
    else waardeEl.textContent = waarde;
    gegevens.append(naam, waardeEl);
  }

  const download = document.querySelector('#detail-download');
  download.href = model.bestand;
  download.setAttribute('download', `${model.id}.glb`);

  const viewer = document.createElement('model-viewer');
  viewer.src = model.bestand;
  viewer.alt = `3D-model ${model.naam}`;
  viewer.setAttribute('camera-controls', '');
  viewer.setAttribute('camera-orbit', '35deg 68deg auto');
  viewer.setAttribute('environment-image', 'neutral');
  viewer.setAttribute('shadow-intensity', '0.7');
  viewer.setAttribute('shadow-softness', '0.9');
  viewer.setAttribute('exposure', '0.85');
  // Niets in deze pack is geanimeerd, dus het rondje is de enige manier om de
  // achterkant te zien zonder te slepen — en bij een modulair stuk is juist de
  // achterkant de kant die tegen de buurtegel aan komt.
  viewer.setAttribute('auto-rotate', '');
  viewer.setAttribute('rotation-per-second', '18deg');
  viewer.addEventListener('load', () => herstelKleurruimte(viewer), { once: true });

  detailViewer.replaceChildren(viewer);

  detail.showModal();
  werkSelectieBij();
}

detail.addEventListener('close', () => detailViewer.replaceChildren());
document.querySelector('#detail-sluit').addEventListener('click', () => detail.close());
detail.addEventListener('click', (e) => { if (e.target === detail) detail.close(); });

detailKopieer.addEventListener('click', async () => {
  const gelukt = await naarKlembord(actiefPad);
  detailKopieer.textContent = gelukt ? 'Gekopieerd' : actiefPad;
  setTimeout(() => { detailKopieer.textContent = 'Kopieer pad'; }, 1600);
});

/* ---------- selectie ---------- */

const selectiebalk = document.querySelector('#selectiebalk');
const selectieTelling = document.querySelector('#selectiebalk-telling');
const selectieKopieer = document.querySelector('#selectie-kopieer');
const detailSelecteer = document.querySelector('#detail-selecteer');

const zichtbareKaarten = () =>
  kaarten.filter((k) => k.weergave === huidigeWeergave && !k.element.hidden);

function zetSelectie(paden, aan) {
  for (const pad of paden) {
    if (aan) gekozenPaden.add(pad);
    else gekozenPaden.delete(pad);
    for (const zusje of kaartenPerPad.get(pad) ?? []) zusje.vinkje.checked = aan;
  }
  werkSelectieBij();
}

/**
 * Shift-klik trekt de selectie door van de vorige klik tot deze, over de
 * kaarten die nú in beeld staan. Dus na filteren op "curve" pakt shift precies
 * de bochten, en niet alles wat er in de ongefilterde catalogus tussen zat.
 */
function kiesBereik(tot, aan) {
  const lijst = zichtbareKaarten();
  const van = lijst.indexOf(laatsteKeuze);
  const naar = lijst.indexOf(tot);
  if (van === -1 || naar === -1) return zetSelectie([tot.pad], aan);
  const bereik = lijst.slice(Math.min(van, naar), Math.max(van, naar) + 1);
  zetSelectie(bereik.map((k) => k.pad), aan);
}

function werkSelectieBij() {
  const aantal = gekozenPaden.size;
  selectiebalk.hidden = aantal === 0;
  selectieTelling.textContent = `${aantal} geselecteerd`;
  if (detail.open) {
    const aan = gekozenPaden.has(actiefPad);
    detailSelecteer.textContent = aan ? 'Uit selectie halen' : 'Aan selectie toevoegen';
    detailSelecteer.setAttribute('aria-pressed', String(aan));
  }
}

/**
 * Zonder klembordrechten — een pagina die niet over https draait, bijvoorbeeld
 * vanaf het bestandssysteem — valt de browser terug op een veld dat je met
 * ctrl-C leegt. Bij één pad past dat nog in het knoplabel, bij zeventig niet.
 */
async function naarKlembord(tekst) {
  try {
    await navigator.clipboard.writeText(tekst);
    return true;
  } catch {}

  const veld = document.createElement('textarea');
  veld.value = tekst;
  veld.setAttribute('readonly', '');
  veld.style.cssText = 'position:fixed;top:0;left:-9999px';
  document.body.append(veld);
  veld.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    veld.remove();
  }
}

selectieKopieer.addEventListener('click', async () => {
  const aantal = gekozenPaden.size;
  // Set houdt invoegvolgorde aan: de paden komen eruit in de volgorde waarin ze
  // zijn aangevinkt, en bij "Alles in beeld" is dat de volgorde op het scherm.
  const gelukt = await naarKlembord([...gekozenPaden].join('\n'));
  selectieKopieer.textContent = gelukt
    ? `${aantal} pad${aantal === 1 ? '' : 'en'} gekopieerd`
    : 'Kopiëren mislukt';
  setTimeout(() => { selectieKopieer.textContent = 'Kopieer paden'; }, 1600);
});

document.querySelector('#selectie-alles').addEventListener('click', () => {
  zetSelectie(zichtbareKaarten().map((k) => k.pad), true);
});

document.querySelector('#selectie-wis').addEventListener('click', () => {
  zetSelectie([...gekozenPaden], false);
  laatsteKeuze = null;
});

detailSelecteer.addEventListener('click', () => {
  zetSelectie([actiefPad], !gekozenPaden.has(actiefPad));
});

/* ---------- materiaalfilter ---------- */

function vinkKleur(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6 ? '#2b2a26' : '#ffffff';
}

function bouwKleurbalk(paletten) {
  const houder = document.querySelector('#kleurbalk-stalen');
  const wisknop = document.querySelector('#kleurbalk-wis');

  for (const palet of paletten) {
    if (palet.kleuren.length === 0) continue;

    const groep = document.createElement('div');
    groep.className = 'kleurgroep';

    const label = span('kleurgroep-label', palet.naam);
    label.title = palet.toelichting ?? palet.naam;

    const knoppen = document.createElement('div');
    knoppen.className = 'kleurgroep-stalen';
    knoppen.setAttribute('role', 'group');
    knoppen.setAttribute('aria-label', `Filter op materiaal — ${palet.naam}`);

    for (const kleur of palet.kleuren) {
      materiaalInfo.set(kleur.sleutel, kleur);

      const knop = document.createElement('button');
      knop.type = 'button';
      knop.className = palet.stijl === 'chip' ? 'staal chip' : 'staal';
      knop.dataset.sleutel = kleur.sleutel;
      knop.style.setProperty('--staal-kleur', kleur.hex);
      knop.style.setProperty('--vink', vinkKleur(kleur.hex));
      knop.setAttribute('aria-pressed', 'false');
      knop.title = `${kleur.naam} ${kleur.hex} — ${kleur.aantal} modellen · materiaal "${kleur.bron}"`;
      knop.setAttribute('aria-label', `${kleur.naam}, ${kleur.aantal} modellen`);
      if (palet.stijl === 'chip') knop.append(kleur.naam);

      knop.addEventListener('click', () => {
        const aan = !gekozenMaterialen.has(kleur.sleutel);
        if (aan) gekozenMaterialen.add(kleur.sleutel);
        else gekozenMaterialen.delete(kleur.sleutel);
        knop.setAttribute('aria-pressed', String(aan));
        wisknop.hidden = gekozenMaterialen.size === 0;
        filter();
      });

      knoppen.append(knop);
      stalen.push({ sleutel: kleur.sleutel, element: knop });
    }

    groep.append(label, knoppen);
    houder.append(groep);
  }

  wisknop.addEventListener('click', () => {
    gekozenMaterialen.clear();
    for (const staal of stalen) staal.element.setAttribute('aria-pressed', 'false');
    wisknop.hidden = true;
    filter();
  });
}

/* ---------- weergave & filter ---------- */

function pasWeergaveToe(id) {
  huidigeWeergave = id;
  for (const knop of schakelaar.children) {
    knop.setAttribute('aria-selected', String(knop.dataset.weergave === id));
  }
  paneel.setAttribute('aria-labelledby', `tab-${id}`);

  const uitleg = weergaven.get(id)?.uitleg;
  weergaveUitleg.textContent = uitleg ?? '';
  weergaveUitleg.hidden = !uitleg;

  // Een staal dat in dit tabblad geen enkel model raakt, is een knop die alles
  // wegfiltert. Verbergen dus — en zijn keuze intrekken, anders filtert een
  // onzichtbare knop de hele pagina leeg.
  const aanwezig = new Set(
    kaarten.filter((k) => k.weergave === id).flatMap((k) => k.materialen),
  );
  for (const staal of stalen) {
    staal.element.hidden = !aanwezig.has(staal.sleutel);
    if (!staal.element.hidden) continue;
    gekozenMaterialen.delete(staal.sleutel);
    staal.element.setAttribute('aria-pressed', 'false');
  }
  document.querySelector('#kleurbalk-wis').hidden = gekozenMaterialen.size === 0;

  filter();
}

function filter() {
  const term = zoekveld.value.trim().toLowerCase();
  let zichtbaar = 0;

  for (const kaart of kaarten) {
    const treffer =
      (!term || kaart.zoektekst.includes(term)) &&
      (gekozenMaterialen.size === 0 || kaart.materialen.some((m) => gekozenMaterialen.has(m)));
    kaart.element.hidden = !treffer;
    if (treffer && kaart.weergave === huidigeWeergave) zichtbaar++;
  }

  for (const sectie of secties) {
    const inWeergave = sectie.element.dataset.weergave === huidigeWeergave;
    const aantal = sectie.kaarten.filter((k) => !k.element.hidden).length;

    sectie.element.hidden = !inWeergave || aantal === 0;
    sectie.springitem.hidden = sectie.element.hidden;
    sectie.aantalEl.textContent = `${aantal} model${aantal === 1 ? '' : 'len'}`;
    sectie.springitem.querySelector('.telling').textContent = aantal;
  }

  zoekTelling.textContent = term ? `${zichtbaar}` : '';
  leegmelding.hidden = zichtbaar > 0;
}

/* ---------- opstarten ---------- */

async function start() {
  const versie = document.querySelector('meta[name="catalogus-versie"]')?.content;
  const respons = await fetch(versie ? `catalog/catalog.json?v=${versie}` : 'catalog/catalog.json');
  if (!respons.ok) throw new Error(`catalog/catalog.json niet gevonden (${respons.status})`);
  const data = await respons.json();

  if (Number.isFinite(data.budgetPerUnit)) budgetPerUnit = data.budgetPerUnit;

  /* Een model draagt zijn familie, vorm en laag alleen als id; `facetten` zegt
   * wat die ids betekenen. Hier worden ze leesbaar, zodat het detailvenster ze
   * kan tonen en de zoektekst ze meeneemt — wie "binnenbocht" typt, hoort de
   * binnenbochten te vinden. */
  const titels = new Map(Object.entries(data.facetten ?? {}));
  const titel = (id) => titels.get(id)?.titel ?? id;

  for (const model of data.modellen) {
    model.familieTitel = titel(model.familie);
    model.familieKort = titels.get(model.familie)?.kort ?? model.familie;
    model.vormTitel = titel(model.vorm);
    model.laagTitel = model.laag === 'laag-geen' ? null : titel(model.laag);
    model.zoektekst = [
      model.naam,
      model.familieTitel,
      model.vormTitel,
      model.laagTitel ?? '',
      model.formaat ?? '',
      ...model.kenmerken,
      ...model.materialen.map((m) => m.split('|')[1].replace(/-/g, ' ')),
    ].join(' ').toLowerCase();
  }

  samenvatting.textContent =
    `${data.totaal} modellen · ${data.weergaven[0].secties.length} onderdeelgroepen · ` +
    `${data.paletten.reduce((som, p) => som + p.kleuren.length, 0)} materialen · ` +
    // Alle maten hieronder staan in rastervakken; dit is de enige plek waar de
    // brongrootte zelf staat, en zonder dat getal laadt niemand de .glb's op de
    // juiste schaal in een engine.
    `1 rastervak = ${getal.format(data.eenhedenPerCel ?? 1)} eenheden`;

  bouwKleurbalk(data.paletten ?? []);

  for (const weergave of data.weergaven) {
    weergaven.set(weergave.id, weergave);

    const knop = document.createElement('button');
    knop.type = 'button';
    knop.role = 'tab';
    knop.id = `tab-${weergave.id}`;
    knop.dataset.weergave = weergave.id;
    knop.setAttribute('aria-controls', 'paneel');
    knop.setAttribute('aria-selected', 'false');
    knop.textContent = weergave.label;
    knop.addEventListener('click', () => {
      pasWeergaveToe(weergave.id);
      history.replaceState(null, '', `#${weergave.id}`);
      window.scrollTo({ top: 0 });
    });
    schakelaar.append(knop);

    for (const sectie of weergave.secties) {
      const delen = maakSectie(weergave, sectie, weergave.facet);
      const eigen = [];

      for (const index of sectie.modellen) {
        const model = data.modellen[index];
        const item = maakKaart(model, weergave.id, {
          kleur: sectie.kleur,
          merk: model.familieKort,
        });
        delen.rooster.append(item.element);
        eigen.push(item);
      }

      paneel.append(delen.element);
      secties.push({
        element: delen.element,
        kaarten: eigen,
        aantalEl: delen.aantalEl,
        springitem: maakSpringitem(delen.element, sectie.kort, sectie.modellen.length, sectie.kleur),
      });
    }
  }

  zoekveld.addEventListener('input', filter);

  const anker = location.hash.slice(1);
  const doelSectie = anker ? document.getElementById(anker) : null;
  pasWeergaveToe(doelSectie?.dataset.weergave ?? (weergaven.has(anker) ? anker : data.weergaven[0].id));
  doelSectie?.scrollIntoView();
}

start().catch((fout) => {
  samenvatting.textContent = `Catalogus kon niet worden geladen: ${fout.message}`;
  console.error(fout);
});

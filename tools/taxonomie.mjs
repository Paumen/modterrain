/**
 * De indeling van de kit, afgeleid uit de bestandsnamen.
 *
 * De pack levert geen mapjes en geen metadata — alleen 394 .glb's met een naam
 * als `Tiered_Retaining_Wall_45_Degrees_Curve_Outer_3x4_Top`. Die naam is wél
 * consequent opgebouwd, en dat is het enige houvast dat er is:
 *
 *     Familie _ [soort] _ [variant] _ Vorm _ [maatvoering] _ Formaat _ [Laag]
 *
 * Hieronder staat per facet één tabel met regels. Alles wat de catalogus toont
 * — tabbladen, secties, filters, zoektekst — komt daaruit, zodat een verkeerd
 * ingedeeld model op één plek recht te zetten is.
 *
 * De regels zijn geordend: de eerste die past, wint. Dat is bewust, want de
 * facetten overlappen. `Terrain_Sand_Incline_Curve_Inner_4x4` is een helling
 * én een binnenbocht; hij staat bij de binnenbochten, omdat de bocht bepaalt
 * waar hij in een layout past en de helling alleen hoe hij eruitziet. Wat er
 * zo wegvalt komt terug als kenmerk (zie KENMERKEN).
 */

/* -- families -------------------------------------------------------------
 * Eén sectie per familie in het tabblad Onderdelen. De volgorde hier is de
 * volgorde op de pagina: van de kale bouwstenen naar de aankleding.
 */
export const FAMILIES = [
  {
    id: 'basis',
    titel: 'Basis — kliffen',
    kort: 'Basis',
    kleur: '#9a8f80',
    uitleg: 'De kale klifblokken waar het reliëf op staat. Elk stuk bestaat in vier lagen die je op elkaar stapelt.',
    test: (n) => n.startsWith('Basic_'),
  },
  {
    id: 'wand',
    titel: 'Wanden',
    kort: 'Wanden',
    kleur: '#6f7b8c',
    uitleg: 'Rechte en gebogen wandsegmenten met een grotere straal dan de basisblokken.',
    test: (n) => n.startsWith('Wall_'),
  },
  {
    id: 'gebarsten',
    titel: 'Gebarsten kliffen',
    kort: 'Gebarsten',
    kleur: '#a8705a',
    uitleg: 'Dezelfde vormen als de basisblokken, maar met een gebroken rand. Genummerde varianten wisselen elkaar af zodat een lange wand niet herhaalt.',
    test: (n) => n.startsWith('Cracked_'),
  },
  {
    id: 'keermuur',
    titel: 'Keermuren',
    kort: 'Keermuren',
    kleur: '#b98c5a',
    uitleg: 'Gemetselde muurtjes die een hoogteverschil opvangen: recht, gebogen, getrapt en onder 45 graden.',
    test: (n) => n.startsWith('Tiered_Retaining_Wall_'),
  },
  {
    id: 'grastrede',
    titel: 'Grastreden',
    kort: 'Grastreden',
    kleur: '#5f9e4a',
    uitleg: 'De grasrand die boven op een keermuur ligt, in dezelfde stralen als de muren zelf.',
    test: (n) => n.startsWith('Tiered_Grass_'),
  },
  {
    id: 'looppad',
    titel: 'Traptreden & looppaden',
    kort: 'Trappen',
    kleur: '#c9a227',
    uitleg: 'Trappen tussen twee terrassen, plus de overgangsstukken naar een pad.',
    test: (n) => n.startsWith('Tiered_Walkway_'),
  },
  {
    id: 'pad-terrein',
    titel: 'Paden — terrein',
    kort: 'Paden',
    kleur: '#d98f4f',
    uitleg: 'Het pad zelf, als uitsparing in het gras: recht, in bochten, met hellingen en met een Y-splitsing.',
    test: (n) => n.startsWith('Path_Terrain_'),
  },
  {
    id: 'pad-hek',
    titel: 'Paden — hekwerk',
    kort: 'Hekwerk',
    kleur: '#8e6a4a',
    uitleg: 'Houten hek langs een pad, inclusief poort, scharnier en losse paal.',
    test: (n) => n.startsWith('Path_Fence_'),
  },
  {
    id: 'pad-randsteen',
    titel: 'Paden — randstenen',
    kort: 'Randstenen',
    kleur: '#a3a3a3',
    uitleg: 'Stenen boordjes die het pad afzomen; volgt dezelfde bochten als het hekwerk.',
    test: (n) => n.startsWith('Path_Edging_Stones_'),
  },
  {
    id: 'pad-brug',
    titel: 'Paden — brug & einde',
    kort: 'Brug & einde',
    kleur: '#8a5a2f',
    uitleg: 'Waar het pad ophoudt of een gat oversteekt.',
    test: (n) => n.startsWith('Path_Bridge_') || n.startsWith('Path_End_'),
  },
  {
    id: 'gras-tapijt',
    titel: 'Gras — tapijt',
    kort: 'Grastapijt',
    kleur: '#79c04a',
    uitleg: 'Een dunne grasmat die je over een vlak legt, met randen die netjes om een hoek lopen.',
    test: (n) => n.startsWith('Grass_Carpet_') || n.startsWith('Grass_Flat_'),
  },
  {
    id: 'gras-heuvel',
    titel: 'Gras — heuvels',
    kort: 'Heuvels',
    kleur: '#3f8f5f',
    uitleg: 'Glooiend gras zonder klifrand: zacht of scherp oplopend, met overgangen tussen beide.',
    test: (n) => n.startsWith('Grass_Hill_'),
  },
  {
    id: 'zand',
    titel: 'Zand',
    kort: 'Zand',
    kleur: '#e0c27a',
    uitleg: 'Zandhellingen om een strand of duin mee te leggen; de grootste stukken van de kit.',
    test: (n) => n.startsWith('Terrain_Sand_'),
  },
  {
    id: 'rivier',
    titel: 'Rivier',
    kort: 'Rivier',
    kleur: '#3aa7d6',
    uitleg: 'Stromend water in het terrein, met bochten linksom (CCW) en rechtsom (CW) en twee stroomsnelheden.',
    test: (n) => n.startsWith('Terrain_Water_'),
  },
  {
    id: 'water',
    titel: 'Water & watervallen',
    kort: 'Watervallen',
    kleur: '#2fc7e8',
    uitleg: 'Losse watervlakken en de drie rijen — top, midden, voet — waaruit een waterval wordt opgebouwd.',
    test: (n) => n.startsWith('Water_') || n.startsWith('Waterfall_'),
  },
  {
    id: 'ijsberg',
    titel: 'IJsbergen',
    kort: 'IJsbergen',
    kleur: '#8fc7ff',
    uitleg: 'Drijvende ijsschotsen in dezelfde bochtstralen als de kliffen.',
    test: (n) => n.startsWith('Iceberg_'),
  },
  {
    id: 'steiger',
    titel: 'Steigers',
    kort: 'Steigers',
    kleur: '#c08447',
    uitleg: 'Houten dek, palen, ladder en touwreling — inclusief gebroken varianten.',
    test: (n) => n.startsWith('Docks_'),
  },
  {
    id: 'grot-wand',
    titel: 'Grot — wanden',
    kort: 'Grotwand',
    kleur: '#7a6a86',
    uitleg: 'De wandstukken van de grot, in drie lagen te stapelen.',
    test: (n) => n.startsWith('Cave_'),
  },
  {
    id: 'grot-vlak',
    titel: 'Grot — vloer & plafond',
    kort: 'Vloer & plafond',
    kleur: '#6b6076',
    uitleg: 'Hetzelfde stuk twee keer: één keer als vloer, één keer omgekeerd als plafond.',
    test: (n) => n.startsWith('Floor_') || n.startsWith('Ceiling_'),
  },
  {
    id: 'props',
    titel: 'Props',
    kort: 'Props',
    kleur: '#b76fa8',
    uitleg: 'Losse aankleding: druipstenen, zuilen, uitstulpingen, borden en touwbruggen.',
    test: (n) => n.startsWith('Prop_'),
  },
];

/* -- vormen ---------------------------------------------------------------
 * Hoe het stuk in een layout past. Bewust niet hoe het eruitziet: een getrapte
 * rechte muur ligt op dezelfde plek in het raster als een gladde rechte muur,
 * en dat is waar je op zoekt als je aan het bouwen bent.
 */
export const VORMEN = [
  { id: 'bocht-binnen', titel: 'Binnenbocht', kort: 'Binnenbocht', kleur: '#d4694f', patroon: /Curve_Inner/ },
  { id: 'bocht-buiten', titel: 'Buitenbocht', kort: 'Buitenbocht', kleur: '#e08b3e', patroon: /Curve_Outer/ },
  { id: 'bocht', titel: 'Bocht', kort: 'Bocht', kleur: '#c9a227', patroon: /Curve/ },
  { id: 'esse', titel: 'Esse (S-bocht)', kort: 'Esse', kleur: '#9b6bd6', patroon: /Esse/ },
  { id: 'helling', titel: 'Helling', kort: 'Helling', kleur: '#4f9ed4', patroon: /Incline/ },
  { id: 'overlappend', titel: 'Overlappend', kort: 'Overlappend', kleur: '#7f8fa6', patroon: /Overlapping/ },
  { id: 'recht', titel: 'Recht', kort: 'Recht', kleur: '#5f9e4a', patroon: /Straight/ },
  { id: 'trap', titel: 'Trap & ladder', kort: 'Trap', kleur: '#b98c5a', patroon: /Steps|Stepped|Ladder/ },
  { id: 'overgang', titel: 'Overgang', kort: 'Overgang', kleur: '#d76fa0', patroon: /Transition/ },
  { id: 'vlak', titel: 'Vlak', kort: 'Vlak', kleur: '#8d8377', patroon: /Flat/ },
  { id: 'eind', titel: 'Eind & hoek', kort: 'Eind', kleur: '#6f7b8c', patroon: /(^|_)(End|Corner)(_|$)/ },
  { id: 'los', titel: 'Losstaand', kort: 'Losstaand', kleur: '#9a9a9a', patroon: /./ },
];

/* -- lagen ----------------------------------------------------------------
 * Waar het stuk in een stapel hoort. `Under` is de onderzijde die je ziet als
 * een klif overhangt; `Base`, `Mid` en `Top` stapelen daarboven. Stukken zonder
 * laagachtervoegsel staan op zichzelf — een heuvel of een prop stapelt niet.
 */
export const LAGEN = [
  { id: 'laag-onder', titel: 'Onderzijde', kort: 'Onder', kleur: '#6b6076', token: 'Under' },
  { id: 'laag-basis', titel: 'Basis', kort: 'Basis', kleur: '#8a6f5a', token: 'Base' },
  { id: 'laag-midden', titel: 'Midden', kort: 'Midden', kleur: '#b08968', token: 'Mid' },
  { id: 'laag-boven', titel: 'Bovenkant', kort: 'Boven', kleur: '#d9b382', token: 'Top' },
  { id: 'laag-geen', titel: 'Zonder laag', kort: 'Geen laag', kleur: '#9a9a9a', token: null },
];

/* -- formaten -------------------------------------------------------------
 * Het rastervak dat het stuk beslaat, zoals de naam het zegt. Niet de gemeten
 * bounding box: die wijkt bewust af (een overhangende klif steekt buiten zijn
 * vak uit) en staat apart in het detailvenster.
 */
export const FORMAATGROEPEN = [
  { id: 'f-1x1', titel: '1 × 1', kleur: '#4f9ed4', test: (b, d) => b === 1 && d === 1 },
  { id: 'f-smal', titel: 'Smal (1 × n)', kleur: '#5aa9c6', test: (b, d) => Math.min(b, d) === 1 },
  { id: 'f-2', titel: '2 × 2 en 2 × n', kleur: '#6aa84f', test: (b, d) => Math.min(b, d) === 2 },
  { id: 'f-3', titel: '3 × 3 en 3 × n', kleur: '#c9a227', test: (b, d) => Math.min(b, d) === 3 },
  { id: 'f-4', titel: '4 × 4 en 4 × n', kleur: '#e08b3e', test: (b, d) => Math.min(b, d) === 4 },
  { id: 'f-groot', titel: '5 × 5 en groter', kleur: '#d4694f', test: (b, d) => Math.min(b, d) >= 5 },
  { id: 'f-geen', titel: 'Zonder rastermaat', kleur: '#9a9a9a', test: () => true },
];

/* -- kenmerken ------------------------------------------------------------
 * Wat er in de naam staat maar niet in een facet past: hoe steil, hoe strak,
 * welke variant. Ze staan in het detailvenster en doen mee in de zoektekst,
 * zodat "getrapt" of "linksom" gewoon iets vindt.
 *
 * De volgorde is de leesvolgorde in het detail; de eerste regel die past wint
 * per kenmerk, dubbele treffers worden ontdubbeld.
 */
const KENMERKEN = [
  [/45_Degrees/, '45 graden'],
  [/Deformed_Straight_Concave|Concave/, 'hol vervormd'],
  [/Deformed_Straight_Convex|Convex/, 'bol vervormd'],
  [/Deformed/, 'vervormd'],
  [/Stepped/, 'getrapt'],
  [/Gentle/, 'zacht'],
  [/Sharp/, 'scherp'],
  [/Grade_Transition/, 'hellingovergang'],
  [/Narrow/, 'smalle straal'],
  [/Wide/, 'brede straal'],
  [/Short/, 'laag'],
  [/Tall/, 'hoog'],
  [/Inside/, 'binnenzijde'],
  [/Outside/, 'buitenzijde'],
  [/_Both(_|$)/, 'beide zijden'],
  [/_CCW(_|$)/, 'linksom (CCW)'],
  [/_CW(_|$)/, 'rechtsom (CW)'],
  [/_Center(_|$)/, 'midden'],
  [/_Edge(_|$)/, 'rand'],
  [/_Left(_|$)/, 'links'],
  [/_Right(_|$)/, 'rechts'],
  [/_Front(_|$)/, 'voorzijde'],
  [/_Rear(_|$)/, 'achterzijde'],
  [/Roped|_Rope(_|$)/, 'touw'],
  [/Broken/, 'gebroken'],
  [/Cracked/, 'gebarsten'],
  [/Hinged/, 'scharnier'],
  [/Plain/, 'zonder scharnier'],
  [/Gate/, 'poort'],
  [/Pillar|Column/, 'pilaar'],
  [/Mound/, 'bult'],
  [/Lowpoly/, 'lowpoly'],
  [/Midpoly/, 'midpoly'],
  [/Highpoly/, 'highpoly'],
  [/_Y_/, 'Y-splitsing'],
  [/Dirt/, 'zandpad'],
  [/Grass/, 'gras'],
  [/Sign/, 'bord'],
];

/* -- tabbladen ------------------------------------------------------------
 * Vier facetten over de hele kit, plus twee deelverzamelingen die op zichzelf
 * een compleet setje vormen. Die twee zijn geen aparte kit — hun stukken staan
 * ook gewoon in de andere tabbladen — maar wie een grot of een kust bouwt, wil
 * ze bij elkaar zien zonder de rest ertussen.
 */
export const TABBLADEN = [
  { id: 'onderdelen', label: 'Onderdelen', facet: 'familie' },
  { id: 'vormen', label: 'Vormen', facet: 'vorm' },
  { id: 'lagen', label: 'Lagen', facet: 'laag' },
  { id: 'formaten', label: 'Formaten', facet: 'formaat' },
  {
    id: 'grot',
    label: 'Grot',
    facet: 'familie',
    families: ['grot-wand', 'grot-vlak', 'props'],
    // De props-familie is groter dan de grot; alleen wat ondergronds hoort.
    filter: (n) => !n.startsWith('Prop_') || /Stalactite|Stalagmite|Column|Protrusion|Sign/.test(n),
    uitleg: 'Alles wat je ondergronds nodig hebt: wand, vloer, plafond en de druipstenen ertussen. Deze stukken staan ook in de andere tabbladen.',
  },
  {
    id: 'kust',
    label: 'Kust',
    facet: 'familie',
    families: ['rivier', 'water', 'ijsberg', 'zand', 'steiger', 'pad-brug', 'props'],
    filter: (n) => !n.startsWith('Prop_') || /Bridge/.test(n),
    uitleg: 'Water, zand en alles wat erop of eroverheen ligt. Deze stukken staan ook in de andere tabbladen.',
  },
];

/* -- afleiden -------------------------------------------------------------- */

const eerste = (lijst, test) => lijst.find(test);

/** Familie van een model; valt terug op `props` zodat er nooit een stuk wegvalt. */
export function bepaalFamilie(naam) {
  return eerste(FAMILIES, (f) => f.test(naam)) ?? FAMILIES.at(-1);
}

/** Vorm van een model; de laatste regel vangt alles op. */
export function bepaalVorm(naam) {
  return eerste(VORMEN, (v) => v.patroon.test(naam));
}

/**
 * Laag van een model. Het achtervoegsel staat niet altijd achteraan —
 * `Basic_Esse_Base_2x2` zet hem in het midden — dus we zoeken het token overal
 * in de naam. `Under` gaat voor: `Basic_Curve_Inner_2x2_Narrow_Under` heeft
 * geen ander laagtoken, maar het bestaan van de reeks Base/Mid/Top/Under maakt
 * de volgorde hier wel zichtbaar.
 */
export function bepaalLaag(naam) {
  const tokens = new Set(naam.split('_'));
  return eerste(LAGEN, (l) => l.token && tokens.has(l.token)) ?? LAGEN.at(-1);
}

/**
 * Rastermaat uit de naam: het láátste `nxn` wint. Dat is nodig omdat de borden
 * hun beeldverhouding in de naam dragen — `Prop_Sign_16x9_1_1x1` is een bord
 * van 16 : 9 op één rastervak — en het formaat altijd achteraan staat.
 */
export function bepaalFormaat(naam) {
  const treffers = [...naam.matchAll(/(\d+)x(\d+)/g)];
  if (treffers.length === 0) return null;
  const [, b, d] = treffers.at(-1);
  return { label: `${b} × ${d}`, breedte: Number(b), diepte: Number(d) };
}

export function bepaalFormaatgroep(formaat) {
  if (!formaat) return FORMAATGROEPEN.at(-1);
  return eerste(FORMAATGROEPEN, (g) => g.test(formaat.breedte, formaat.diepte));
}

export function bepaalKenmerken(naam) {
  const uit = [];
  for (const [patroon, label] of KENMERKEN) {
    if (patroon.test(naam) && !uit.includes(label)) uit.push(label);
  }
  return uit;
}

/**
 * Genummerde varianten: `Cracked_Straight_2x2_3_Top` is de derde van drie
 * gebarsten rechte stukken van 2 × 2. Het nummer staat los tussen underscores
 * en is nooit het formaat, want dat bevat altijd een `x`.
 */
export function bepaalVariant(naam) {
  const zonderFormaat = naam.replace(/\d+x\d+/g, '');
  const treffer = zonderFormaat.match(/_(\d+)(?=_|$)/);
  return treffer ? Number(treffer[1]) : null;
}

/** `Tiered_Retaining_Wall_Flat_Curve_1x1_Top` → `Tiered Retaining Wall Flat Curve 1x1 Top`. */
export const leesbaar = (naam) => naam.replace(/_/g, ' ');

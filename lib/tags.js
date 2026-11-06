// Automatisk taggning: språk (från låttext) + dansband/schlager + rock/pop.
import { parseLrc } from '../public/lrc.js';
import { foldDiacritics } from './util.js';

export const TAGS = ['sv', 'en', 'dansband', 'rockpop'];

const SV_ARTISTS = ['gyllene tider', 'per gessle', 'veronica maggio', 'hakan hellstrom', 'lars winnerback', 'ted gardestad',
  'tomas ledin', 'ulf lundell', 'kent', 'eva dahlgren', 'lisa nilsson', 'magnus uggla', 'carola', 'petter', 'laleh',
  'molly sanden', 'miriam bryant', 'oskar linnros', 'timbuktu', 'thomas stenstrom', 'lasse berghagen', 'bjorn skifs',
  'evert taube', 'cornelis vreeswijk', 'siw malmkvist', 'lena philipsson', 'orup', 'niklas stromstedt', 'mauro scocco',
  'peter lemarc', 'ebba gron', 'imperiet', 'sven-bertil taube', 'lill lindfors', 'jakob hellman', 'markoolio', 'linnea henriksson'];
const DANSBAND = ['lasse stefanz', 'vikingarna', 'thorleifs', 'sven-ingvars', 'sven ingvars', 'black jack', 'arvingarna', 'drifters',
  'kikki danielsson', 'lotta engberg', 'larz-kristerz', 'larz kristerz', 'wizex', 'streaplers', 'barbados', 'torgny melins',
  'matz bladhs', 'scotts', 'jannez', 'elisas', 'casanovas', 'titanix', 'gronwalls', 'friends', 'herreys', 'sannex',
  'flamingokvintetten', 'curt haagers', 'date', 'christer sjogren', 'anders engberg', 'kenneth & the knutters'];

export function detectLang(text) {
  if (!text) return null;
  const t = ` ${foldDiacritics(text).toLowerCase().replace(/[^a-z\s]/g, ' ')} `;
  const raw = text.toLowerCase();
  const count = (words) => words.reduce((n, w) => n + (t.split(` ${w} `).length - 1), 0);
  const sv = count(['och', 'jag', 'inte', 'det', 'att', 'du', 'som', 'har', 'med', 'mig', 'dig', 'vi', 'ar', 'pa', 'en', 'min', 'var'])
    + (raw.match(/[åäö]/g)?.length || 0) * 0.5;
  const en = count(['the', 'and', 'you', 'i', 'me', 'my', 'is', 'it', 'to', 'of', 'love', 'your', 'we', 'on', 'in', 'that']);
  if (sv + en < 8) return null;
  return sv > en ? 'sv' : 'en';
}

export function autoTags(song, genres = []) {
  const tags = new Set();
  const artistF = foldDiacritics(song.artist || '').toLowerCase();
  const genreStr = (genres || []).join(' ');
  const isDansband = DANSBAND.some((a) => artistF.includes(a)) || /dansband|schlager|country|melodifestival/i.test(genreStr);
  const lyricText = song.lrc ? parseLrc(song.lrc).lines.map((l) => l.text).join(' ') : '';
  let lang = detectLang(lyricText);
  if (!lang) {
    if (/[åäöÅÄÖ]/.test(`${song.artist} ${song.title}`) || SV_ARTISTS.some((a) => artistF.includes(a)) || isDansband) lang = 'sv';
    else lang = 'en';
  }
  tags.add(lang);
  if (isDansband) tags.add('dansband');
  if (/rock|pop|indie|alternative|punk|metal|disco|dance/i.test(genreStr) || !isDansband) tags.add('rockpop');
  return [...tags];
}

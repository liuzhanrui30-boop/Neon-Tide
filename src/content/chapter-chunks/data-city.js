import { PROTOCOL_ZERO } from '../bosses/protocol-zero.js';
import { DATA_CITY_CHAPTER } from '../chapters/data-city.js';
import { registerLoadedChapterContent } from '../chapter-registry.js';

export const CHAPTER_CONTENT = registerLoadedChapterContent(Object.freeze({
  chapterId: 'data-city',
  assetNamespace: 'realm-data-city',
  artModule: 'data-city-skyline-and-traffic',
  bossModule: 'protocol-zero-arena',
  landmarks: Object.freeze(['server-spires', 'packet-highways', 'hologram-billboards']),
  chapter: DATA_CITY_CHAPTER,
  boss: PROTOCOL_ZERO,
}));
export default CHAPTER_CONTENT;

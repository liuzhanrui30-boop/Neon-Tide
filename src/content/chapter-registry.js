const loaded = new Map();

export function registerLoadedChapterContent(content) {
  if (!content || typeof content.chapterId !== 'string' || !content.chapter || !content.boss) {
    throw new TypeError('loaded chapter content requires chapter and Boss definitions');
  }
  loaded.set(content.chapterId, content);
  return content;
}

export function getLoadedChapterContent(chapterId) {
  return loaded.get(chapterId) ?? null;
}

// Unione di una serie importata da backup con quella già presente.
//
// Regole (nessun dato dell'utente viene perso):
// - metadati della serie (nome, poster, generi, ...): restano quelli locali;
// - episodi: abbinati per ID TVMaze, oppure per stagione+numero se manca l'ID;
//   visto = visto in almeno una delle due copie; rating e nota locali vincono,
//   altrimenti si adottano quelli del backup;
// - episodi presenti solo nel backup vengono aggiunti;
// - tag: unione case-insensitive (prima i locali), entro MAX_TAGS_PER_SHOW;
// - lista: se il backup ha più episodi visti si adotta la sua scelta manuale,
//   poi la riconciliazione standard.
//
// Non muta gli oggetti episodio esistenti: crea nuove stagioni, così il
// chiamante può fare rollback ripristinando lo snapshot superficiale.

import type { Episode, Show } from '../types';
import { MAX_TAGS_PER_SHOW } from './constants';
import { updateShowListStatus } from './normalize';
import { getWatchedCount } from './utils';

function sameEpisode(a: Episode, b: Episode): boolean {
  if (a.id > 0 && b.id > 0) return a.id === b.id;
  return a.num === b.num;
}

function mergeEpisode(local: Episode, imported: Episode): Episode {
  const merged: Episode = { ...local, watched: local.watched || imported.watched };
  if (merged.rating === undefined && imported.rating !== undefined) merged.rating = imported.rating;
  if (merged.note === undefined && imported.note !== undefined) merged.note = imported.note;
  if (merged.watched && merged.watchedAt === undefined && imported.watchedAt !== undefined) {
    merged.watchedAt = imported.watchedAt;
  }
  return merged;
}

/** Unisce `imported` dentro `existing`. Ritorna true se qualcosa è cambiato. */
export function mergeImportedShow(existing: Show, imported: Show): boolean {
  const before = JSON.stringify([existing.seasons, existing.tags, existing.list, existing.manualList]);
  const importedHadMoreProgress = getWatchedCount(imported) > getWatchedCount(existing);

  const seasons: Record<number, Episode[]> = {};
  const seasonKeys = new Set([...Object.keys(existing.seasons), ...Object.keys(imported.seasons)].map(Number));
  for (const season of seasonKeys) {
    const localEps = existing.seasons[season] ?? [];
    const importedEps = imported.seasons[season] ?? [];
    const used = new Set<Episode>();
    const result = localEps.map((ep) => {
      const match = importedEps.find((other) => !used.has(other) && sameEpisode(ep, other));
      if (!match) return { ...ep };
      used.add(match);
      return mergeEpisode(ep, match);
    });
    for (const ep of importedEps) {
      if (!used.has(ep) && !result.some((local) => sameEpisode(local, ep))) result.push({ ...ep });
    }
    result.sort((a, b) => a.num - b.num);
    seasons[season] = result;
  }

  const tags: string[] = [];
  const seen = new Set<string>();
  for (const tag of [...(existing.tags ?? []), ...(imported.tags ?? [])]) {
    const key = tag.toLowerCase();
    if (seen.has(key) || tags.length >= MAX_TAGS_PER_SHOW) continue;
    seen.add(key);
    tags.push(tag);
  }

  existing.seasons = seasons;
  existing.totalSeasons = Object.keys(seasons).length;
  existing.totalEpisodes = Object.values(seasons).reduce((sum, eps) => sum + eps.length, 0);
  existing.tags = tags;
  if (importedHadMoreProgress) {
    existing.list = imported.list;
    existing.manualList = imported.manualList;
  }
  updateShowListStatus(existing);

  return JSON.stringify([existing.seasons, existing.tags, existing.list, existing.manualList]) !== before;
}

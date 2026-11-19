import 'server-only';
import { getThesisView, listThesisFeed } from '@thesis/services';
import { publicationDb, viewerId } from './publication-http';
export async function loadFeed(kind: 'agent' | 'human') {
  try { return await listThesisFeed(publicationDb(), { kind }); } catch { return undefined; }
}
export async function loadThesis(id: string) {
  return getThesisView(publicationDb(), id, await viewerId());
}

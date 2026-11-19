import { api } from './lib';

/** Lit la version servie par le partage, ou sa copie disponible hors ligne. */
export async function readSharedFile(path: string) {
  const file = await api.sharedFile(path);
  if (!file.hash || file.deleted) throw new Error(`« ${file.name} » n’est pas disponible.`);
  return { file, bytes: await api.sharedContent(file.hash) };
}

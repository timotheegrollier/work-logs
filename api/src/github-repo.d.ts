/** Normalise un dépôt GitHub relié : `propriétaire/dépôt`, ou null si vide. Lève une erreur 400 sinon. */
export function normalizeGithubRepo(value: unknown): string | null;
export const GITHUB_REPO_MESSAGE: string;

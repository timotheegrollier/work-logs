export interface ProjectFolders {
  shared_dir?: string | null;
  shared_dirs?: readonly string[];
}
export interface NormalizedProjectFolders {
  shared_dir: string | null;
  shared_dirs: string[];
}
export function projectFolders(project?: ProjectFolders): NormalizedProjectFolders;
export function nextProjectFolders(patch: ProjectFolders, current?: ProjectFolders): NormalizedProjectFolders;
export function mergeProjectFolders(winner: ProjectFolders, previous?: ProjectFolders): NormalizedProjectFolders;
export function decodeProject<T extends object>(row: T): T & NormalizedProjectFolders;

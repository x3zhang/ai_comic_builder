/**
 * Remember which storyboard version the user was viewing per episode so that
 * remounting the episode layout (e.g. settings → back) can refetch the same
 * version instead of always defaulting to the newest one.
 */
const PREFIX = "aicomic:storyboardVersion:";

export function storyboardVersionStorageKey(
  projectId: string,
  episodeId: string,
): string {
  return `${PREFIX}${projectId}:${episodeId}`;
}

export function readPersistedStoryboardVersion(
  projectId: string,
  episodeId: string,
): string | null {
  if (typeof window === "undefined") return null;
  try {
    return sessionStorage.getItem(
      storyboardVersionStorageKey(projectId, episodeId),
    );
  } catch {
    return null;
  }
}

export function writePersistedStoryboardVersion(
  projectId: string,
  episodeId: string,
  versionId: string | null,
): void {
  if (typeof window === "undefined") return;
  try {
    const k = storyboardVersionStorageKey(projectId, episodeId);
    if (versionId) sessionStorage.setItem(k, versionId);
    else sessionStorage.removeItem(k);
  } catch {
    /* private mode / quota */
  }
}

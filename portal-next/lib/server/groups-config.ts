import 'server-only';
import { deleteFile, getFile, putFile } from '@/lib/server/gitea';
import { GROUPS_CONFIG_LEGACY_PATH, GROUPS_CONFIG_PATH } from './groups-config-paths';

function parseGroups(content: string): Record<string, unknown> {
  const parsed = JSON.parse(content) as { groups?: Record<string, unknown> };
  return parsed.groups ?? (parsed as Record<string, unknown>);
}

/** Read groups-config from repo root; migrate from legacy import path if needed. */
export async function readGroupsConfig(org: string): Promise<Record<string, unknown>> {
  const root = await getFile(org, 'baseline', GROUPS_CONFIG_PATH);
  if (root.exists) return parseGroups(root.content);

  const legacy = await getFile(org, 'baseline', GROUPS_CONFIG_LEGACY_PATH);
  if (!legacy.exists) return {};

  try {
    await putFile(
      org,
      'baseline',
      GROUPS_CONFIG_PATH,
      legacy.content,
      'chore: move groups-config.json to repo root',
    );
    await deleteFile(
      org,
      'baseline',
      GROUPS_CONFIG_LEGACY_PATH,
      legacy.sha,
      'chore: move groups-config.json to repo root',
    );
  } catch (err) {
    console.warn('[groups-config] migrate legacy path failed:', err);
  }

  return parseGroups(legacy.content);
}

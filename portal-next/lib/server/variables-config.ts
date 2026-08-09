import 'server-only';
import { getFile } from '@/lib/server/gitea';
import { VARIABLES_CONFIG_PATH } from './variables-config-paths';

export interface VariableDefinition {
  description?: string;
  default?: string;
  groups?: Record<string, string>;
}

export interface VariablesConfig {
  variables: Record<string, VariableDefinition>;
}

function parseVariables(content: string): Record<string, VariableDefinition> {
  const parsed = JSON.parse(content) as { variables?: Record<string, VariableDefinition> };
  return parsed.variables ?? {};
}

/** Read variables.json from the MSP baseline repo root. */
export async function readVariablesConfig(org: string): Promise<Record<string, VariableDefinition>> {
  const root = await getFile(org, 'baseline', VARIABLES_CONFIG_PATH);
  if (!root.exists) return {};
  try {
    return parseVariables(root.content);
  } catch {
    return {};
  }
}

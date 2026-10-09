/**
 * Role definition tests (Phase 4).
 *
 * - All 7 roles defined, prompts carry version tags.
 * - Least privilege: reviewer is read-only (no writeFile/execBuild/askUser);
 *   asset has no build tools; qa has no writes.
 * - Every allowedTools entry names a real tool in the registry.
 * - Model selection is by role key, never a model name.
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_ROLES,
  ROLE_DEFS,
  getRoleDef,
  isAgentRole,
} from '../src/roles.js';
import { TOOLS } from '../src/tools.js';
import { toolDefsForRole } from '../src/tools.js';

const REAL_TOOLS = new Set(TOOLS.map((t) => t.name));

describe('role definitions', () => {
  it('defines all 7 roles with version tags', () => {
    expect(AGENT_ROLES).toHaveLength(7);
    for (const role of AGENT_ROLES) {
      const def = getRoleDef(role);
      expect(def.version).toBe('v1');
      expect(def.promptDate).toBe('2026-10-09');
      expect(def.systemPrompt).toContain('PROMPT v1 — 2026-10-09');
      expect(def.modelRole).toBeTruthy();
      // No model names leak into selection keys.
      expect(def.modelRole).not.toMatch(/gpt|llama|Muse|qwen/i);
    }
  });

  it('reviewer is read-only: no writes, no builds, no user questions', () => {
    const tools = getRoleDef('reviewer').allowedTools;
    expect(tools).not.toContain('writeFile');
    expect(tools).not.toContain('execBuild');
    expect(tools).not.toContain('askUser');
    expect(tools).not.toContain('dispatchTask');
    expect(tools).toContain('readFile');
    expect(tools).toContain('gatherEvidence');
    expect(tools).toContain('finishRun');
  });

  it('asset has no build tools; qa has no writes', () => {
    expect(getRoleDef('asset').allowedTools).not.toContain('execBuild');
    expect(getRoleDef('asset').allowedTools).not.toContain('buildStatus');
    expect(getRoleDef('qa').allowedTools).not.toContain('writeFile');
    expect(getRoleDef('qa').allowedTools).toContain('gatherEvidence');
  });

  it('every allowedTools entry names a real registered tool', () => {
    for (const role of AGENT_ROLES) {
      for (const name of getRoleDef(role).allowedTools) {
        expect(REAL_TOOLS.has(name), `${role} allows unknown tool ${name}`).toBe(true);
      }
    }
  });

  it('director prompt documents dispatchTask and remember', () => {
    expect(getRoleDef('director').systemPrompt).toContain('dispatchTask');
    expect(getRoleDef('director').systemPrompt).toContain('remember');
  });

  it('toolDefsForRole restricts the registry per role', () => {
    const reviewerDefs = toolDefsForRole('reviewer').map((t) => t.name);
    expect(reviewerDefs).not.toContain('writeFile');
    expect(reviewerDefs).toContain('readFile');
    const gameplayDefs = toolDefsForRole('gameplay').map((t) => t.name);
    expect(gameplayDefs).toContain('writeFile');
    expect(gameplayDefs).not.toContain('dispatchTask');
    expect(gameplayDefs).not.toContain('askUser');
  });

  it('isAgentRole / getRoleDef fail closed on unknown roles', () => {
    expect(isAgentRole('gameplay')).toBe(true);
    expect(isAgentRole('janitor')).toBe(false);
    expect(() => getRoleDef('janitor')).toThrow();
  });
});

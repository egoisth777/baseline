import * as fs from 'fs';
import * as path from 'path';

export interface Route {
  id: string;
  event: string;
  freq: number;
  cwd?: string;
  doc: string;
}

export interface ParsedEvent {
  base: string;
  phase?: string;
}

// Events this dispatcher can inject standing context into.
export const SUPPORTED_EVENTS = ['UserPromptSubmit', 'SessionStart', 'PreToolUse', 'PostToolUse'];
// SessionStart lifecycle phases. An event may name one via a "SessionStart.<phase>"
// suffix; the phase then resolves against the hook stdin `source`.
export const SESSION_PHASES = ['startup', 'resume', 'clear', 'compact'];
// Route id shape — keys the counter and labels the route in status/doctor.
export const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export const MAX_CONFIG_BYTES = 64 * 1024;
export const MAX_DOC_BYTES = 64 * 1024;
export const MAX_DOC_CHARS = 10_000;
export const MAX_ROUTES = 64;

// Split a route event into its base event and optional SessionStart phase suffix, on
// the FIRST '.'. "SessionStart.compact" -> { base:'SessionStart', phase:'compact' };
// a bare "UserPromptSubmit" -> { base:'UserPromptSubmit' }.
export function parseEvent(event: string): ParsedEvent {
  const dot = event.indexOf('.');
  if (dot === -1) return { base: event };
  return { base: event.slice(0, dot), phase: event.slice(dot + 1) };
}

// Resolve a route's `doc` against a config dir; reject escapes.
export function safeDocPath(doc: string, cfgDir: string): string | null {
  if (typeof doc !== 'string' || !doc) return null;
  if (path.isAbsolute(doc)) return null;
  const resolved = path.resolve(cfgDir, doc);
  const rel = path.relative(cfgDir, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return resolved;
}

export function pathInside(base: string, candidate: string): boolean {
  const rel = path.relative(base, candidate);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

export function safeRealDocPath(doc: string, cfgDir: string): string | null {
  const p = safeDocPath(doc, cfgDir);
  if (!p) return null;
  try {
    const realBase = fs.realpathSync(cfgDir);
    const realDoc = fs.realpathSync(p);
    return pathInside(realBase, realDoc) ? p : null;
  } catch (e) {
    return null;
  }
}

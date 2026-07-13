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
// Exact config-schema-v1 route keys. This is internal implementation source, not a
// public package API.
export const ROUTE_KEYS = ['id', 'event', 'freq', 'cwd', 'doc'];
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

// A valid route event is one supported base event, optionally with a recognized
// SessionStart phase. Other base-event suffixes are invalid.
export function isSupportedRouteEvent(event: string): boolean {
  const { base, phase } = parseEvent(event);
  if (SUPPORTED_EVENTS.indexOf(base) === -1) return false;
  return phase === undefined || (base === 'SessionStart' && SESSION_PHASES.indexOf(phase) !== -1);
}

// Event-name match: the route's base event equals the native hook event, and any
// SessionStart phase suffix equals the stdin `source` (a bare event matches every
// phase). Shared by the dispatcher and `dispatch simulate` so a simulation selects
// exactly what a real invocation would.
export function eventMatches(routeEvent: string, hookEventName: string | undefined, source: string | undefined): boolean {
  const { base, phase } = parseEvent(routeEvent);
  if (base !== hookEventName) return false;
  return phase === undefined || source === phase;
}

// cwd scope match: normalized path-boundary prefix (/foo must not match /foobar),
// case-insensitive on Windows. An omitted route cwd matches any directory.
export function cwdMatches(routeCwd: string | undefined, sessionCwd: string | undefined, isWin: boolean): boolean {
  if (routeCwd === undefined) return true;
  const sessionRaw = typeof sessionCwd === 'string' ? sessionCwd : '';
  if (!sessionRaw) return false;
  let base = path.resolve(routeCwd);
  let here = path.resolve(sessionRaw);
  if (isWin) { base = base.toLowerCase(); here = here.toLowerCase(); }
  if (base === here) return true;
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  return here.startsWith(prefix);
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

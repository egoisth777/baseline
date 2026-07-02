import * as fs from 'fs';
import * as path from 'path';

export interface Route {
  id: string;
  event: string;
  freq: number;
  cwd?: string;
  doc: string;
  vars?: VarMap;
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

// --- {{name}} deterministic templating (R-010, goal decision #18) ------------
// Docs may carry {{name}} placeholders resolved at dispatch time. Resolution is
// deterministic and in-process: NO exec, NO model calls, NO dynamic file selection
// (decision #5). Unknown placeholders are left byte-for-byte verbatim (no error, no
// strip). There is no escaping syntax this cycle.

export interface VarMap { [name: string]: string; }

// Everything a provider may read to resolve a token — output is a pure function of these.
export interface TemplateContext {
  event: string;   // native hook event name → {{event}}
  cwd: string;     // session working directory → {{cwd}}
  home: string;    // user home → {{home}}
  now: Date;       // one clock snapshot per dispatch → {{date}} / {{time}}
  env: { [k: string]: string | undefined }; // environment for {{env.NAME}}
  vars: VarMap;    // merged user vars (route over config); these override built-ins
}

// A replacement provider resolves a single token to a string, or returns undefined to
// pass — letting the next provider (or the verbatim fallback) handle it.
export interface TemplateProvider {
  resolve(token: string, ctx: TemplateContext): string | undefined;
}

function pad2(n: number): string { return n < 10 ? '0' + n : '' + n; }

// The ONE provider registered this cycle: pure, deterministic built-ins. A future
// local-model ("ultrafast inference") provider would attach to DEFAULT_PROVIDERS behind
// this same {{...}} syntax — but enabling any non-deterministic provider requires a goal
// decision superseding decision #5 (no model calls). Do not register a second provider
// here without that decision.
export const deterministicProvider: TemplateProvider = {
  resolve(token, ctx) {
    switch (token) {
      case 'event': return ctx.event;
      case 'cwd':   return ctx.cwd;
      case 'home':  return ctx.home;
      case 'date':  return ctx.now.getFullYear() + '-' + pad2(ctx.now.getMonth() + 1) + '-' + pad2(ctx.now.getDate());
      case 'time':  return pad2(ctx.now.getHours()) + ':' + pad2(ctx.now.getMinutes());
    }
    if (token.indexOf('env.') === 0) {
      const v = ctx.env[token.slice(4)];
      return v === undefined ? '' : v;
    }
    return undefined;
  }
};

export const DEFAULT_PROVIDERS: TemplateProvider[] = [deterministicProvider];

// Token charset kept deliberately narrow (letters, digits, _, ., -) so stray "{{" in
// prose is left alone and there is no escaping to reason about this cycle.
const TOKEN_RE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

// Merge user vars with config-then-route precedence (route wins). Exposed for tests.
export function mergeVars(configVars?: VarMap, routeVars?: VarMap): VarMap {
  return Object.assign({}, configVars || {}, routeVars || {});
}

// Resolve one token: user vars first (they override built-ins, per decision #18), then
// each provider in order. Returns undefined when nothing resolves it.
function resolveToken(token: string, ctx: TemplateContext, providers: TemplateProvider[]): string | undefined {
  if (Object.prototype.hasOwnProperty.call(ctx.vars, token)) return ctx.vars[token];
  for (const p of providers) {
    const v = p.resolve(token, ctx);
    if (v !== undefined) return v;
  }
  return undefined;
}

// Replace every {{token}} in `body`. Unknown tokens are left byte-for-byte verbatim.
export function applyTemplate(body: string, ctx: TemplateContext, providers: TemplateProvider[] = DEFAULT_PROVIDERS): string {
  return body.replace(TOKEN_RE, (match, token) => {
    const v = resolveToken(token, ctx, providers);
    return v === undefined ? match : v;
  });
}

// Validate/sanitize a raw `vars` value into a VarMap of string→string entries only.
// Fail-open like route validation: a non-object yields {}; non-string values are
// dropped. `onIssue`, when given, collects human messages for doctor.
export function sanitizeVars(raw: any, where: string, onIssue?: (msg: string) => void): VarMap {
  const out: VarMap = {};
  if (raw === undefined) return out;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (onIssue) onIssue(where + ' "vars" must be an object of string values; ignoring it');
    return out;
  }
  for (const k of Object.keys(raw)) {
    const v = raw[k];
    if (typeof v === 'string') out[k] = v;
    else if (onIssue) onIssue(where + ' var "' + k + '" must be a string; skipped');
  }
  return out;
}

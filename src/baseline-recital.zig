// baseline-recital — native Zig port of scripts/baseline-recital.js (the oracle).
//
// Cross-platform (Linux + Windows) using ONLY the Zig standard library. One source
// compiles for x86_64-windows and x86_64-linux. Targets Zig 0.16.x (the std.Io interface).
//
// This mirrors the CURRENT routes-model dispatcher, NOT the retired single-doc recital:
//  - resolve the agent dir (BASELINE_AGENT_CONFIG_DIR, --agent-config, CLAUDE_CONFIG_DIR,
//    CODEX_HOME, else <home>/.claude) exactly as the oracle does;
//  - read all stdin, JSON.parse; require a truthy session_id and a supported
//    hook_event_name, else inject nothing;
//  - load + validate <agentDir>/cfg/baseline/config.json (version, route caps, per-route
//    id/event/phase/doc/freq/cwd/vars validation, dedup first-wins);
//  - select routes matching (event, cwd); bump each one's "<session>:<routeId>" counter in
//    <agentDir>/.baseline-counters.json (read/prune/increment/write, symlink-guarded);
//  - for each DUE route (count % freq == 0) read its doc (path-safe, byte/char capped),
//    apply {{name}} templating, and emit hookSpecificOutput.additionalContext with the due
//    docs joined in config routes[] order — byte-identical to the Node path;
//  - fail-open: every error path is a silent no-op that exits 0 and injects nothing.
//
// Parity notes (kept in sync with src/contracts.ts / src/baseline-recital.ts):
//  - {{name}} resolution order is user vars (route over config) then the deterministic
//    built-ins {{event}}/{{cwd}}/{{home}}/{{date}}/{{time}}/{{env.NAME}}; unknown tokens are
//    left byte-for-byte verbatim; the env.* family blanks (empty string) on a miss.
//  - JSON output escaping matches JSON.stringify for the additionalContext value.
//  - {{date}}/{{time}} resolve in UTC on BOTH runtimes (contract — the Node resolver was
//    switched to UTC to match this), so output is byte-identical regardless of local timezone.

const std = @import("std");
const builtin = @import("builtin");
const Io = std.Io;

const is_win = builtin.os.tag == .windows;

// ---- caps / constants (mirror src/contracts.ts + the dispatcher) -----------
const MAX_CONFIG_BYTES: usize = 64 * 1024;
const MAX_DOC_BYTES: usize = 64 * 1024;
const MAX_DOC_CHARS: usize = 10_000;
const MAX_ROUTES: usize = 64;
const MAX_STDIN_BYTES: usize = 1024 * 1024;
const MAX_COUNTER_BYTES: usize = 1024 * 1024;
const PRUNE_MS: i64 = 7 * 24 * 60 * 60 * 1000; // 604800000

// Counter mkdir-lock (mirrors the Node oracle): makeDir is atomic, so a mkdir race has
// exactly one winner; hold it across the read/prune/bump/write, then remove it. A lock
// older than STALE_LOCK_MS is broken (a crashed holder never wedges the counter forever).
const MAX_LOCK_WAIT_MS: i64 = 2000;
const LOCK_RETRY_MS: i64 = 10;
const STALE_LOCK_MS: i64 = 5000;

const SUPPORTED_EVENTS = [_][]const u8{ "UserPromptSubmit", "SessionStart", "PreToolUse", "PostToolUse" };
const SESSION_PHASES = [_][]const u8{ "startup", "resume", "clear", "compact" };

// Arena allocator for the whole run; freed implicitly at process exit.
var A: std.mem.Allocator = undefined;
// Command-line arguments (for the --agent-config flag). Set once in main.
var ARGS: std.process.Args = undefined;

// Entry point using 0.16 std.process.Init — a portable Io, allocators, and a populated
// environment map, with zero OS-specific code.
pub fn main(init: std.process.Init) void {
    A = init.arena.allocator();
    ARGS = init.minimal.args;
    run(init.io, init.environ_map) catch {}; // every error path is a silent no-op exit 0
}

fn run(io: Io, env: *std.process.Environ.Map) !void {
    // ---- read all of stdin (over the 1MiB cap -> inject nothing) ----
    const input = readAllStdin(io) catch return;

    // ---- JSON.parse; require a truthy session_id ----
    const parsed = std.json.parseFromSlice(std.json.Value, A, input, .{}) catch return;
    const root = switch (parsed.value) {
        .object => |obj| obj,
        else => return, // top-level non-object -> no session_id -> nothing
    };
    const sid = sessionId(root) orelse return;

    // ---- require a supported hook_event_name ----
    const event = stringField(root, "hook_event_name") orelse return;
    if (!isSupportedEvent(event)) return;
    const source = stringField(root, "source"); // optional (SessionStart phase)
    const data_cwd = stringField(root, "cwd"); // optional

    // ---- resolve the agent/config dirs exactly as the oracle does ----
    const agent_dir = agentDir(env) orelse return;
    const cfg_dir = try joinPath(agent_dir, try joinPath("cfg", "baseline"));
    const config_path = try joinPath(cfg_dir, "config.json");
    const counter_path = try joinPath(agent_dir, ".baseline-counters.json");

    // ---- load + validate config.json into the routes to act on (+ config vars) ----
    const cfg = loadValidConfig(io, config_path, cfg_dir);

    // ---- select the routes this invocation activates (event name + cwd) ----
    var selected: std.ArrayList(*const Route) = .empty;
    for (cfg.routes.items) |*r| {
        if (eventMatches(r.event, event, source) and cwdMatches(r.cwd, data_cwd)) {
            try selected.append(A, r);
        }
    }
    if (selected.items.len == 0) return;

    // ---- bump each selected route's per-route counter under the mkdir lock; collect the
    // ones now due. The lock guards ONLY the read/prune/bump/write (as in the oracle) and is
    // released before the doc reads. Fail-open: if the lock can't be acquired, inject nothing.
    const counter_lock_path = try std.fmt.allocPrint(A, "{s}.lock", .{counter_path});
    if (!acquireCounterLock(io, counter_lock_path)) return;
    var due: std.ArrayList(*const Route) = .empty;
    {
        const now = Io.Clock.real.now(io).toMilliseconds();
        var counters = readCounters(io, counter_path);
        pruneCounters(&counters, now);
        for (selected.items) |r| {
            const key = std.fmt.allocPrint(A, "{s}:{s}", .{ sid, r.id }) catch continue;
            const prev: i64 = blk: {
                if (counters.getPtr(key)) |e| {
                    if (e.has_count) break :blk e.count;
                }
                break :blk 0;
            };
            const count = prev + 1;
            counters.put(key, .{ .count = count, .ts = now, .has_count = true, .ts_is_num = true }) catch {};
            if (r.freq != 0 and @mod(count, r.freq) == 0) due.append(A, r) catch {};
        }
        writeCounters(io, counter_path, &counters) catch {};
    }
    releaseCounterLock(io, counter_lock_path);

    if (due.items.len == 0) return;

    // ---- read due docs, template, apply the combined-context cap, emit in config order ----
    // Fresh clock snapshot for templating (the oracle also reads the clock again here, after
    // the counter section, for {{date}}/{{time}}).
    const dt = utcDateTime(Io.Clock.real.now(io).toMilliseconds());
    var bodies: std.ArrayList([]const u8) = .empty;
    var sum_units: usize = 0; // running sum of UTF-16 lengths of pushed bodies
    for (due.items) |r| {
        const raw = readDoc(io, r.doc, cfg_dir) orelse continue;
        const merged = mergeVars(cfg.vars, r.vars);
        const body = applyTemplate(raw, merged, event, data_cwd orelse "", homedir(env) orelse "", dt, env) catch continue;
        const body_units = utf16Len(body);
        const count = bodies.items.len;
        // joined.length == count==0 ? body_units : sum_units + 2*count + body_units
        const joined_units = if (count == 0) body_units else sum_units + 2 * count + body_units;
        if (joined_units <= MAX_DOC_CHARS) {
            try bodies.append(A, body);
            sum_units += body_units;
        }
    }
    if (bodies.items.len == 0) return;

    var additional: std.ArrayList(u8) = .empty;
    for (bodies.items, 0..) |b, i| {
        if (i != 0) try additional.appendSlice(A, "\n\n");
        try additional.appendSlice(A, b);
    }

    // ---- build the outer JSON manually (exact key order + JSON.stringify escaping) ----
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(A, "{\"hookSpecificOutput\":{\"hookEventName\":\"");
    try jsonEscapeInto(&out, event);
    try out.appendSlice(A, "\",\"additionalContext\":\"");
    try jsonEscapeInto(&out, additional.items);
    try out.appendSlice(A, "\"}}");
    writeStdout(io, out.items);
}

// ---------------------------------------------------------------------------
// stdin / stdout (portable via std.Io.File + the Reader/Writer interface)
fn readAllStdin(io: Io) ![]u8 {
    var buf: [4096]u8 = undefined;
    var reader = std.Io.File.stdin().readerStreaming(io, &buf);
    return reader.interface.allocRemaining(A, .limited(MAX_STDIN_BYTES));
}

fn writeStdout(io: Io, bytes: []const u8) void {
    std.Io.File.stdout().writeStreamingAll(io, bytes) catch {};
}

// ---------------------------------------------------------------------------
// env / args / paths
fn envNonEmpty(env: *std.process.Environ.Map, key: []const u8) ?[]const u8 {
    if (env.get(key)) |v| {
        if (v.len > 0) return v;
    }
    return null;
}

// The value that followed `name` on the command line, mirroring the oracle's argValue
// (`--name value` or `--name=value`); an empty value resolves to null (like `|| null`).
// Returned slices are duped into the arena (the iterator reuses its own buffer).
fn argValue(name: []const u8) ?[]const u8 {
    var it = std.process.Args.Iterator.initAllocator(ARGS, A) catch return null;
    _ = it.skip(); // arg0 (the executable)
    const eqpfx = std.fmt.allocPrint(A, "{s}=", .{name}) catch return null;
    while (it.next()) |a| {
        if (std.mem.eql(u8, a, name)) {
            const nxt = it.next() orelse return null;
            return if (nxt.len > 0) (A.dupe(u8, nxt) catch null) else null;
        }
        if (std.mem.startsWith(u8, a, eqpfx)) {
            const v = a[eqpfx.len..];
            return if (v.len > 0) (A.dupe(u8, v) catch null) else null;
        }
    }
    return null;
}

fn homedir(env: *std.process.Environ.Map) ?[]const u8 {
    if (is_win) {
        if (envNonEmpty(env, "USERPROFILE")) |v| return v;
        if (env.get("HOMEDRIVE")) |drive| {
            if (env.get("HOMEPATH")) |hp| {
                if (drive.len > 0 and hp.len > 0) return std.fmt.allocPrint(A, "{s}{s}", .{ drive, hp }) catch null;
            }
        }
        if (envNonEmpty(env, "HOME")) |v| return v;
        return null;
    }
    if (envNonEmpty(env, "HOME")) |v| return v;
    if (envNonEmpty(env, "USERPROFILE")) |v| return v;
    return null;
}

// agentDir = BASELINE_AGENT_CONFIG_DIR || --agent-config || CLAUDE_CONFIG_DIR ||
//            CODEX_HOME || <home>/.claude  (oracle precedence, empty == absent)
fn agentDir(env: *std.process.Environ.Map) ?[]const u8 {
    if (envNonEmpty(env, "BASELINE_AGENT_CONFIG_DIR")) |v| return v;
    if (argValue("--agent-config")) |v| return v;
    if (envNonEmpty(env, "CLAUDE_CONFIG_DIR")) |v| return v;
    if (envNonEmpty(env, "CODEX_HOME")) |v| return v;
    const home = homedir(env) orelse return null;
    if (home.len == 0) return null;
    return joinPath(home, ".claude") catch null;
}

// path.join of two components: exactly one separator between them.
fn joinPath(a: []const u8, b: []const u8) ![]u8 {
    const sep = std.fs.path.sep;
    var list: std.ArrayList(u8) = .empty;
    try list.appendSlice(A, a);
    if (a.len > 0 and a[a.len - 1] != '\\' and a[a.len - 1] != '/') try list.append(A, sep);
    try list.appendSlice(A, b);
    return list.items;
}

fn toLowerAlloc(s: []const u8) []u8 {
    const out = A.alloc(u8, s.len) catch return @constCast(s);
    for (s, 0..) |c, i| out[i] = std.ascii.toLower(c);
    return out;
}

// ---------------------------------------------------------------------------
// JSON field extraction
fn stringField(obj: std.json.ObjectMap, key: []const u8) ?[]const u8 {
    const v = obj.get(key) orelse return null;
    return switch (v) {
        .string => |s| s,
        else => null,
    };
}

// session_id: the oracle rejects only FALSY values; any truthy value keys the counter and
// JS coerces it to a string. Mirror that for string/number/bool.
fn sessionId(obj: std.json.ObjectMap) ?[]const u8 {
    const v = obj.get("session_id") orelse return null;
    return switch (v) {
        .string => |s| if (s.len == 0) null else s,
        .integer => |n| if (n == 0) null else (std.fmt.allocPrint(A, "{d}", .{n}) catch null),
        .number_string => |s| if (s.len == 0) null else s,
        .float => |f| if (f == 0 or std.math.isNan(f)) null else (std.fmt.allocPrint(A, "{d}", .{f}) catch null),
        .bool => |b| if (b) "true" else null,
        else => null,
    };
}

fn isSupportedEvent(name: []const u8) bool {
    for (SUPPORTED_EVENTS) |e| {
        if (std.mem.eql(u8, e, name)) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// event / cwd selection (mirrors src/contracts.ts eventMatches / cwdMatches)
const ParsedEvent = struct { base: []const u8, phase: ?[]const u8 };

fn parseEvent(event: []const u8) ParsedEvent {
    const dot = std.mem.indexOfScalar(u8, event, '.') orelse return .{ .base = event, .phase = null };
    return .{ .base = event[0..dot], .phase = event[dot + 1 ..] };
}

fn eventMatches(route_event: []const u8, hook_event: []const u8, source: ?[]const u8) bool {
    const pe = parseEvent(route_event);
    if (!std.mem.eql(u8, pe.base, hook_event)) return false;
    const phase = pe.phase orelse return true;
    const src = source orelse return false;
    return std.mem.eql(u8, phase, src);
}

fn cwdMatches(route_cwd: ?[]const u8, session_cwd: ?[]const u8) bool {
    const rc = route_cwd orelse return true;
    const sc = session_cwd orelse return false;
    if (sc.len == 0) return false;
    var base = std.fs.path.resolve(A, &[_][]const u8{rc}) catch return false;
    var here = std.fs.path.resolve(A, &[_][]const u8{sc}) catch return false;
    if (is_win) {
        base = toLowerAlloc(base);
        here = toLowerAlloc(here);
    }
    if (std.mem.eql(u8, base, here)) return true;
    const sep = std.fs.path.sep;
    const prefix = if (base.len > 0 and base[base.len - 1] == sep)
        base
    else
        (std.fmt.allocPrint(A, "{s}{c}", .{ base, sep }) catch return false);
    return std.mem.startsWith(u8, here, prefix);
}

// ---------------------------------------------------------------------------
// config load + validation (mirrors loadValidConfig in the dispatcher)
const Route = struct {
    id: []const u8,
    event: []const u8,
    freq: i64,
    cwd: ?[]const u8,
    doc: []const u8,
    vars: std.StringHashMap([]const u8),
};

const ValidConfig = struct {
    routes: std.ArrayList(Route),
    vars: std.StringHashMap([]const u8),
};

fn emptyConfig() ValidConfig {
    return .{ .routes = .empty, .vars = std.StringHashMap([]const u8).init(A) };
}

// SLUG = /^[a-z0-9][a-z0-9-]*$/
fn isSlug(s: []const u8) bool {
    if (s.len == 0) return false;
    const first = s[0];
    if (!((first >= 'a' and first <= 'z') or (first >= '0' and first <= '9'))) return false;
    for (s[1..]) |c| {
        if (!((c >= 'a' and c <= 'z') or (c >= '0' and c <= '9') or c == '-')) return false;
    }
    return true;
}

// Sanitize a JSON `vars` value into a string->string map (non-object -> {}, non-string
// values dropped) — fail-open like the oracle's sanitizeVars.
fn sanitizeVars(v: ?std.json.Value) std.StringHashMap([]const u8) {
    var out = std.StringHashMap([]const u8).init(A);
    const val = v orelse return out;
    switch (val) {
        .object => |obj| {
            var it = obj.iterator();
            while (it.next()) |kv| {
                switch (kv.value_ptr.*) {
                    .string => |s| out.put(kv.key_ptr.*, s) catch {},
                    else => {},
                }
            }
        },
        else => {},
    }
    return out;
}

fn loadValidConfig(io: Io, config_path: []const u8, cfg_dir: []const u8) ValidConfig {
    const raw = std.Io.Dir.cwd().readFileAlloc(io, config_path, A, .limited(MAX_CONFIG_BYTES)) catch return emptyConfig();
    const parsed = std.json.parseFromSlice(std.json.Value, A, raw, .{}) catch return emptyConfig();
    const obj = switch (parsed.value) {
        .object => |o| o,
        else => return emptyConfig(),
    };

    // version: missing -> assume 1; anything other than 1 -> inject nothing.
    if (obj.get("version")) |ver| {
        const ok1 = switch (ver) {
            .integer => |n| n == 1,
            .float => |f| f == 1.0,
            else => false,
        };
        if (!ok1) return emptyConfig();
    }

    const config_vars = sanitizeVars(obj.get("vars"));

    const routes_val = obj.get("routes") orelse return .{ .routes = .empty, .vars = config_vars };
    const arr = switch (routes_val) {
        .array => |a| a,
        else => return .{ .routes = .empty, .vars = config_vars },
    };
    if (arr.items.len > MAX_ROUTES) return emptyConfig();

    var seen = std.StringHashMap(void).init(A);
    var out: std.ArrayList(Route) = .empty;
    for (arr.items) |rv| {
        const r = switch (rv) {
            .object => |o| o,
            else => continue,
        };
        const id = stringField(r, "id") orelse continue;
        if (!isSlug(id)) continue;
        if (seen.contains(id)) continue; // duplicate id — first wins
        const ev = stringField(r, "event") orelse continue;
        const pe = parseEvent(ev);
        if (!isSupportedEvent(pe.base)) continue;
        if (pe.phase) |phase| {
            if (!std.mem.eql(u8, pe.base, "SessionStart") or !isSessionPhase(phase)) continue;
        }
        const doc = stringField(r, "doc") orelse continue;
        if (safeDocPath(doc, cfg_dir) == null) continue;
        var freq: i64 = 1;
        if (r.get("freq")) |fv| {
            const parsed_freq: ?i64 = switch (fv) {
                .integer => |n| if (n >= 1) n else null,
                .float => |f| if (f >= 1 and @floor(f) == f) @as(i64, @intFromFloat(f)) else null,
                else => null,
            };
            freq = parsed_freq orelse continue; // freq present but invalid -> skip route
        }
        // cwd must be a string when present; otherwise skip the route.
        var cwd: ?[]const u8 = null;
        if (r.get("cwd")) |cv| {
            switch (cv) {
                .string => |s| cwd = s,
                .null => {}, // treated as absent
                else => continue,
            }
        }
        const vars = sanitizeVars(r.get("vars"));
        seen.put(id, {}) catch {};
        out.append(A, .{ .id = id, .event = ev, .freq = freq, .cwd = cwd, .doc = doc, .vars = vars }) catch {};
    }
    return .{ .routes = out, .vars = config_vars };
}

fn isSessionPhase(phase: []const u8) bool {
    for (SESSION_PHASES) |p| {
        if (std.mem.eql(u8, p, phase)) return true;
    }
    return false;
}

// Resolve a route's `doc` against cfg_dir; reject escapes (mirrors safeDocPath). The
// oracle's `rel === '' || rel.startsWith('..')` becomes a normalized path-boundary check:
// the resolved doc must live strictly under the resolved cfg_dir.
fn safeDocPath(doc: []const u8, cfg_dir: []const u8) ?[]const u8 {
    if (doc.len == 0) return null;
    if (std.fs.path.isAbsolute(doc)) return null;
    const base = std.fs.path.resolve(A, &[_][]const u8{cfg_dir}) catch return null;
    const resolved = std.fs.path.resolve(A, &[_][]const u8{ cfg_dir, doc }) catch return null;
    if (std.mem.eql(u8, resolved, base)) return null; // rel === ''
    const sep = std.fs.path.sep;
    const prefix = if (base.len > 0 and base[base.len - 1] == sep)
        base
    else
        (std.fmt.allocPrint(A, "{s}{c}", .{ base, sep }) catch return null);
    if (!std.mem.startsWith(u8, resolved, prefix)) return null; // escapes cfg_dir
    return resolved;
}

// ---------------------------------------------------------------------------
// counters: ordered map preserving insertion order (matches JSON.stringify order).
const Entry = struct { count: i64, ts: i64, has_count: bool, ts_is_num: bool };

const Counters = struct {
    keys: std.ArrayList([]const u8),
    map: std.StringHashMap(Entry),

    fn init() Counters {
        return .{ .keys = .empty, .map = std.StringHashMap(Entry).init(A) };
    }
    fn getPtr(self: *Counters, k: []const u8) ?*Entry {
        return self.map.getPtr(k);
    }
    fn put(self: *Counters, k: []const u8, v: Entry) !void {
        const gop = try self.map.getOrPut(k);
        if (!gop.found_existing) {
            const kd = try A.dupe(u8, k);
            gop.key_ptr.* = kd;
            try self.keys.append(A, kd);
        }
        gop.value_ptr.* = v;
    }
    fn remove(self: *Counters, k: []const u8) void {
        _ = self.map.remove(k);
        var w: usize = 0;
        for (self.keys.items) |kk| {
            if (!std.mem.eql(u8, kk, k)) {
                self.keys.items[w] = kk;
                w += 1;
            }
        }
        self.keys.shrinkRetainingCapacity(w);
    }
};

// lstat-style symlink check (no symlink following). True only if the path is a symlink.
fn isSymlink(io: Io, path: []const u8) bool {
    const st = std.Io.Dir.cwd().statFile(io, path, .{ .follow_symlinks = false }) catch return false;
    return st.kind == .sym_link;
}

// Acquire the counter mkdir-lock, mirroring the oracle: spin (bounded by MAX_LOCK_WAIT_MS,
// LOCK_RETRY_MS between tries) on createDir; makeDir is atomic so exactly one racer wins.
// A PathAlreadyExists whose dir is older than STALE_LOCK_MS is broken and retried; any other
// createDir error gives up. Returns false when the lock can't be taken (caller injects nothing).
fn acquireCounterLock(io: Io, lock_path: []const u8) bool {
    const start = Io.Clock.real.now(io).toMilliseconds();
    while ((Io.Clock.real.now(io).toMilliseconds() - start) <= MAX_LOCK_WAIT_MS) {
        if (std.Io.Dir.cwd().createDir(io, lock_path, .default_dir)) |_| {
            return true;
        } else |err| {
            if (err != error.PathAlreadyExists) return false;
            if (std.Io.Dir.cwd().statFile(io, lock_path, .{ .follow_symlinks = false })) |st| {
                const age = Io.Clock.real.now(io).toMilliseconds() - st.mtime.toMilliseconds();
                if (age > STALE_LOCK_MS) std.Io.Dir.cwd().deleteDir(io, lock_path) catch {};
            } else |_| {}
            io.sleep(Io.Duration.fromMilliseconds(LOCK_RETRY_MS), .real) catch {};
        }
    }
    return false;
}

fn releaseCounterLock(io: Io, lock_path: []const u8) void {
    std.Io.Dir.cwd().deleteDir(io, lock_path) catch {};
}

fn readCounters(io: Io, path: []const u8) Counters {
    var c = Counters.init();
    if (isSymlink(io, path)) return c; // refuse to read through a planted symlink
    const raw = std.Io.Dir.cwd().readFileAlloc(io, path, A, .limited(MAX_COUNTER_BYTES)) catch return c;
    const parsed = std.json.parseFromSlice(std.json.Value, A, raw, .{}) catch return c;
    switch (parsed.value) {
        .object => |obj| {
            var it = obj.iterator();
            while (it.next()) |kv| {
                var e = Entry{ .count = 0, .ts = 0, .has_count = false, .ts_is_num = false };
                switch (kv.value_ptr.*) {
                    .object => |inner| {
                        if (inner.get("count")) |cv| switch (cv) {
                            .integer => |n| {
                                e.count = n;
                                e.has_count = true;
                            },
                            .float => |f| {
                                e.count = @intFromFloat(f);
                                e.has_count = true;
                            },
                            else => {},
                        };
                        if (inner.get("ts")) |tv| switch (tv) {
                            .integer => |n| {
                                e.ts = n;
                                e.ts_is_num = true;
                            },
                            .float => |f| {
                                e.ts = @intFromFloat(f);
                                e.ts_is_num = true;
                            },
                            else => {},
                        };
                        c.put(kv.key_ptr.*, e) catch {};
                    },
                    // non-object entry: kept, but ts is non-numeric so prune drops it.
                    else => c.put(kv.key_ptr.*, e) catch {},
                }
            }
        },
        else => return c, // not an object -> {}
    }
    return c;
}

fn pruneCounters(c: *Counters, now: i64) void {
    var drop: std.ArrayList([]const u8) = .empty;
    for (c.keys.items) |k| {
        const e = c.map.get(k) orelse continue;
        if (!e.ts_is_num or (now - e.ts) > PRUNE_MS) drop.append(A, k) catch {};
    }
    for (drop.items) |k| c.remove(k);
}

fn writeCounters(io: Io, path: []const u8, c: *Counters) !void {
    if (isSymlink(io, path)) return; // never write through a symlink

    var out: std.ArrayList(u8) = .empty;
    try out.append(A, '{');
    var first = true;
    for (c.keys.items) |k| {
        const e = c.map.get(k) orelse continue;
        if (!first) try out.append(A, ',');
        first = false;
        try out.append(A, '"');
        try jsonEscapeInto(&out, k);
        try out.appendSlice(A, "\":{\"count\":");
        try fmtInt(&out, e.count);
        try out.appendSlice(A, ",\"ts\":");
        try fmtInt(&out, e.ts);
        try out.append(A, '}');
    }
    try out.append(A, '}');

    const tmp_path = try std.fmt.allocPrint(A, "{s}.tmp", .{path});
    {
        var file = std.Io.Dir.cwd().createFile(io, tmp_path, .{}) catch return;
        defer file.close(io);
        file.writeStreamingAll(io, out.items) catch return;
    }
    std.Io.Dir.renameAbsolute(tmp_path, path, io) catch {};
}

fn fmtInt(out: *std.ArrayList(u8), v: i64) !void {
    var buf: [24]u8 = undefined;
    const s = std.fmt.bufPrint(&buf, "{d}", .{v}) catch return;
    try out.appendSlice(A, s);
}

// ---------------------------------------------------------------------------
// doc read (path-safe, byte + char capped). Returns the verbatim body or null to skip.
fn readDoc(io: Io, doc: []const u8, cfg_dir: []const u8) ?[]const u8 {
    const p = safeDocPath(doc, cfg_dir) orelse return null;
    // Never follow a doc symlink out of the config folder (the realpath-containment guard's
    // native form): a symlinked doc file is skipped rather than read through.
    if (isSymlink(io, p)) return null;
    const body = std.Io.Dir.cwd().readFileAlloc(io, p, A, .limited(MAX_DOC_BYTES)) catch return null;
    if (utf16Len(body) > MAX_DOC_CHARS) return null;
    return body;
}

// ---------------------------------------------------------------------------
// {{name}} templating (mirrors applyTemplate / resolveToken in src/contracts.ts)
fn mergeVars(config_vars: std.StringHashMap([]const u8), route_vars: std.StringHashMap([]const u8)) std.StringHashMap([]const u8) {
    var out = std.StringHashMap([]const u8).init(A);
    var ci = config_vars.iterator();
    while (ci.next()) |kv| out.put(kv.key_ptr.*, kv.value_ptr.*) catch {};
    var ri = route_vars.iterator();
    while (ri.next()) |kv| out.put(kv.key_ptr.*, kv.value_ptr.*) catch {}; // route wins
    return out;
}

const DateTime = struct { date: []const u8, time: []const u8 };

fn isTmplSpace(c: u8) bool {
    return c == ' ' or c == '\t' or c == '\n' or c == '\r' or c == 0x0b or c == 0x0c;
}
fn isTokenChar(c: u8) bool {
    return (c >= 'A' and c <= 'Z') or (c >= 'a' and c <= 'z') or (c >= '0' and c <= '9') or c == '_' or c == '.' or c == '-';
}

// Resolve one token: user vars first (they override built-ins), then the deterministic
// provider. Returns null when nothing resolves it (leave verbatim).
fn resolveToken(token: []const u8, vars: std.StringHashMap([]const u8), event: []const u8, cwd: []const u8, home: []const u8, dt: DateTime, env: *std.process.Environ.Map) ?[]const u8 {
    if (vars.get(token)) |v| return v;
    if (std.mem.eql(u8, token, "event")) return event;
    if (std.mem.eql(u8, token, "cwd")) return cwd;
    if (std.mem.eql(u8, token, "home")) return home;
    if (std.mem.eql(u8, token, "date")) return dt.date;
    if (std.mem.eql(u8, token, "time")) return dt.time;
    if (std.mem.startsWith(u8, token, "env.")) {
        const name = token[4..];
        return env.get(name) orelse "";
    }
    return null;
}

fn applyTemplate(body: []const u8, vars: std.StringHashMap([]const u8), event: []const u8, cwd: []const u8, home: []const u8, dt: DateTime, env: *std.process.Environ.Map) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    var i: usize = 0;
    while (i < body.len) {
        if (body[i] == '{' and i + 1 < body.len and body[i + 1] == '{') {
            var j = i + 2;
            while (j < body.len and isTmplSpace(body[j])) j += 1;
            const tstart = j;
            while (j < body.len and isTokenChar(body[j])) j += 1;
            const tend = j;
            while (j < body.len and isTmplSpace(body[j])) j += 1;
            if (tend > tstart and j + 1 < body.len and body[j] == '}' and body[j + 1] == '}') {
                const token = body[tstart..tend];
                if (resolveToken(token, vars, event, cwd, home, dt, env)) |v| {
                    try out.appendSlice(A, v);
                } else {
                    try out.appendSlice(A, body[i .. j + 2]); // unknown -> verbatim match
                }
                i = j + 2;
                continue;
            }
        }
        try out.append(A, body[i]);
        i += 1;
    }
    return out.items;
}

// UTF-16 code-unit length of a UTF-8 string (matches JS String.prototype.length).
fn utf16Len(s: []const u8) usize {
    var n: usize = 0;
    var i: usize = 0;
    while (i < s.len) {
        const len = std.unicode.utf8ByteSequenceLength(s[i]) catch {
            i += 1;
            n += 1;
            continue;
        };
        if (i + len > s.len) {
            i += 1;
            n += 1;
            continue;
        }
        const cp = std.unicode.utf8Decode(s[i .. i + len]) catch {
            i += 1;
            n += 1;
            continue;
        };
        n += if (cp > 0xFFFF) @as(usize, 2) else 1;
        i += len;
    }
    return n;
}

// UTC calendar date/time from Unix ms — the {{date}}/{{time}} contract is UTC on both
// runtimes (the Node resolver matches this).
fn utcDateTime(now_ms: i64) DateTime {
    const secs = @divFloor(now_ms, 1000);
    const days = @divFloor(secs, 86400);
    const tod = @mod(secs, 86400); // 0..86399 (@mod is non-negative for positive modulus)
    const hour = @divFloor(tod, 3600);
    const minute = @divFloor(@mod(tod, 3600), 60);

    // Howard Hinnant's days->civil algorithm.
    const z = days + 719468;
    const era = @divFloor(if (z >= 0) z else z - 146096, 146097);
    const doe = z - era * 146097; // [0, 146096]
    const yoe = @divFloor(doe - @divFloor(doe, 1460) + @divFloor(doe, 36524) - @divFloor(doe, 146096), 365);
    const y0 = yoe + era * 400;
    const doy = doe - (365 * yoe + @divFloor(yoe, 4) - @divFloor(yoe, 100));
    const mp = @divFloor(5 * doy + 2, 153); // [0, 11]
    const d = doy - @divFloor(153 * mp + 2, 5) + 1; // [1, 31]
    const m = if (mp < 10) mp + 3 else mp - 9; // [1, 12]
    const y = y0 + (if (m <= 2) @as(i64, 1) else 0);

    var date_buf: std.ArrayList(u8) = .empty;
    fmtInt(&date_buf, y) catch {};
    date_buf.append(A, '-') catch {};
    appendPad2(&date_buf, m) catch {};
    date_buf.append(A, '-') catch {};
    appendPad2(&date_buf, d) catch {};

    var time_buf: std.ArrayList(u8) = .empty;
    appendPad2(&time_buf, hour) catch {};
    time_buf.append(A, ':') catch {};
    appendPad2(&time_buf, minute) catch {};

    return .{ .date = date_buf.items, .time = time_buf.items };
}

fn appendPad2(out: *std.ArrayList(u8), v: i64) !void {
    if (v >= 0 and v < 10) try out.append(A, '0');
    try fmtInt(out, v);
}

// ---------------------------------------------------------------------------
// JSON.stringify string escaping for the emitted string values.
fn jsonEscapeInto(out: *std.ArrayList(u8), s: []const u8) !void {
    for (s) |c| {
        switch (c) {
            '"' => try out.appendSlice(A, "\\\""),
            '\\' => try out.appendSlice(A, "\\\\"),
            '\n' => try out.appendSlice(A, "\\n"),
            '\r' => try out.appendSlice(A, "\\r"),
            '\t' => try out.appendSlice(A, "\\t"),
            0x08 => try out.appendSlice(A, "\\b"),
            0x0c => try out.appendSlice(A, "\\f"),
            else => {
                if (c < 0x20) {
                    const hex = "0123456789abcdef";
                    var buf: [6]u8 = .{ '\\', 'u', '0', '0', hex[(c >> 4) & 0xf], hex[c & 0xf] };
                    try out.appendSlice(A, &buf);
                } else {
                    try out.append(A, c);
                }
            },
        }
    }
}

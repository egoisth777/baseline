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
//    id/event/phase/doc/freq/cwd validation, dedup first-wins);
//  - select routes matching (event, cwd); bump each one's "<session>:<routeId>" counter in
//    <agentDir>/.baseline-counters.json (read/prune/increment/write, symlink-guarded);
//  - for each DUE route (count % freq == 0) read its doc (path-safe, byte/char capped)
//    and emit it verbatim in hookSpecificOutput.additionalContext, with due docs joined
//    in config routes[] order — byte-identical to the Node path;
//  - fail-open: every error path is a silent no-op that exits 0 and injects nothing.
//
// Parity notes (kept in sync with src/contracts.ts / src/baseline-recital.ts):
//  - docs are static trusted text and are emitted byte-for-byte, including any `{{...}}`
//    sequences they contain;
//  - JSON output escaping matches JSON.stringify for the additionalContext value.

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

    // ---- load + validate config.json into the routes to act on ----
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

    // ---- read due docs CONCURRENTLY, then apply the combined-context cap and emit in config
    // routes[] order ---- The reads run on the Io's worker threads (R-011, mirroring the Node
    // Promise.all); output order is deterministic regardless of which read finishes first.
    const raws = readDueDocsConcurrent(io, due.items, cfg_dir);

    var bodies: std.ArrayList([]const u8) = .empty;
    var sum_units: usize = 0; // running sum of UTF-16 lengths of pushed bodies
    for (due.items, 0..) |_, i| {
        if (i >= raws.len) break;
        const body = raws[i] orelse continue;
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
};

const ValidConfig = struct {
    routes: std.ArrayList(Route),
};

fn emptyConfig() ValidConfig {
    return .{ .routes = .empty };
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

    const routes_val = obj.get("routes") orelse return emptyConfig();
    const arr = switch (routes_val) {
        .array => |a| a,
        else => return emptyConfig(),
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
                else => continue,
            }
        }
        seen.put(id, {}) catch {};
        out.append(A, .{ .id = id, .event = ev, .freq = freq, .cwd = cwd, .doc = doc }) catch {};
    }
    return .{ .routes = out };
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
// doc read (path-safe, byte + char capped). One worker per due doc, run concurrently on the
// Io's worker threads. Reads use the THREAD-SAFE page allocator so the workers never touch the
// run's (non-threadsafe) arena; the verbatim body is stored in `slot` or left null to skip.
fn readDocWorker(io: Io, path: []const u8, slot: *?[]const u8) void {
    const body = std.Io.Dir.cwd().readFileAlloc(io, path, std.heap.page_allocator, .limited(MAX_DOC_BYTES)) catch return;
    if (utf16Len(body) > MAX_DOC_CHARS) return;
    slot.* = body;
}

// Read every due route's doc CONCURRENTLY (mirrors the Node Promise.all), returning the
// verbatim bodies indexed by due[] position (null = missing/oversize/skipped). Path-safety
// (lexical containment + no symlink escape) is validated on THIS thread first; the reads then
// run via Io.Group.concurrent on the Io's worker pool. If a task can't be spawned concurrently
// (concurrency limit), it falls back to an inline read — output is identical either way.
fn readDueDocsConcurrent(io: Io, due: []const *const Route, cfg_dir: []const u8) []?[]const u8 {
    const n = due.len;
    const raws = A.alloc(?[]const u8, n) catch return &[_]?[]const u8{};
    @memset(raws, null);
    const paths = A.alloc(?[]const u8, n) catch return raws;
    for (due, 0..) |r, i| {
        const p = safeDocPath(r.doc, cfg_dir);
        // Never follow a doc symlink out of the config folder (native realpath-guard form).
        paths[i] = if (p) |pp| (if (isSymlink(io, pp)) null else pp) else null;
    }
    var group: Io.Group = .init;
    for (paths, 0..) |mp, i| {
        const p = mp orelse continue;
        group.concurrent(io, readDocWorker, .{ io, p, &raws[i] }) catch readDocWorker(io, p, &raws[i]);
    }
    group.await(io) catch {};
    return raws;
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

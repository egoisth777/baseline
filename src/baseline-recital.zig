// baseline-recital — portable Zig port of scripts/baseline-recital.js
// Cross-platform (Linux + Windows) using ONLY the Zig standard library — no
// Win32 / OS-specific APIs. One source compiles for x86_64-windows and
// x86_64-linux. Targets Zig 0.16.x (the std.Io interface).
//
// Behavior mirrors the JS oracle exactly:
//  - read CLAUDE_CONFIG_DIR or <HOME>/.claude (HOME, else USERPROFILE)
//  - read all stdin, JSON.parse, take .session_id (truthy) else exit 0
//  - load+parse baseline.md (frontmatter interval/prefix, body rules)
//  - read/prune/increment/write compact counters json (.baseline-counters.json)
//  - if count % interval == 0 -> emit firing JSON to stdout (no trailing newline)
//  - every path exits 0; all errors swallowed silently.

const std = @import("std");
const builtin = @import("builtin");
const Io = std.Io;

// ---- constants matching the JS defaults ------------------------------------
const DEFAULT_N: i64 = 5;
const DEFAULT_PREFIX = "LI BASELINE ALIGNED:";
const FALLBACK_RULE = "File read/write/search -> subagent (cavecrew-investigator/builder, Explore), not inline. Save main ctx.";
const PRUNE_MS: i64 = 7 * 24 * 60 * 60 * 1000; // 604800000
const MAX_STDIN_BYTES: usize = 1024 * 1024;
const MAX_BASELINE_BYTES: usize = 64 * 1024;
const MAX_COUNTER_BYTES: usize = 1024 * 1024;
const MAX_RULES: usize = 50;
const MAX_RULE_CHARS: usize = 500;

// Arena allocator for the whole run; freed implicitly at process exit.
var A: std.mem.Allocator = undefined;

// Entry point using the 0.16 std.process.Init — gives us a portable Io,
// allocators, and a populated environment map, with zero OS-specific code.
pub fn main(init: std.process.Init) void {
    A = init.arena.allocator();
    run(init.io, init.environ_map) catch {}; // every error path is a silent no-op exit 0
}

fn run(io: Io, env: *std.process.Environ.Map) !void {
    // ---- read all of stdin ----
    const input = readAllStdin(io) catch return;

    // ---- JSON.parse + take .session_id (truthy) ----
    const sid = parseSessionId(input) orelse return; // missing/empty/invalid -> nothing
    if (sid.len == 0) return;

    // ---- config dir ----
    const cfg = configDir(env) orelse return;
    const baseline_path = try joinPath(cfg, "baseline.md");
    const counter_path = try joinPath(cfg, ".baseline-counters.json");

    // ---- load baseline ----
    const bl = loadBaseline(io, baseline_path);

    // Unix ms epoch via the portable Io wall clock. (std.time.milliTimestamp
    // was removed in Zig 0.16; the real clock translates the Windows 1601
    // epoch to Unix time for us.)
    const now = Io.Clock.real.now(io).toMilliseconds();

    // ---- read counters ----
    var counters = readCounters(io, counter_path);

    // ---- prune ----
    pruneCounters(&counters, now);

    // ---- update ----
    const prev: i64 = blk: {
        if (counters.getPtr(sid)) |e| {
            if (e.has_count) break :blk e.count;
        }
        break :blk 0;
    };
    const count = prev + 1;
    try counters.put(sid, .{ .count = count, .ts = now, .has_count = true, .ts_is_num = true });

    // ---- write (before firing check) ----
    writeCounters(io, counter_path, &counters) catch {};

    // ---- firing check ----
    if (bl.interval == 0) return; // guard (interval always >0 in practice)
    if (@mod(count, bl.interval) != 0) return;

    // ---- build firing text ----
    const text = try buildText(count, bl.prefix, bl.rules.items);

    // ---- build outer JSON manually (exact key order) ----
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(A, "{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"");
    try jsonEscapeInto(&out, text);
    try out.appendSlice(A, "\"}}");

    writeStdout(io, out.items);
}

// ---------------------------------------------------------------------------
// stdin / stdout (portable via std.Io.File + the Reader/Writer interface)
fn readAllStdin(io: Io) ![]u8 {
    var buf: [4096]u8 = undefined;
    var reader = std.Io.File.stdin().readerStreaming(io, &buf);
    // allocRemaining reads to EOF and returns a caller-owned slice.
    return reader.interface.allocRemaining(A, .limited(MAX_STDIN_BYTES));
}

fn writeStdout(io: Io, bytes: []const u8) void {
    std.Io.File.stdout().writeStreamingAll(io, bytes) catch {};
}

// ---------------------------------------------------------------------------
// env / paths
fn configDir(env: *std.process.Environ.Map) ?[]const u8 {
    // CLAUDE_CONFIG_DIR if set AND non-empty (JS: `|| ...`)
    if (env.get("CLAUDE_CONFIG_DIR")) |v| {
        if (v.len > 0) return v;
    }
    const home = (if (builtin.os.tag == .windows) windowsHome(env) else posixHome(env)) orelse return null;
    if (home.len == 0) return null;
    return joinPath(home, ".claude") catch null;
}

fn posixHome(env: *std.process.Environ.Map) ?[]const u8 {
    if (env.get("HOME")) |v| {
        if (v.len > 0) return v;
    }
    if (env.get("USERPROFILE")) |v| {
        if (v.len > 0) return v;
    }
    return null;
}

fn windowsHome(env: *std.process.Environ.Map) ?[]const u8 {
    if (env.get("USERPROFILE")) |v| {
        if (v.len > 0) return v;
    }
    if (env.get("HOMEDRIVE")) |drive| {
        if (env.get("HOMEPATH")) |home_path| {
            if (drive.len > 0 and home_path.len > 0) {
                return std.fmt.allocPrint(A, "{s}{s}", .{ drive, home_path }) catch null;
            }
        }
    }
    if (env.get("HOME")) |v| {
        if (v.len > 0) return v;
    }
    return null;
}

fn joinPath(a: []const u8, b: []const u8) ![]u8 {
    // path.join semantics: single separator between the two components.
    const sep = std.fs.path.sep; // '\\' on Windows, '/' elsewhere
    var list: std.ArrayList(u8) = .empty;
    try list.appendSlice(A, a);
    if (a.len > 0 and a[a.len - 1] != '\\' and a[a.len - 1] != '/') {
        try list.append(A, sep);
    }
    try list.appendSlice(A, b);
    return list.items;
}

// ---------------------------------------------------------------------------
// file read helper. Returns null on any failure. Uses absolute paths.
fn readFileAll(io: Io, path: []const u8) ?[]u8 {
    return std.Io.Dir.cwd().readFileAlloc(io, path, A, .limited(MAX_COUNTER_BYTES)) catch null;
}

fn readBaselineFile(io: Io, path: []const u8) ?[]u8 {
    return std.Io.Dir.cwd().readFileAlloc(io, path, A, .limited(MAX_BASELINE_BYTES)) catch null;
}

// lstat-style symlink check (no symlink following). Returns true only if the
// path exists AND is a symbolic link. Any error -> false (treat as not a link).
fn isSymlink(io: Io, path: []const u8) bool {
    const st = std.Io.Dir.cwd().statFile(io, path, .{ .follow_symlinks = false }) catch return false;
    return st.kind == .sym_link;
}

// ---------------------------------------------------------------------------
// session_id extraction. The JS oracle reads `data.session_id` raw and only
// rejects FALSY values (`if (!sessionId) return`). Any TRUTHY value is used as
// the counter key, which JS coerces to a string. We mirror that: accept
// string/number/bool truthy and return the JS string form.
fn parseSessionId(input: []const u8) ?[]const u8 {
    const parsed = std.json.parseFromSlice(std.json.Value, A, input, .{}) catch return null;
    switch (parsed.value) {
        .object => |obj| {
            const v = obj.get("session_id") orelse return null; // missing -> undefined (falsy)
            switch (v) {
                .string => |s| return if (s.len == 0) null else s, // "" is falsy
                .integer => |n| {
                    if (n == 0) return null; // 0 is falsy
                    return std.fmt.allocPrint(A, "{d}", .{n}) catch null;
                },
                .number_string => |s| {
                    // big number that didn't fit i64; JS treats as truthy number.
                    if (s.len == 0) return null;
                    return s;
                },
                .float => |f| {
                    if (f == 0 or std.math.isNan(f)) return null; // 0/NaN falsy
                    return std.fmt.allocPrint(A, "{d}", .{f}) catch null;
                },
                .bool => |b| return if (b) "true" else null, // false is falsy
                .null => return null, // null is falsy
                // array/object are truthy in JS but no real session_id is a
                // collection; out of contract scope.
                else => return null,
            }
        },
        else => return null, // top-level non-object -> .session_id undefined -> nothing
    }
}

// ---------------------------------------------------------------------------
// baseline parsing
const Baseline = struct {
    interval: i64,
    prefix: []const u8,
    rules: std.ArrayList([]const u8),
};

fn loadBaseline(io: Io, path: []const u8) Baseline {
    var bl = Baseline{
        .interval = DEFAULT_N,
        .prefix = DEFAULT_PREFIX,
        .rules = .empty,
    };

    const raw = readBaselineFile(io, path) orelse {
        bl.rules.append(A, FALLBACK_RULE) catch {};
        return bl;
    };

    var body: []const u8 = raw;

    // Frontmatter regex: /^﻿?\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/
    if (matchFrontmatter(raw)) |fm| {
        body = fm.body;
        var it = std.mem.splitScalar(u8, fm.front, '\n');
        while (it.next()) |line_raw| {
            // JS split(/\r?\n/): trailing \r handled by trims below.
            const line = stripTrailingCR(line_raw);
            const colon = std.mem.indexOfScalar(u8, line, ':') orelse continue;
            const key = jsTrimLower(line[0..colon]);
            const val = jsTrim(line[colon + 1 ..]);
            if (std.mem.eql(u8, key, "interval")) {
                if (parseIntLeading(val)) |n| {
                    if (n > 0) bl.interval = n;
                }
            } else if (std.mem.eql(u8, key, "prefix")) {
                const p = stripQuotes(val);
                bl.prefix = if (p.len == 0) DEFAULT_PREFIX else p;
            }
        }
    }

    // rules from body
    var lit = std.mem.splitScalar(u8, body, '\n');
    while (lit.next()) |line_raw| {
        if (bl.rules.items.len >= MAX_RULES) break;
        const line = jsTrim(line_raw); // trims spaces/tabs/\r/\n
        if (line.len == 0) continue;
        if (line[0] == '#') continue;
        bl.rules.append(A, if (line.len > MAX_RULE_CHARS) line[0..MAX_RULE_CHARS] else line) catch {};
    }
    if (bl.rules.items.len == 0) {
        bl.rules.append(A, FALLBACK_RULE) catch {};
    }
    return bl;
}

const FmMatch = struct { front: []const u8, body: []const u8 };

// Emulate /^﻿?\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/
fn matchFrontmatter(raw: []const u8) ?FmMatch {
    var i: usize = 0;
    // optional BOM ﻿ = U+FEFF -> UTF-8 EF BB BF
    if (raw.len >= 3 and raw[0] == 0xEF and raw[1] == 0xBB and raw[2] == 0xBF) i = 3;
    // \s* (ASCII whitespace)
    while (i < raw.len and isJsSpace(raw[i])) i += 1;
    // ---
    if (i + 3 > raw.len or raw[i] != '-' or raw[i + 1] != '-' or raw[i + 2] != '-') return null;
    i += 3;
    // \r?\n
    if (i < raw.len and raw[i] == '\r') i += 1;
    if (i >= raw.len or raw[i] != '\n') return null;
    i += 1;
    const front_start = i;
    // Non-greedy [\s\S]*? then \r?\n---: scan for the first "\n---" and verify
    // the --- closes with \r?\n? then capture the rest as the body.
    var j = front_start;
    while (j < raw.len) : (j += 1) {
        if (raw[j] == '\n') {
            var k = j + 1;
            if (k + 3 <= raw.len and raw[k] == '-' and raw[k + 1] == '-' and raw[k + 2] == '-') {
                // front capture ends at line start (drop optional preceding \r)
                var front_end = j;
                if (front_end > front_start and raw[front_end - 1] == '\r') front_end -= 1;
                k += 3;
                // \r?\n?
                if (k < raw.len and raw[k] == '\r') k += 1;
                if (k < raw.len and raw[k] == '\n') k += 1;
                const body = raw[k..];
                return FmMatch{ .front = raw[front_start..front_end], .body = body };
            }
        }
    }
    return null;
}

fn isJsSpace(c: u8) bool {
    return c == ' ' or c == '\t' or c == '\r' or c == '\n' or c == 0x0c or c == 0x0b;
}

fn stripTrailingCR(s: []const u8) []const u8 {
    if (s.len > 0 and s[s.len - 1] == '\r') return s[0 .. s.len - 1];
    return s;
}

// JS String.prototype.trim: strips space tab \n \r \v \f (+ others). We cover
// the ASCII whitespace set relevant to our inputs.
fn jsTrim(s: []const u8) []const u8 {
    var start: usize = 0;
    var end: usize = s.len;
    while (start < end and isJsTrimWs(s[start])) start += 1;
    while (end > start and isJsTrimWs(s[end - 1])) end -= 1;
    return s[start..end];
}

fn isJsTrimWs(c: u8) bool {
    return c == ' ' or c == '\t' or c == '\n' or c == '\r' or c == 0x0b or c == 0x0c;
}

fn jsTrimLower(s: []const u8) []const u8 {
    const t = jsTrim(s);
    // toLowerCase ASCII
    const out = A.alloc(u8, t.len) catch return t;
    for (t, 0..) |c, idx| {
        out[idx] = if (c >= 'A' and c <= 'Z') c + 32 else c;
    }
    return out;
}

// JS parseInt(val,10): optional leading ws, optional sign, then digits; stop at
// junk. Returns null (NaN) when no digits are present.
fn parseIntLeading(s: []const u8) ?i64 {
    var i: usize = 0;
    while (i < s.len and isJsTrimWs(s[i])) i += 1;
    var neg = false;
    if (i < s.len and (s[i] == '+' or s[i] == '-')) {
        neg = s[i] == '-';
        i += 1;
    }
    const digit_start = i;
    var val: i64 = 0;
    while (i < s.len and s[i] >= '0' and s[i] <= '9') : (i += 1) {
        val = val * 10 + @as(i64, s[i] - '0');
    }
    if (i == digit_start) return null; // no digits -> NaN
    return if (neg) -val else val;
}

// Strip ONE leading quote and ONE trailing quote independently (/^["']|["']$/g)
fn stripQuotes(s: []const u8) []const u8 {
    var r = s;
    if (r.len > 0 and (r[0] == '"' or r[0] == '\'')) r = r[1..];
    if (r.len > 0 and (r[r.len - 1] == '"' or r[r.len - 1] == '\'')) r = r[0 .. r.len - 1];
    return r;
}

// ---------------------------------------------------------------------------
// counters: ordered map preserving insertion order.
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
            // dupe key into arena so it outlives any source buffer
            const kd = try A.dupe(u8, k);
            gop.key_ptr.* = kd;
            try self.keys.append(A, kd);
        }
        gop.value_ptr.* = v;
    }
    fn remove(self: *Counters, k: []const u8) void {
        _ = self.map.remove(k);
        // remove from keys list (preserve order)
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

fn readCounters(io: Io, path: []const u8) Counters {
    var c = Counters.init();
    // lstat: if symlink -> empty {}
    if (isSymlink(io, path)) return c;
    const raw = readFileAll(io, path) orelse return c;
    const parsed = std.json.parseFromSlice(std.json.Value, A, raw, .{}) catch return c;
    switch (parsed.value) {
        .object => |obj| {
            var it = obj.iterator();
            while (it.next()) |kv| {
                const key = kv.key_ptr.*;
                var e = Entry{ .count = 0, .ts = 0, .has_count = false, .ts_is_num = false };
                switch (kv.value_ptr.*) {
                    .object => |inner| {
                        if (inner.get("count")) |cv| {
                            switch (cv) {
                                .integer => |n| {
                                    e.count = n;
                                    e.has_count = true;
                                },
                                .float => |f| {
                                    e.count = @intFromFloat(f);
                                    e.has_count = true;
                                },
                                else => {},
                            }
                        }
                        if (inner.get("ts")) |tv| {
                            switch (tv) {
                                .integer => |n| {
                                    e.ts = n;
                                    e.ts_is_num = true;
                                },
                                .float => |f| {
                                    e.ts = @intFromFloat(f);
                                    e.ts_is_num = true;
                                },
                                else => {},
                            }
                        }
                        c.put(key, e) catch {};
                    },
                    // entry not an object: JS keeps the key but ts is undefined,
                    // so prune drops it (ts_is_num stays false).
                    else => {
                        c.put(key, e) catch {};
                    },
                }
            }
        },
        else => return c, // not an object -> {}
    }
    return c;
}

fn pruneCounters(c: *Counters, now: i64) void {
    // JS: drop if !entry || typeof ts !== number || now-ts > PRUNE_MS
    var drop: std.ArrayList([]const u8) = .empty;
    for (c.keys.items) |k| {
        const e = c.map.get(k) orelse continue;
        if (!e.ts_is_num or (now - e.ts) > PRUNE_MS) {
            drop.append(A, k) catch {};
        }
    }
    for (drop.items) |k| c.remove(k);
}

fn writeCounters(io: Io, path: []const u8, c: *Counters) !void {
    // lstat guard: if symlink, abort (no-op)
    if (isSymlink(io, path)) return;

    // serialize compact: {"k":{"count":N,"ts":T},...}
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

    // write tmp then atomic rename over the target.
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
// firing text
fn buildText(count: i64, prefix: []const u8, rules: []const []const u8) ![]u8 {
    var t: std.ArrayList(u8) = .empty;
    try t.appendSlice(A, "BASELINE (turn ");
    try fmtInt(&t, count);
    try t.appendSlice(A, "). Open reply with line:\n\"");
    try t.appendSlice(A, prefix);
    try t.appendSlice(A, "\"\nthen recite each rule verbatim, then comply this turn:\n");
    for (rules, 0..) |r, idx| {
        if (idx != 0) try t.append(A, '\n');
        try t.appendSlice(A, "- ");
        try t.appendSlice(A, r);
    }
    try t.appendSlice(A, "\nDrifted (did inline)? Say so + correct now.");
    return t.items;
}

// JSON.stringify string escaping for the additionalContext value.
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
                    var buf: [6]u8 = undefined;
                    const hex = "0123456789abcdef";
                    buf[0] = '\\';
                    buf[1] = 'u';
                    buf[2] = '0';
                    buf[3] = '0';
                    buf[4] = hex[(c >> 4) & 0xf];
                    buf[5] = hex[c & 0xf];
                    try out.appendSlice(A, &buf);
                } else {
                    try out.append(A, c);
                }
            },
        }
    }
}

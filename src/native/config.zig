const std = @import("std");
const builtin = @import("builtin");
const contracts = @import("contracts.zig");
const hookin = @import("hookin.zig");
const docs = @import("docs.zig");

pub const Route = struct { id: []const u8, event: []const u8, freq: i64, cwd: ?[]const u8, doc: []const u8 };
pub const Loaded = struct { routes: std.ArrayList(Route) = .empty, valid: bool = false };

pub fn load(io: std.Io, allocator: std.mem.Allocator, config_path: []const u8, cfg_dir: []const u8) Loaded {
    const raw = std.Io.Dir.cwd().readFileAlloc(io, config_path, allocator, .limited(contracts.max_config_bytes)) catch return .{};
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, raw, .{}) catch return .{};
    const obj = switch (parsed.value) {
        .object => |o| o,
        else => return .{},
    };
    if (obj.get("version")) |version| {
        const supported = switch (version) {
            .integer => |n| n == contracts.schema_version,
            .float => |f| f == @as(f64, @floatFromInt(contracts.schema_version)),
            else => false,
        };
        if (!supported) return .{};
    }
    const routes_value = obj.get("routes") orelse return .{};
    const array = switch (routes_value) {
        .array => |a| a,
        else => return .{},
    };
    if (array.items.len > contracts.max_routes) return .{};

    var seen = std.StringHashMap(void).init(allocator);
    var routes: std.ArrayList(Route) = .empty;
    for (array.items) |value| {
        const route = switch (value) {
            .object => |o| o,
            else => continue,
        };
        const id = hookin.stringField(route, "id") orelse continue;
        if (!isSlug(id) or seen.contains(id)) continue;
        const event = hookin.stringField(route, "event") orelse continue;
        const parsed_event = hookin.parseEvent(event);
        if (!hookin.isSupportedEvent(parsed_event.base)) continue;
        if (parsed_event.phase) |phase| if (!std.mem.eql(u8, parsed_event.base, "SessionStart") or !isSessionPhase(phase)) continue;
        const doc = hookin.stringField(route, "doc") orelse continue;
        if (docs.safePath(allocator, doc, cfg_dir) == null) continue;
        var freq: i64 = 1;
        if (route.get("freq")) |value_freq| {
            freq = (switch (value_freq) {
                .integer => |n| if (n >= 1) n else null,
                .float => |f| if (f >= 1 and @floor(f) == f) @as(i64, @intFromFloat(f)) else null,
                else => null,
            }) orelse continue;
        }
        var cwd: ?[]const u8 = null;
        if (route.get("cwd")) |value_cwd| switch (value_cwd) {
            .string => |s| cwd = s,
            else => continue,
        };
        seen.put(id, {}) catch {};
        routes.append(allocator, .{ .id = id, .event = event, .freq = freq, .cwd = cwd, .doc = doc }) catch {};
    }
    return .{ .routes = routes, .valid = true };
}

pub fn select(allocator: std.mem.Allocator, routes: []Route, event: []const u8, source: ?[]const u8, session_cwd: ?[]const u8) ![]*const Route {
    var selected: std.ArrayList(*const Route) = .empty;
    for (routes) |*route| if (hookin.eventMatches(route.event, event, source) and cwdMatches(allocator, route.cwd, session_cwd)) try selected.append(allocator, route);
    return selected.items;
}

fn cwdMatches(allocator: std.mem.Allocator, route_cwd: ?[]const u8, session_cwd: ?[]const u8) bool {
    const route = route_cwd orelse return true;
    const session = session_cwd orelse return false;
    if (session.len == 0) return false;
    var base = std.fs.path.resolve(allocator, &.{route}) catch return false;
    var here = std.fs.path.resolve(allocator, &.{session}) catch return false;
    if (builtin.os.tag == .windows) {
        base = lower(allocator, base);
        here = lower(allocator, here);
    }
    if (std.mem.eql(u8, base, here)) return true;
    const prefix = if (base.len > 0 and base[base.len - 1] == std.fs.path.sep) base else std.fmt.allocPrint(allocator, "{s}{c}", .{ base, std.fs.path.sep }) catch return false;
    return std.mem.startsWith(u8, here, prefix);
}

fn lower(allocator: std.mem.Allocator, value: []const u8) []u8 {
    const out = allocator.alloc(u8, value.len) catch return @constCast(value);
    for (value, 0..) |c, i| out[i] = std.ascii.toLower(c);
    return out;
}

fn isSlug(value: []const u8) bool {
    if (value.len == 0 or !slugHead(value[0])) return false;
    for (value[1..]) |c| if (!slugHead(c) and c != '-') return false;
    return true;
}
fn slugHead(c: u8) bool {
    return (c >= 'a' and c <= 'z') or (c >= '0' and c <= '9');
}
fn isSessionPhase(value: []const u8) bool {
    for (contracts.session_phases) |phase| if (std.mem.eql(u8, value, phase)) return true;
    return false;
}

test "route grammar and cwd boundary" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    try std.testing.expect(isSlug("route-1"));
    try std.testing.expect(!isSlug("Route"));
    try std.testing.expect(cwdMatches(allocator, "foo", "foo/bar"));
    try std.testing.expect(!cwdMatches(allocator, "foo", "foobar"));
}

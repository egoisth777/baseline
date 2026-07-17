const std = @import("std");
const contracts = @import("contracts.zig");
const config = @import("config.zig");
const emit = @import("emit.zig");

const Entry = struct { count: i64 = 0, ts: i64 = 0, has_count: bool = false, ts_is_num: bool = false };
const State = struct {
    allocator: std.mem.Allocator,
    keys: std.ArrayList([]const u8) = .empty,
    map: std.StringHashMap(Entry),

    fn init(allocator: std.mem.Allocator) State {
        return .{ .allocator = allocator, .map = std.StringHashMap(Entry).init(allocator) };
    }
    fn put(self: *State, key_value: []const u8, value: Entry) !void {
        const result = try self.map.getOrPut(key_value);
        if (!result.found_existing) {
            const owned = try self.allocator.dupe(u8, key_value);
            result.key_ptr.* = owned;
            try self.keys.append(self.allocator, owned);
        }
        result.value_ptr.* = value;
    }
    fn remove(self: *State, key_value: []const u8) void {
        _ = self.map.remove(key_value);
        var write_index: usize = 0;
        for (self.keys.items) |item| if (!std.mem.eql(u8, item, key_value)) {
            self.keys.items[write_index] = item;
            write_index += 1;
        };
        self.keys.shrinkRetainingCapacity(write_index);
    }
};

pub fn key(allocator: std.mem.Allocator, session: []const u8, route: []const u8) ![]u8 {
    return std.fmt.allocPrint(allocator, "{s}{s}{s}", .{ session, contracts.counter_key_separator, route });
}

/// Returns null on counter I/O/lock failure. Returned route pointers borrow `selected`'s config arena.
pub fn bump(io: std.Io, allocator: std.mem.Allocator, counter_path: []const u8, selected: []*const config.Route, session: []const u8) ?[]*const config.Route {
    const lock_path = std.fmt.allocPrint(allocator, "{s}{s}", .{ counter_path, contracts.lock_suffix }) catch return null;
    if (!acquireLock(io, lock_path)) return null;
    defer releaseLock(io, lock_path);
    const now = std.Io.Clock.real.now(io).toMilliseconds();
    var state = read(io, allocator, counter_path);
    prune(&state, allocator, now);
    var due: std.ArrayList(*const config.Route) = .empty;
    for (selected) |route| {
        const counter_key = key(allocator, session, route.id) catch continue;
        const previous = if (state.map.get(counter_key)) |entry| if (entry.has_count) entry.count else 0 else 0;
        const count = previous + 1;
        state.put(counter_key, .{ .count = count, .ts = now, .has_count = true, .ts_is_num = true }) catch {};
        if (route.freq != 0 and @mod(count, route.freq) == 0) due.append(allocator, route) catch {};
    }
    write(io, allocator, counter_path, &state) catch return null;
    return due.items;
}

fn isSymlink(io: std.Io, path: []const u8) bool {
    const stat = std.Io.Dir.cwd().statFile(io, path, .{ .follow_symlinks = false }) catch return false;
    return stat.kind == .sym_link;
}

fn acquireLock(io: std.Io, path: []const u8) bool {
    const start = std.Io.Clock.real.now(io).toMilliseconds();
    while ((std.Io.Clock.real.now(io).toMilliseconds() - start) <= contracts.max_lock_wait_ms) {
        if (std.Io.Dir.cwd().createDir(io, path, .default_dir)) |_| return true else |err| {
            if (err != error.PathAlreadyExists) return false;
            if (std.Io.Dir.cwd().statFile(io, path, .{ .follow_symlinks = false })) |stat| {
                if (std.Io.Clock.real.now(io).toMilliseconds() - stat.mtime.toMilliseconds() > contracts.stale_lock_ms)
                    std.Io.Dir.cwd().deleteDir(io, path) catch {};
            } else |_| {}
            io.sleep(std.Io.Duration.fromMilliseconds(contracts.lock_retry_ms), .real) catch {};
        }
    }
    return false;
}
fn releaseLock(io: std.Io, path: []const u8) void {
    std.Io.Dir.cwd().deleteDir(io, path) catch {};
}

fn read(io: std.Io, allocator: std.mem.Allocator, path: []const u8) State {
    var state = State.init(allocator);
    if (isSymlink(io, path)) return state;
    const raw = std.Io.Dir.cwd().readFileAlloc(io, path, allocator, .limited(contracts.max_counter_bytes)) catch return state;
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, raw, .{}) catch return state;
    const object = switch (parsed.value) {
        .object => |o| o,
        else => return state,
    };
    var iterator = object.iterator();
    while (iterator.next()) |pair| {
        var entry: Entry = .{};
        switch (pair.value_ptr.*) {
            .object => |inner| {
                if (inner.get("count")) |value| switch (value) {
                    .integer => |n| {
                        entry.count = n;
                        entry.has_count = true;
                    },
                    .float => |f| {
                        entry.count = @intFromFloat(f);
                        entry.has_count = true;
                    },
                    else => {},
                };
                if (inner.get("ts")) |value| switch (value) {
                    .integer => |n| {
                        entry.ts = n;
                        entry.ts_is_num = true;
                    },
                    .float => |f| {
                        entry.ts = @intFromFloat(f);
                        entry.ts_is_num = true;
                    },
                    else => {},
                };
            },
            else => {},
        }
        state.put(pair.key_ptr.*, entry) catch {};
    }
    return state;
}

fn prune(state: *State, allocator: std.mem.Allocator, now: i64) void {
    var dropped: std.ArrayList([]const u8) = .empty;
    for (state.keys.items) |item| {
        const entry = state.map.get(item) orelse continue;
        if (!entry.ts_is_num or now - entry.ts > contracts.prune_ms) dropped.append(allocator, item) catch {};
    }
    for (dropped.items) |item| state.remove(item);
}

fn serialize(allocator: std.mem.Allocator, state: *State) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    try out.append(allocator, '{');
    var first = true;
    for (state.keys.items) |item| {
        const entry = state.map.get(item) orelse continue;
        if (!first) try out.append(allocator, ',');
        first = false;
        try out.append(allocator, '"');
        try emit.escape(&out, allocator, item);
        try out.appendSlice(allocator, "\":{\"count\":");
        try appendInt(&out, allocator, entry.count);
        try out.appendSlice(allocator, ",\"ts\":");
        try appendInt(&out, allocator, entry.ts);
        try out.append(allocator, '}');
    }
    try out.append(allocator, '}');
    return out.toOwnedSlice(allocator);
}

fn appendInt(out: *std.ArrayList(u8), allocator: std.mem.Allocator, value: i64) !void {
    var buffer: [24]u8 = undefined;
    try out.appendSlice(allocator, std.fmt.bufPrint(&buffer, "{d}", .{value}) catch return);
}

fn tempName(allocator: std.mem.Allocator, path: []const u8, nonce: u64) ![]u8 {
    return std.fmt.allocPrint(allocator, "{s}.tmp-{x}", .{ path, nonce });
}

fn write(io: std.Io, allocator: std.mem.Allocator, path: []const u8, state: *State) !void {
    if (isSymlink(io, path)) return;
    const bytes = try serialize(allocator, state);
    var attempt: usize = 0;
    while (attempt < 16) : (attempt += 1) {
        var random_bytes: [8]u8 = undefined;
        io.random(&random_bytes);
        const temp_path = try tempName(allocator, path, std.mem.readInt(u64, &random_bytes, .little));
        var file = std.Io.Dir.cwd().createFile(io, temp_path, .{ .exclusive = true }) catch |err| {
            if (err == error.PathAlreadyExists) continue;
            return err;
        };
        var created = true;
        defer if (created) std.Io.Dir.cwd().deleteFile(io, temp_path) catch {};
        file.writeStreamingAll(io, bytes) catch |err| {
            file.close(io);
            return err;
        };
        file.close(io);
        std.Io.Dir.renameAbsolute(temp_path, path, io) catch |err| return err;
        created = false;
        return;
    }
    return error.PathAlreadyExists;
}

test "counter key and serialization wire format" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const counter_key = try key(allocator, "session", "route");
    try std.testing.expectEqualStrings("session:route", counter_key);
    var state = State.init(allocator);
    try state.put("s:r", .{ .count = 2, .ts = 3, .has_count = true, .ts_is_num = true });
    const bytes = try serialize(allocator, &state);
    try std.testing.expectEqualStrings("{\"s:r\":{\"count\":2,\"ts\":3}}", bytes);
}

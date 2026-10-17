const std = @import("std");
const contracts = @import("contracts.zig");

pub const Payload = struct { session_id: []const u8, event: []const u8, source: ?[]const u8, cwd: ?[]const u8 };
pub const ParsedEvent = struct { base: []const u8, phase: ?[]const u8 };

pub fn readStdin(io: std.Io, allocator: std.mem.Allocator) ![]u8 {
    var buf: [4096]u8 = undefined;
    var reader = std.Io.File.stdin().readerStreaming(io, &buf);
    return reader.interface.allocRemaining(allocator, .limited(contracts.max_stdin_bytes));
}

pub fn parse(allocator: std.mem.Allocator, input: []const u8) ?Payload {
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, input, .{}) catch return null;
    const root = switch (parsed.value) {
        .object => |o| o,
        else => return null,
    };
    const session_id = sessionId(root) orelse return null;
    const event = stringField(root, "hook_event_name") orelse return null;
    if (!isSupportedEvent(event)) return null;
    return .{ .session_id = session_id, .event = event, .source = stringField(root, "source"), .cwd = stringField(root, "cwd") };
}

pub fn stringField(obj: std.json.ObjectMap, key: []const u8) ?[]const u8 {
    const value = obj.get(key) orelse return null;
    return switch (value) {
        .string => |s| s,
        else => null,
    };
}

fn sessionId(obj: std.json.ObjectMap) ?[]const u8 {
    const value = obj.get("session_id") orelse return null;
    return switch (value) {
        .string => |s| if (s.len == 0) null else s,
        else => null,
    };
}

pub fn isSupportedEvent(name: []const u8) bool {
    for (contracts.supported_events) |event| if (std.mem.eql(u8, event, name)) return true;
    return false;
}

pub fn parseEvent(event: []const u8) ParsedEvent {
    const dot = std.mem.indexOfScalar(u8, event, '.') orelse return .{ .base = event, .phase = null };
    return .{ .base = event[0..dot], .phase = event[dot + 1 ..] };
}

pub fn eventMatches(route_event: []const u8, hook_event: []const u8, source: ?[]const u8) bool {
    const event = parseEvent(route_event);
    if (!std.mem.eql(u8, event.base, hook_event)) return false;
    const phase = event.phase orelse return true;
    return if (source) |value| std.mem.eql(u8, phase, value) else false;
}

test "payload parsing and phase selection" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const p = parse(arena.allocator(), "{\"session_id\":\"7\",\"hook_event_name\":\"SessionStart\",\"source\":\"resume\"}").?;
    try std.testing.expectEqualStrings("7", p.session_id);
    try std.testing.expect(eventMatches("SessionStart.resume", p.event, p.source));
    try std.testing.expect(!eventMatches("SessionStart.startup", p.event, p.source));
    try std.testing.expect(parse(arena.allocator(), "{\"session_id\":7,\"hook_event_name\":\"UserPromptSubmit\"}") == null);
    try std.testing.expect(parse(arena.allocator(), "{\"session_id\":true,\"hook_event_name\":\"UserPromptSubmit\"}") == null);
}

const std = @import("std");
const builtin = @import("builtin");
const contracts = @import("contracts.zig");

pub const Inputs = struct { explicit: ?[]const u8 = null, baseline: ?[]const u8 = null, claude: ?[]const u8 = null, codex: ?[]const u8 = null, home: ?[]const u8 = null };

fn nonEmpty(value: ?[]const u8) ?[]const u8 {
    const v = value orelse return null;
    return if (v.len == 0) null else v;
}

pub fn envNonEmpty(env: *std.process.Environ.Map, key: []const u8) ?[]const u8 {
    return nonEmpty(env.get(key));
}

/// The home fallback is allocator-owned; environment/argument selections are borrowed.
pub fn agentDir(allocator: std.mem.Allocator, inputs: Inputs) ?[]const u8 {
    if (nonEmpty(inputs.explicit)) |v| return v;
    if (nonEmpty(inputs.baseline)) |v| return v;
    if (nonEmpty(inputs.claude)) |v| return v;
    if (nonEmpty(inputs.codex)) |v| return v;
    const home = nonEmpty(inputs.home) orelse return null;
    return std.fs.path.join(allocator, &.{ home, contracts.default_agent_dir }) catch null;
}

pub fn platformHome(env: *std.process.Environ.Map, allocator: std.mem.Allocator) ?[]const u8 {
    if (builtin.os.tag == .windows) {
        if (envNonEmpty(env, "USERPROFILE")) |v| return v;
        if (envNonEmpty(env, "HOMEDRIVE")) |drive| if (envNonEmpty(env, "HOMEPATH")) |part|
            return std.fmt.allocPrint(allocator, "{s}{s}", .{ drive, part }) catch null;
        return envNonEmpty(env, "HOME");
    }
    return envNonEmpty(env, "HOME") orelse envNonEmpty(env, "USERPROFILE");
}

pub fn join(allocator: std.mem.Allocator, a: []const u8, b: []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(allocator, a);
    if (a.len > 0 and a[a.len - 1] != '\\' and a[a.len - 1] != '/') try out.append(allocator, std.fs.path.sep);
    try out.appendSlice(allocator, b);
    return out.items;
}

test "explicit agent config is authoritative" {
    try std.testing.expectEqualStrings("chosen", agentDir(std.testing.allocator, .{ .explicit = "chosen", .baseline = "hostile", .claude = "wrong" }).?);
}

test "environment fallback order is retained" {
    try std.testing.expectEqualStrings("baseline", agentDir(std.testing.allocator, .{ .baseline = "baseline", .claude = "claude" }).?);
}

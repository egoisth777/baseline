const std = @import("std");

pub fn enabledValue(value: ?[]const u8) bool {
    const v = value orelse return false;
    return std.mem.eql(u8, v, "1");
}

pub fn write(io: std.Io, enabled: bool, code: []const u8) void {
    if (!enabled) return;
    var buf: [96]u8 = undefined;
    const line = std.fmt.bufPrint(&buf, "baseline: {s}\n", .{code}) catch return;
    std.Io.File.stderr().writeStreamingAll(io, line) catch {};
}

test "diagnostics are opt in" {
    try std.testing.expect(!enabledValue(null));
    try std.testing.expect(!enabledValue("0"));
    try std.testing.expect(enabledValue("1"));
    try std.testing.expect(!enabledValue("TRUE"));
}

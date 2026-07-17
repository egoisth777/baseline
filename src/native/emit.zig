const std = @import("std");
const contracts = @import("contracts.zig");

pub fn escape(out: *std.ArrayList(u8), allocator: std.mem.Allocator, value: []const u8) !void {
    for (value) |c| switch (c) {
        '"' => try out.appendSlice(allocator, "\\\""),
        '\\' => try out.appendSlice(allocator, "\\\\"),
        '\n' => try out.appendSlice(allocator, "\\n"),
        '\r' => try out.appendSlice(allocator, "\\r"),
        '\t' => try out.appendSlice(allocator, "\\t"),
        0x08 => try out.appendSlice(allocator, "\\b"),
        0x0c => try out.appendSlice(allocator, "\\f"),
        else => if (c < 0x20) {
            const hex = "0123456789abcdef";
            try out.appendSlice(allocator, &.{ '\\', 'u', '0', '0', hex[(c >> 4) & 0xf], hex[c & 0xf] });
        } else try out.append(allocator, c),
    };
}

pub fn envelope(allocator: std.mem.Allocator, event: []const u8, context: []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(allocator, "{\"");
    try out.appendSlice(allocator, contracts.output_outer_field);
    try out.appendSlice(allocator, "\":{\"");
    try out.appendSlice(allocator, contracts.output_event_field);
    try out.appendSlice(allocator, "\":\"");
    try escape(&out, allocator, event);
    try out.appendSlice(allocator, "\",\"");
    try out.appendSlice(allocator, contracts.output_context_field);
    try out.appendSlice(allocator, "\":\"");
    try escape(&out, allocator, context);
    try out.appendSlice(allocator, "\"}}");
    return out.toOwnedSlice(allocator);
}

test "exact output envelope" {
    const out = try envelope(std.testing.allocator, "UserPromptSubmit", "a\nb");
    defer std.testing.allocator.free(out);
    try std.testing.expectEqualStrings("{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"a\\nb\"}}", out);
}

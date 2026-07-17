const std = @import("std");
const contracts = @import("contracts.zig");

pub fn safePath(allocator: std.mem.Allocator, doc: []const u8, cfg_dir: []const u8) ?[]const u8 {
    if (doc.len == 0 or std.fs.path.isAbsolute(doc)) return null;
    const base = std.fs.path.resolve(allocator, &.{cfg_dir}) catch return null;
    const resolved = std.fs.path.resolve(allocator, &.{ cfg_dir, doc }) catch return null;
    if (std.mem.eql(u8, resolved, base)) return null;
    const prefix = if (base.len > 0 and base[base.len - 1] == std.fs.path.sep) base else std.fmt.allocPrint(allocator, "{s}{c}", .{ base, std.fs.path.sep }) catch return null;
    return if (std.mem.startsWith(u8, resolved, prefix)) resolved else null;
}

fn isSymlink(io: std.Io, path: []const u8) bool {
    const stat = std.Io.Dir.cwd().statFile(io, path, .{ .follow_symlinks = false }) catch return false;
    return stat.kind == .sym_link;
}

pub fn validUtf8(bytes: []const u8) bool {
    return std.unicode.utf8ValidateSlice(bytes);
}
pub fn utf16Len(bytes: []const u8) ?usize {
    if (!validUtf8(bytes)) return null;
    var count: usize = 0;
    var view = std.unicode.Utf8View.initUnchecked(bytes);
    var it = view.iterator();
    while (it.nextCodepoint()) |cp| count += if (cp > 0xffff) 2 else 1;
    return count;
}

const Slot = struct { body: ?[]const u8 = null, invalid_utf8: bool = false };
fn worker(io: std.Io, path: []const u8, slot: *Slot) void {
    const body = std.Io.Dir.cwd().readFileAlloc(io, path, std.heap.page_allocator, .limited(contracts.max_doc_bytes)) catch return;
    if (!validUtf8(body)) {
        slot.invalid_utf8 = true;
        return;
    }
    if ((utf16Len(body) orelse return) > contracts.max_doc_chars) return;
    slot.body = body;
}

pub const Batch = struct { bodies: []?[]const u8, invalid_utf8: bool };
/// Jobs own page-allocated bodies; all jobs are joined before this function returns.
pub fn readBatch(io: std.Io, allocator: std.mem.Allocator, paths: []const ?[]const u8) Batch {
    const slots = allocator.alloc(Slot, paths.len) catch return .{ .bodies = &.{}, .invalid_utf8 = false };
    @memset(slots, .{});
    var group: std.Io.Group = .init;
    for (paths, 0..) |maybe_path, i| {
        const path = maybe_path orelse continue;
        if (isSymlink(io, path)) continue; // I-018 policy preserved.
        group.concurrent(io, worker, .{ io, path, &slots[i] }) catch worker(io, path, &slots[i]);
    }
    group.await(io) catch {};
    const bodies = allocator.alloc(?[]const u8, paths.len) catch return .{ .bodies = &.{}, .invalid_utf8 = false };
    var invalid = false;
    for (slots, 0..) |slot, i| {
        bodies[i] = slot.body;
        invalid = invalid or slot.invalid_utf8;
    }
    return .{ .bodies = bodies, .invalid_utf8 = invalid };
}

test "path containment and UTF-8 contract" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    try std.testing.expect(safePath(arena.allocator(), "docs/a.md", "cfg") != null);
    try std.testing.expect(safePath(arena.allocator(), "../a.md", "cfg") == null);
    try std.testing.expect(!validUtf8(&.{ 0xc3, 0x28 }));
    try std.testing.expectEqual(@as(?usize, 2), utf16Len("😀"));
}

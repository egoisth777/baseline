const std = @import("std");
const contracts = @import("contracts.zig");
const resolve = @import("resolve.zig");
const hookin = @import("hookin.zig");
const config = @import("config.zig");
const counters = @import("counters.zig");
const docs = @import("docs.zig");
const emit = @import("emit.zig");
const diagnostics = @import("diagnostics.zig");

var allocator: std.mem.Allocator = undefined;
var args: std.process.Args = undefined;

pub fn main(init: std.process.Init) void {
    allocator = init.arena.allocator();
    args = init.minimal.args;
    run(init.io, init.environ_map) catch {};
}

fn run(io: std.Io, env: *std.process.Environ.Map) !void {
    const diagnostic = diagnostics.enabledValue(env.get(contracts.diagnostics_env));
    const input = hookin.readStdin(io, allocator) catch {
        diagnostics.write(io, diagnostic, "INPUT_INVALID");
        return;
    };
    const payload = hookin.parse(allocator, input) orelse {
        diagnostics.write(io, diagnostic, "INPUT_INVALID");
        return;
    };

    const agent_dir = resolve.agentDir(allocator, .{
        .explicit = argValue("--agent-config"),
        .baseline = resolve.envNonEmpty(env, "BASELINE_AGENT_CONFIG_DIR"),
        .claude = resolve.envNonEmpty(env, "CLAUDE_CONFIG_DIR"),
        .codex = resolve.envNonEmpty(env, "CODEX_HOME"),
        .home = resolve.platformHome(env, allocator),
    }) orelse return;
    const cfg_dir = try resolve.join(allocator, agent_dir, contracts.config_dir);
    const config_path = try resolve.join(allocator, cfg_dir, contracts.config_file);
    const counter_path = try resolve.join(allocator, agent_dir, contracts.counter_file);

    const loaded = config.load(io, allocator, config_path, cfg_dir);
    if (!loaded.valid) diagnostics.write(io, diagnostic, "CONFIG_INVALID");
    const selected = try config.select(allocator, loaded.routes.items, payload.event, payload.source, payload.cwd);
    if (selected.len == 0) return;
    const due = counters.bump(io, allocator, counter_path, selected, payload.session_id) orelse {
        diagnostics.write(io, diagnostic, "COUNTER_IO");
        return;
    };
    if (due.len == 0) return;

    const paths = try allocator.alloc(?[]const u8, due.len);
    for (due, 0..) |route, i| paths[i] = docs.safePath(allocator, route.doc, cfg_dir);
    const batch = docs.readBatch(io, allocator, paths);
    if (batch.invalid_utf8) {
        diagnostics.write(io, diagnostic, "DOC_INVALID_UTF8");
        return;
    }

    var bodies: std.ArrayList([]const u8) = .empty;
    var body_units: usize = 0;
    for (batch.bodies) |maybe_body| {
        const body = maybe_body orelse {
            diagnostics.write(io, diagnostic, "DOC_READ");
            continue;
        };
        const units = docs.utf16Len(body) orelse return;
        const joined_units = if (bodies.items.len == 0) units else body_units + contracts.document_separator.len * bodies.items.len + units;
        if (joined_units <= contracts.max_combined_context_chars) {
            try bodies.append(allocator, body);
            body_units += units;
        }
    }
    if (bodies.items.len == 0) return;

    var context: std.ArrayList(u8) = .empty;
    for (bodies.items, 0..) |body, i| {
        if (i != 0) try context.appendSlice(allocator, contracts.document_separator);
        try context.appendSlice(allocator, body);
    }
    const output = try emit.envelope(allocator, payload.event, context.items);
    std.Io.File.stdout().writeStreamingAll(io, output) catch {};
}

fn argValue(name: []const u8) ?[]const u8 {
    var iterator = std.process.Args.Iterator.initAllocator(args, allocator) catch return null;
    _ = iterator.skip();
    const prefix = std.fmt.allocPrint(allocator, "{s}=", .{name}) catch return null;
    while (iterator.next()) |argument| {
        if (std.mem.eql(u8, argument, name)) {
            const next = iterator.next() orelse return null;
            return if (next.len == 0) null else allocator.dupe(u8, next) catch null;
        }
        if (std.mem.startsWith(u8, argument, prefix)) {
            const value = argument[prefix.len..];
            return if (value.len == 0) null else allocator.dupe(u8, value) catch null;
        }
    }
    return null;
}

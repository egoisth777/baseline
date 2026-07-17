const std = @import("std");
const contracts = @import("contracts.zig");
const resolve = @import("resolve.zig");
const hookin = @import("hookin.zig");
const config = @import("config.zig");
const counters = @import("counters.zig");
const docs = @import("docs.zig");
const emit = @import("emit.zig");
const diagnostics = @import("diagnostics.zig");
const engine = @import("engine.zig");

test "every native module is imported" {
    _ = contracts;
    _ = resolve;
    _ = hookin;
    _ = config;
    _ = counters;
    _ = docs;
    _ = emit;
    _ = diagnostics;
    _ = engine;
}

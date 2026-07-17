// Thin native composition root. All dispatch state is owned by native/engine.zig;
// generated policy and testable seams live in the sibling native modules.
pub const main = @import("native/engine.zig").main;

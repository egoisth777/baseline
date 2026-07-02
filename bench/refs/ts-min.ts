// Minimal TypeScript reference hook for the benchmark: the same injection task as the
// baseline dispatcher, run through a TS-at-runtime loader (tsx / ts-node) so the numbers
// capture the transpile-on-start cost — which is exactly why the shipped dispatcher is
// compiled to JS, not run as TS. Reads the config path from BENCH_CONFIG, event from stdin.
import * as fs from 'fs';
import * as path from 'path';

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const configPath = process.env.BENCH_CONFIG as string;
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const cfgDir = path.dirname(configPath);
    const route = (cfg.routes || []).find((r: any) => r && r.event === data.hook_event_name);
    if (!route) return;
    const body = fs.readFileSync(path.join(cfgDir, route.doc), 'utf8');
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: data.hook_event_name, additionalContext: body }
    }));
  } catch (e) {
    // Fail-open like the real dispatcher: emit nothing.
  }
});

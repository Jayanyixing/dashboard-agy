---
name: telemetry-dashboard
description: Open or summarize the live Telemetry Dashboard sidecar panel showing conversation turns, steps, cumulative token usage, cache hit rate, and context window occupancy. Use when the user asks about token consumption, cache hit rate, context window usage, or wants to view the telemetry dashboard.
---

# Telemetry Dashboard

This plugin provides a real-time **Telemetry Dashboard** sidecar panel in the auxiliary side pane (`dashboard-agy/telemetry-panel`).

## Opening the Panel

When the user asks to view token consumption, cache hit rate, context usage, or open the monitoring dashboard, surface the sidecar pill link on its own line:

[Telemetry Dashboard](sidecar://dashboard-agy/telemetry-panel/ui.html)

## Notes

- Metrics are computed directly from the active conversation's `transcript.jsonl` (`USER_INPUT` turns, `step_index`, `input_tokens`, `cache_read_tokens`, `output_tokens`) enriched by `hooks.json` invocation timings.
- Throughput (`tok/s`) is an end-to-end estimate across model response intervals and is clearly labeled as estimated in the UI.

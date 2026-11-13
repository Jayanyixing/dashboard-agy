import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  collectConversationTelemetry,
  parseTranscriptText,
  resolveContextWindowSize,
} from '../sidecars/telemetry-panel/lib/telemetry.mjs';
import { createTelemetrySidecar } from '../sidecars/telemetry-panel/server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

test('resolveContextWindowSize infers model windows and respects manual overrides', () => {
  assert.equal(resolveContextWindowSize('Gemini 4 Hydrogen').windowSize, 1_048_576);
  assert.equal(resolveContextWindowSize('claude-sonnet-4').windowSize, 200_000);
  assert.equal(resolveContextWindowSize('DeepSeek-V4.1-Flash').windowSize, 131_072);
  assert.equal(resolveContextWindowSize('Gemini 4 Hydrogen', 200_000).windowSize, 200_000);
});

test('parseTranscriptText computes turns, steps, tokens, cache hit rate, context %, and tolerates partial lines', () => {
  const sampleJsonl = [
    JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-13T07:17:05Z',
      content:
        '<USER_REQUEST>\n你好，帮我查一下状态\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>The user changed setting `Model Selection` from None to Gemini 4 Hydrogen (XHigh).</USER_SETTINGS_CHANGE>',
    }),
    JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-13T07:17:10Z',
      input_tokens: 20000,
      cache_read_tokens: 0,
      output_tokens: 1000,
    }),
    JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-13T07:17:12Z',
      content: 'tool output',
    }),
    JSON.stringify({
      step_index: 3,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-13T07:17:16Z',
      input_tokens: 2000,
      cache_read_tokens: 20000,
      output_tokens: 1200,
    }),
    JSON.stringify({
      step_index: 4,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-13T07:18:00Z',
      content: '<USER_REQUEST>\n第二轮测试\n</USER_REQUEST>',
    }),
    JSON.stringify({
      step_index: 5,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-13T07:18:04Z',
      input_tokens: 1000,
      cache_read_tokens: 23000,
      output_tokens: 800,
    }),
    '{"step_index":6,"partial":', // simulates incomplete line during flush
  ].join('\n');

  const result = parseTranscriptText(sampleJsonl);
  assert.equal(result.modelName, 'Gemini 4 Hydrogen (XHigh)');
  assert.equal(result.windowSize, 1_048_576);

  const s = result.summary;
  assert.equal(s.totalTurns, 2);
  assert.equal(s.totalSteps, 6);
  assert.equal(s.modelCallCount, 3);
  assert.equal(s.toolStepCount, 1);
  assert.equal(s.uncachedInputTokens, 23000);
  assert.equal(s.cacheReadTokens, 43000);
  assert.equal(s.totalInputTokens, 66000);
  assert.equal(s.outputTokens, 3000);
  assert.equal(s.grandTotalTokens, 69000);
  assert.ok(Math.abs(s.cacheHitRate - (43000 / 66000) * 100) < 0.01);
  assert.equal(s.currentContextTokens, 1000 + 23000 + 800);
  assert.equal(s.peakContextTokens, 24800);
  assert.ok(s.avgTokPerSec > 0);

  assert.equal(result.turns.length, 2);
  assert.equal(result.turns[0].prompt, '你好，帮我查一下状态');
  assert.equal(result.turns[0].stepCount, 4);
  assert.equal(result.turns[1].prompt, '第二轮测试');
  assert.equal(result.turns[1].stepCount, 2);
});

test('hook script records session metadata and timings without breaking stdout', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-agy-hook-'));
  try {
    const hookScript = path.join(REPO_ROOT, 'hooks', 'record-telemetry.mjs');
    const env = { ...process.env, PLUGIN_DATA: tmpRoot };

    const preOut = execFileSync('node', [hookScript, 'PreInvocation'], {
      input: JSON.stringify({
        conversationId: 'conv-123',
        transcriptPath: '/tmp/fake/transcript.jsonl',
        modelName: 'gemini-4-hydrogen',
        invocationNum: 1,
        initialNumSteps: 1,
      }),
      env,
      encoding: 'utf-8',
    });
    assert.equal(preOut.trim(), '{}');

    const postOut = execFileSync('node', [hookScript, 'PostInvocation'], {
      input: JSON.stringify({
        conversationId: 'conv-123',
        transcriptPath: '/tmp/fake/transcript.jsonl',
        modelName: 'gemini-4-hydrogen',
        invocationNum: 1,
        initialNumSteps: 1,
      }),
      env,
      encoding: 'utf-8',
    });
    assert.equal(postOut.trim(), '{}');

    const saved = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, 'sessions', 'conv-123.json'), 'utf-8')
    );
    assert.equal(saved.conversationId, 'conv-123');
    assert.equal(saved.modelName, 'gemini-4-hydrogen');
    assert.equal(saved.lastEvent, 'PostInvocation');
    assert.equal(saved.timings.length, 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('sidecar HTTP server serves UI, enforces token on /api/*, and pushes SSE telemetry', async () => {
  const tmpAppDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-agy-app-'));
  const hookDataDir = path.join(tmpAppDir, 'sidecar_data', 'dashboard-agy');
  const convDir = path.join(tmpAppDir, 'brain', 'conv-abc', '.system_generated', 'logs');
  fs.mkdirSync(convDir, { recursive: true });
  fs.writeFileSync(
    path.join(convDir, 'transcript.jsonl'),
    [
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        created_at: '2026-11-13T08:00:00Z',
        content: '<USER_REQUEST>Hello sidecar</USER_REQUEST>',
      }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-13T08:00:02Z',
        input_tokens: 5000,
        cache_read_tokens: 15000,
        output_tokens: 400,
      }),
    ].join('\n'),
    'utf-8'
  );

  const sidecar = createTelemetrySidecar({
    appDataDir: tmpAppDir,
    hookDataDir,
    port: 0,
    token: 'secret-tok',
  });

  try {
    const port = await sidecar.start();
    const base = `http://127.0.0.1:${port}`;

    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);

    const uiRes = await fetch(`${base}/ui.html?token=secret-tok&conversationId=conv-abc`);
    assert.equal(uiRes.status, 200);
    const uiHtml = await uiRes.text();
    assert.match(uiHtml, /\/styles\.css\?token=secret-tok&conversationId=conv-abc/);

    const unauth = await fetch(`${base}/api/telemetry`);
    assert.equal(unauth.status, 401);

    const auth = await fetch(`${base}/api/telemetry?conversationId=conv-abc`, {
      headers: { 'X-Sidecar-Token': 'secret-tok' },
    });
    assert.equal(auth.status, 200);
    const payload = await auth.json();
    assert.equal(payload.activeConversationId, 'conv-abc');
    assert.equal(payload.telemetry.summary.totalTurns, 1);
    assert.equal(payload.telemetry.summary.grandTotalTokens, 20400);
    assert.equal(payload.telemetry.summary.cacheHitRate, 75);

    const collected = collectConversationTelemetry({
      appDataDir: tmpAppDir,
      hookDataDir,
      conversationId: 'conv-abc',
    });
    assert.equal(collected.telemetry.summary.totalSteps, 2);
  } finally {
    await sidecar.close();
    fs.rmSync(tmpAppDir, { recursive: true, force: true });
  }
});

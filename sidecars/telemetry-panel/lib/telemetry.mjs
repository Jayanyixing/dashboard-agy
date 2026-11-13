import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SAFE_ID_RE = /^[a-zA-Z0-9._-]+$/;

const DEFAULT_MODEL_WINDOWS = [
  { pattern: /claude.*1m/i, windowSize: 1_000_000, label: 'Claude (1M)' },
  { pattern: /claude|sonnet|opus|haiku/i, windowSize: 200_000, label: 'Claude (200K)' },
  { pattern: /deepseek/i, windowSize: 131_072, label: 'DeepSeek (128K)' },
  { pattern: /gpt-5|o3|o4/i, windowSize: 400_000, label: 'OpenAI (400K)' },
  { pattern: /gpt-4|gpt-oss/i, windowSize: 128_000, label: 'GPT-4 (128K)' },
  { pattern: /gemini|hydrogen|carbon|argon|\bflash\b|\bpro\b/i, windowSize: 1_048_576, label: 'Gemini (1M)' },
];

export function resolveAppDataDir(customAppDataDir) {
  const envDir = customAppDataDir || process.env.ANTIGRAVITY_APP_DATA_DIR;
  if (envDir && envDir.trim()) return envDir.trim();
  return path.join(os.homedir(), '.gemini', 'antigravity');
}

export function resolveHookDataDir(appDataDir) {
  const pluginData = process.env.PLUGIN_DATA?.trim();
  if (pluginData) return pluginData;
  const resolvedApp = resolveAppDataDir(appDataDir);
  return path.join(resolvedApp, 'sidecar_data', 'dashboard-agy');
}

export function resolveContextWindowSize(modelName, overrideWindowSize) {
  const overrideNum = Number(overrideWindowSize);
  if (Number.isFinite(overrideNum) && overrideNum > 0) {
    return { windowSize: Math.round(overrideNum), source: 'manual', label: formatCompactTokens(overrideNum) };
  }
  const name = typeof modelName === 'string' ? modelName.trim() : '';
  if (name && name.toLowerCase() !== 'auto') {
    for (const rule of DEFAULT_MODEL_WINDOWS) {
      if (rule.pattern.test(name)) {
        return { windowSize: rule.windowSize, source: 'model', label: rule.label };
      }
    }
  }
  return { windowSize: 1_048_576, source: 'default', label: 'Default (1M)' };
}

export function formatCompactTokens(num) {
  if (!Number.isFinite(num) || num <= 0) return '0';
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2).replace(/\.00$/, '')}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.round(num));
}

export function extractUserPromptPreview(content) {
  if (typeof content !== 'string' || !content.trim()) return '';
  const userMatch = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(content);
  const raw = userMatch ? userMatch[1] : content;
  const cleaned = raw
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.length > 72 ? `${cleaned.slice(0, 71)}…` : cleaned;
}

export function extractModelSelectionHint(content) {
  if (typeof content !== 'string' || !content) return null;
  const matches = [
    ...content.matchAll(
      /changed setting `Model Selection` from .*? to ([^.\n<]+)\./gi
    ),
  ];
  if (matches.length === 0) return null;
  return matches[matches.length - 1][1].trim();
}

function parseTimestampMs(iso) {
  if (typeof iso !== 'string' || !iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function toInt(val) {
  return typeof val === 'number' && Number.isFinite(val) && val >= 0
    ? Math.round(val)
    : 0;
}

function buildTimingLookup(hookMeta) {
  const byInitialSteps = new Map();
  const timings = Array.isArray(hookMeta?.timings) ? hookMeta.timings : [];
  for (const item of timings) {
    if (
      item &&
      typeof item.initialNumSteps === 'number' &&
      typeof item.durationMs === 'number' &&
      item.durationMs >= 100
    ) {
      byInitialSteps.set(item.initialNumSteps, item.durationMs);
    }
  }
  return byInitialSteps;
}

/**
 * Parses a transcript.jsonl payload into structured turn, step, token,
 * cache-hit, context-window, and estimated-throughput telemetry.
 */
export function parseTranscriptText(rawText, options = {}) {
  const hookMeta = options.hookMeta || null;
  const lines = typeof rawText === 'string' ? rawText.split(/\r?\n/) : [];
  const entries = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Ignore partial line while writer is flushing.
    }
  }

  let detectedModel =
    (typeof hookMeta?.modelName === 'string' &&
      hookMeta.modelName.trim() &&
      hookMeta.modelName.trim().toLowerCase() !== 'auto' &&
      hookMeta.modelName.trim()) ||
    null;

  for (const entry of entries) {
    if (entry.type === 'USER_INPUT' && typeof entry.content === 'string') {
      const hint = extractModelSelectionHint(entry.content);
      if (hint) detectedModel = hint;
    }
  }

  if (!detectedModel && typeof hookMeta?.modelName === 'string' && hookMeta.modelName.trim()) {
    detectedModel = hookMeta.modelName.trim();
  }

  const windowInfo = resolveContextWindowSize(
    detectedModel,
    options.windowSizeOverride
  );
  const hookTimings = buildTimingLookup(hookMeta);

  let uncachedInputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let modelCallCount = 0;
  let toolStepCount = 0;
  let peakContextTokens = 0;
  let latestContextTokens = 0;
  let latestStepCacheHitRate = null;
  let latestStepTokPerSec = null;
  let timedOutputTokens = 0;
  let timedDurationMs = 0;
  let throughputSource = 'none';

  const turns = [];
  let currentTurn = null;

  const finalizeTurn = (turn) => {
    if (!turn) return;
    const totalInput = turn.uncachedInputTokens + turn.cacheReadTokens;
    turn.totalInputTokens = totalInput;
    turn.totalTokens = totalInput + turn.outputTokens;
    turn.cacheHitRate =
      totalInput > 0 ? (turn.cacheReadTokens / totalInput) * 100 : null;
    turn.endContextPercent =
      windowInfo.windowSize > 0
        ? Math.min(100, (turn.endContextTokens / windowInfo.windowSize) * 100)
        : 0;
    turn.durationMs =
      turn.startedAtMs !== null && turn.endedAtMs !== null && turn.endedAtMs >= turn.startedAtMs
        ? turn.endedAtMs - turn.startedAtMs
        : null;
    turn.estimatedTokPerSec =
      turn.timedDurationMs >= 1000 && turn.timedOutputTokens > 0
        ? turn.timedOutputTokens / (turn.timedDurationMs / 1000)
        : null;
    delete turn.timedDurationMs;
    delete turn.timedOutputTokens;
  };

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const stepMs = parseTimestampMs(entry.created_at);

    if (entry.type === 'USER_INPUT' || (!currentTurn && i === 0)) {
      if (currentTurn) finalizeTurn(currentTurn);
      const isExplicitUser = entry.type === 'USER_INPUT';
      currentTurn = {
        turnNumber: turns.length + 1,
        prompt: isExplicitUser
          ? extractUserPromptPreview(entry.content) || `Turn ${turns.length + 1}`
          : 'Initial Context',
        startedAt: entry.created_at || null,
        endedAt: entry.created_at || null,
        startedAtMs: stepMs,
        endedAtMs: stepMs,
        stepCount: 0,
        modelCallCount: 0,
        toolStepCount: 0,
        uncachedInputTokens: 0,
        cacheReadTokens: 0,
        totalInputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheHitRate: null,
        endContextTokens: 0,
        endContextPercent: 0,
        estimatedTokPerSec: null,
        timedOutputTokens: 0,
        timedDurationMs: 0,
      };
      turns.push(currentTurn);
    }

    currentTurn.stepCount += 1;
    if (stepMs !== null) {
      if (currentTurn.startedAtMs === null) currentTurn.startedAtMs = stepMs;
      currentTurn.endedAt = entry.created_at;
      currentTurn.endedAtMs = stepMs;
    }

    if (entry.type === 'PLANNER_RESPONSE') {
      const inp = toInt(entry.input_tokens);
      const cache = toInt(entry.cache_read_tokens);
      const out = toInt(entry.output_tokens);
      const stepTotalInput = inp + cache;
      const stepContext = stepTotalInput + out;

      modelCallCount += 1;
      uncachedInputTokens += inp;
      cacheReadTokens += cache;
      outputTokens += out;

      if (stepContext > peakContextTokens) peakContextTokens = stepContext;
      latestContextTokens = stepContext;
      latestStepCacheHitRate =
        stepTotalInput > 0 ? (cache / stepTotalInput) * 100 : null;

      currentTurn.modelCallCount += 1;
      currentTurn.uncachedInputTokens += inp;
      currentTurn.cacheReadTokens += cache;
      currentTurn.outputTokens += out;
      if (stepContext > 0) currentTurn.endContextTokens = stepContext;

      const stepIdx = typeof entry.step_index === 'number' ? entry.step_index : i;
      const hookDur = hookTimings.get(stepIdx);
      let stepDurationMs = null;
      if (typeof hookDur === 'number' && hookDur >= 100 && out > 0) {
        stepDurationMs = hookDur;
        throughputSource = 'hook_ms';
      } else if (i > 0 && stepMs !== null && out > 0) {
        const prevMs = parseTimestampMs(entries[i - 1].created_at);
        if (prevMs !== null && stepMs - prevMs >= 1000) {
          stepDurationMs = stepMs - prevMs;
          if (throughputSource === 'none') throughputSource = 'transcript_sec';
        }
      }

      if (stepDurationMs !== null) {
        timedOutputTokens += out;
        timedDurationMs += stepDurationMs;
        currentTurn.timedOutputTokens += out;
        currentTurn.timedDurationMs += stepDurationMs;
        latestStepTokPerSec = out / (stepDurationMs / 1000);
      }
    } else if (entry.type !== 'USER_INPUT') {
      toolStepCount += 1;
      currentTurn.toolStepCount += 1;
    }
  }

  if (currentTurn) finalizeTurn(currentTurn);

  const totalInputTokens = uncachedInputTokens + cacheReadTokens;
  const grandTotalTokens = totalInputTokens + outputTokens;
  const cacheHitRate =
    totalInputTokens > 0 ? (cacheReadTokens / totalInputTokens) * 100 : null;
  const contextUsagePercent =
    windowInfo.windowSize > 0
      ? Math.min(100, (latestContextTokens / windowInfo.windowSize) * 100)
      : 0;
  const avgTokPerSec =
    timedDurationMs >= 1000 && timedOutputTokens > 0
      ? timedOutputTokens / (timedDurationMs / 1000)
      : null;

  const firstMs = entries.length > 0 ? parseTimestampMs(entries[0].created_at) : null;
  const lastMs =
    entries.length > 0 ? parseTimestampMs(entries[entries.length - 1].created_at) : null;
  const sessionDurationMs =
    firstMs !== null && lastMs !== null && lastMs >= firstMs ? lastMs - firstMs : 0;

  return {
    modelName: detectedModel || 'Unknown / Auto',
    windowSize: windowInfo.windowSize,
    windowSource: windowInfo.source,
    windowLabel: windowInfo.label,
    summary: {
      totalTurns: turns.filter((t) => t.prompt !== 'Initial Context' || turns.length === 1).length,
      totalSteps: entries.length,
      modelCallCount,
      toolStepCount,
      uncachedInputTokens,
      cacheReadTokens,
      totalInputTokens,
      outputTokens,
      grandTotalTokens,
      cacheHitRate,
      latestStepCacheHitRate,
      currentContextTokens: latestContextTokens,
      peakContextTokens,
      contextUsagePercent,
      avgTokPerSec,
      latestStepTokPerSec,
      throughputSource,
      sessionDurationMs,
      lastUpdatedAt: entries.length > 0 ? entries[entries.length - 1].created_at || null : null,
      isInvocationActive: Boolean(hookMeta?.activeInvocation),
      lastHookEvent: hookMeta?.lastEvent || null,
    },
    turns,
  };
}

export function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function getTranscriptPath(brainDir, conversationId) {
  if (!conversationId || !SAFE_ID_RE.test(conversationId)) return null;
  const resolvedBrain = path.resolve(brainDir);
  const candidate = path.resolve(
    resolvedBrain,
    conversationId,
    '.system_generated',
    'logs',
    'transcript.jsonl'
  );
  if (!candidate.startsWith(resolvedBrain + path.sep)) return null;
  return fs.existsSync(candidate) ? candidate : null;
}

export function listConversations(appDataDir, hookDataDir, limit = 25) {
  const brainDir = path.join(resolveAppDataDir(appDataDir), 'brain');
  const resolvedHookDir = hookDataDir || resolveHookDataDir(appDataDir);
  const activeHook = readJsonSafe(path.join(resolvedHookDir, 'active_conversation.json'));

  if (!fs.existsSync(brainDir)) return [];

  let dirs = [];
  try {
    dirs = fs.readdirSync(brainDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results = [];
  for (const dir of dirs) {
    if (!dir.isDirectory() || dir.name.startsWith('.') || !SAFE_ID_RE.test(dir.name)) {
      continue;
    }
    const transcriptPath = path.join(
      brainDir,
      dir.name,
      '.system_generated',
      'logs',
      'transcript.jsonl'
    );
    try {
      const stat = fs.statSync(transcriptPath);
      if (!stat.isFile()) continue;

      let firstPrompt = '';
      try {
        const fd = fs.openSync(transcriptPath, 'r');
        const buf = Buffer.alloc(4096);
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        const firstLine = buf.toString('utf-8', 0, bytesRead).split(/\r?\n/)[0];
        if (firstLine) {
          const parsed = JSON.parse(firstLine);
          firstPrompt = extractUserPromptPreview(parsed.content);
        }
      } catch {
        // Ignore preview read errors.
      }

      results.push({
        conversationId: dir.name,
        transcriptPath,
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
        title: firstPrompt || dir.name.slice(0, 8),
        isActiveHook: activeHook?.conversationId === dir.name,
      });
    } catch {
      // Skip conversations without transcripts.
    }
  }

  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results.slice(0, limit);
}

export function collectConversationTelemetry(options = {}) {
  const appDataDir = resolveAppDataDir(options.appDataDir);
  const hookDataDir = options.hookDataDir || resolveHookDataDir(appDataDir);
  const brainDir = path.join(appDataDir, 'brain');
  const conversations = listConversations(appDataDir, hookDataDir);

  let targetConvId =
    typeof options.conversationId === 'string' && SAFE_ID_RE.test(options.conversationId.trim())
      ? options.conversationId.trim()
      : '';

  if (!targetConvId || !getTranscriptPath(brainDir, targetConvId)) {
    const activeHook = readJsonSafe(path.join(hookDataDir, 'active_conversation.json'));
    if (
      activeHook?.conversationId &&
      getTranscriptPath(brainDir, activeHook.conversationId)
    ) {
      targetConvId = activeHook.conversationId;
    } else if (conversations.length > 0) {
      targetConvId = conversations[0].conversationId;
    }
  }

  if (!targetConvId) {
    return {
      activeConversationId: null,
      conversations: [],
      telemetry: parseTranscriptText('', options),
    };
  }

  const transcriptPath = getTranscriptPath(brainDir, targetConvId);
  const hookMeta = readJsonSafe(
    path.join(hookDataDir, 'sessions', `${targetConvId}.json`)
  );
  const rawText = transcriptPath ? fs.readFileSync(transcriptPath, 'utf-8') : '';
  const telemetry = parseTranscriptText(rawText, {
    hookMeta,
    windowSizeOverride: options.windowSizeOverride,
  });

  return {
    activeConversationId: targetConvId,
    transcriptPath,
    conversations,
    telemetry,
  };
}

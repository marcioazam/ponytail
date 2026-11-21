// The alias commands forward their arguments to the skill (they used to be dropped, so
// `/ponytail-review src/x.ts` lost its target).
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  DEFAULT_MODE,
  RUNTIME_MODES,
  getDefaultMode,
  getQuietStartup,
  getHideStatus,
  normalizeMode,
  normalizePersistedMode,
  isDeactivationCommand,
  writeDefaultMode,
} = require("../hooks/ponytail-config.js");
const { getPonytailInstructions, filterSkillBodyForMode } = require("../hooks/ponytail-instructions.js");

export { filterSkillBodyForMode };
export const readDefaultMode = getDefaultMode;
export const readQuietStartup = getQuietStartup;

const RUNTIME_MODE_LIST = RUNTIME_MODES.join("|");
const PONYTAIL_COMMAND_DESCRIPTION = `Set mode: ${RUNTIME_MODE_LIST}. Commands: status, default <mode>`;

export function resolveSessionMode(entries, fallbackMode = DEFAULT_MODE) {
  const fallback = normalizePersistedMode(fallbackMode) || DEFAULT_MODE;
  if (!Array.isArray(entries)) return fallback;

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "custom" || entry?.customType !== "ponytail-mode") continue;

    const mode = normalizePersistedMode(entry?.data?.mode);
    if (mode) return mode;
  }

  return fallback;
}

// Subagent name from the `--system-prompt <dir>/prompt-<safeName>.md` argument a subagent extension passes to child
// pi processes; null when absent or unparseable.
export function subagentName(argv) {
  const i = Array.isArray(argv) ? argv.indexOf("--system-prompt") : -1;
  const m = i >= 0 ? /^prompt-(.+)\.md$/.exec(String(argv[i + 1] || "").split(/[\\/]/).pop()) : null;
  return m ? m[1] : null;
}

// Mode of a child (subagent) pi process: the parent's mode, then PONYTAIL_SUBAGENT_MATCHER (unanchored,
// case-insensitive, like Claude's SubagentStart hook) turns it off for agents that do not match.
// Unparseable name or bad regex fail open (keep the mode).
export function childMode({ parentMode, matcher, argv, fallback }) {
  let mode = normalizePersistedMode(parentMode) || fallback;
  if (mode === "off" || !matcher) return mode;
  const name = subagentName(argv);
  if (name === null) return mode;
  try {
    return new RegExp(matcher, "i").test(name) ? mode : "off";
  } catch {
    return mode;
  }
}

export function parsePonytailCommand(text, defaultMode = DEFAULT_MODE, currentMode = null) {
  const fallback = normalizePersistedMode(defaultMode) || DEFAULT_MODE;
  const normalizedText = String(text || "").trim().toLowerCase();

  if (!normalizedText) {
    // Bare /ponytail switches ponytail on, or reports the level when it already is (#639).
    if (currentMode && currentMode !== "off") return { type: "status" };
    return { type: "set-mode", mode: fallback === "off" ? "full" : fallback };
  }

  const [primary, secondary] = normalizedText.split(/\s+/);

  if (primary === "status") return { type: "status" };

  if (primary === "default") {
    // ponytail: a default must be a runtime level; review is session-only (#377).
    const mode = normalizeMode(secondary);
    return mode ? { type: "set-default", mode } : { type: "invalid", reason: "invalid-default-mode" };
  }

  const mode = normalizeMode(primary);
  return mode ? { type: "set-mode", mode } : { type: "invalid", reason: "invalid-mode", mode: primary };
}

export { writeDefaultMode };

export default function ponytailExtension(pi) {
  let currentMode = DEFAULT_MODE;
  let configuredDefaultMode = getDefaultMode();
  let hideStatus = getHideStatus();
  let isActive = false;
  let lastCtx = null;

  // -- Status bar --
  function syncStatus(ctx) {
    if (ctx) lastCtx = ctx;
    const c = ctx || lastCtx;
    // ponytail: hide the indicator but keep the ruleset active (#324).
    if (hideStatus) return;
    if (!c?.ui?.setStatus) return;
    // ponytail: try/catch guards against pi-web theme proxy throwing before initTheme
    let theme;
    try { theme = c.ui.theme; if (!theme?.fg) return; } catch { return; }
    if (currentMode === "off") {
      c.ui.setStatus("ponytail", "");
      return;
    }
    const levelIcons = { lite: "🌿", full: "⚡", ultra: "🔥" };
    const icon = levelIcons[currentMode] || "";
    const label = currentMode.toUpperCase();
    const indicator = isActive ? theme.fg("accent", "●") : theme.fg("dim", "○");
    c.ui.setStatus("ponytail", indicator + " 🐴 " + theme.fg("muted", "ponytail: ") + theme.fg("text", icon + " " + label));
  }

  const setMode = (mode, ctx) => {
    const normalized = normalizePersistedMode(mode);
    if (!normalized) return;

    currentMode = normalized;
    process.env.PONYTAIL_PARENT_MODE = currentMode;
    pi.appendEntry("ponytail-mode", { mode: normalized });
    syncStatus(ctx);
    ctx?.ui?.notify?.(`Ponytail mode set to ${normalized}.`, "info");
  };

  // Resolvers waiting for the next agent_settled (aliases without UI, see sendAlias).
  const settledWaiters = [];
  pi.on("agent_settled", async () => {
    for (const resolve of settledWaiters.splice(0)) resolve();
  });

  const sendAlias = async (skillName, args, ctx) => {
    const normalized = String(args || "").trim();
    const message = normalized ? `${skillName} ${normalized}` : skillName;

    if (ctx?.isIdle?.() === false) {
      pi.sendUserMessage(message, { deliverAs: "followUp" });
      ctx?.ui?.notify?.(`${skillName} queued as follow-up.`, "info");
      return;
    }

    if (ctx?.hasUI !== false) {
      pi.sendUserMessage(message);
      return;
    }
    // In `pi -p` and `--mode json` print mode disposes the runtime as soon as the command handler returns, before
    // the run requested by sendUserMessage starts ("turn_end could not resolve...", stale ctx). Without UI the
    // handler therefore waits for that run to settle; if it does not start within 60 s, it returns anyway.
    const settled = new Promise((resolve) => settledWaiters.push(resolve));
    pi.sendUserMessage(message);
    const started = (async () => {
      for (let waited = 0; waited < 60_000; waited += 50) {
        if (ctx?.isIdle?.() === false) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return false;
    })();
    if (await Promise.race([settled.then(() => false), started])) await settled;
  };

  pi.registerCommand("ponytail", {
    description: PONYTAIL_COMMAND_DESCRIPTION,
    handler: async (args, ctx) => {
      const parsed = parsePonytailCommand(args, configuredDefaultMode, currentMode);

      if (parsed.type === "status") {
        ctx?.ui?.notify?.(`Ponytail: current ${currentMode} • default ${configuredDefaultMode}`, "info");
        return;
      }

      if (parsed.type === "set-default") {
        try {
          const written = writeDefaultMode(parsed.mode);
          if (written) {
            configuredDefaultMode = getDefaultMode();
            const message = configuredDefaultMode === written
              ? `Default Ponytail mode set to ${written}.`
              : `Saved default ${written}, but env override keeps default at ${configuredDefaultMode}.`;
            ctx?.ui?.notify?.(message, "info");
          }
        } catch (e) {
          ctx?.ui?.notify?.(`Failed to save default mode: ${e.message}`, "error");
        }
        return;
      }

      if (parsed.type === "set-mode") {
        setMode(parsed.mode, ctx);
        return;
      }

      ctx?.ui?.notify?.("Unknown or unsupported /ponytail mode.", "warning");
    },
  });

  pi.registerCommand("ponytail-review", {
    description: "Run /skill:ponytail-review",
    handler: (args, ctx) => sendAlias("/skill:ponytail-review", args, ctx),
  });

  pi.registerCommand("ponytail-audit", {
    description: "Run /skill:ponytail-audit",
    handler: (args, ctx) => sendAlias("/skill:ponytail-audit", args, ctx),
  });

  pi.registerCommand("ponytail-gain", {
    description: "Run /skill:ponytail-gain",
    handler: (args, ctx) => sendAlias("/skill:ponytail-gain", args, ctx),
  });

  pi.registerCommand("ponytail-debt", {
    description: "Run /skill:ponytail-debt",
    handler: (args, ctx) => sendAlias("/skill:ponytail-debt", args, ctx),
  });

  pi.registerCommand("ponytail-help", {
    description: "Run /skill:ponytail-help",
    handler: (args, ctx) => sendAlias("/skill:ponytail-help", args, ctx),
  });

  pi.on("input", async (event) => {
    if (event?.source === "extension") return;

    const text = String(event?.text || "");
    if (currentMode !== "off" && isDeactivationCommand(text)) {
      setMode("off");
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx?.sessionManager?.getBranch?.() || ctx?.sessionManager?.getEntries?.() || [];
    configuredDefaultMode = getDefaultMode();
    hideStatus = getHideStatus();
    currentMode = resolveSessionMode(entries, configuredDefaultMode);
    if (process.env.PI_CODE_SUBAGENT) {
      // Child: inherit the parent's mode and honor the matcher; never persisted.
      currentMode = childMode({
        parentMode: process.env.PONYTAIL_PARENT_MODE,
        matcher: process.env.PONYTAIL_SUBAGENT_MATCHER,
        argv: process.argv,
        fallback: currentMode,
      });
    }
    // Children spawned later inherit the mode through process.env.
    process.env.PONYTAIL_PARENT_MODE = currentMode;
    syncStatus(ctx);
    if (!getQuietStartup()) {
      ctx?.ui?.notify?.(`Ponytail loaded: ${currentMode}`, "info");
    }
  });

  pi.on("agent_start", async (_event, ctx) => {
    isActive = true;
    syncStatus(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    isActive = false;
    syncStatus(ctx);
  });

  pi.on("before_agent_start", async (event) => {
    if (!currentMode || currentMode === "off") {
      // Clear a stale section when the mode is off so a previous turn does not linger (#953).
      if (event?.systemPromptOptions?.sections) delete event.systemPromptOptions.sections.ponytail;
      return;
    }
    const instructions = getPonytailInstructions(currentMode);
    // Prefer structured sections so Pi can keep the cached prefix when other
    // extensions change their own section (#953). Fall back to replacement
    // for older Pi versions without systemPromptOptions.sections.
    const sections = event?.systemPromptOptions?.sections;
    if (sections && typeof sections === "object") {
      sections.ponytail = instructions;
      return;
    }
    // OMP passes the system prompt as an array of parts; keep it one (#776).
    if (Array.isArray(event?.systemPrompt)) {
      return { systemPrompt: [...event.systemPrompt, instructions] };
    }
    // Guard a null/undefined event or a missing systemPrompt: don't crash, and
    // don't prepend the literal string "undefined" to the prompt (#439, #440).
    const base = event?.systemPrompt ? `${event.systemPrompt}\n\n` : "";
    return { systemPrompt: `${base}${instructions}` };
  });
}

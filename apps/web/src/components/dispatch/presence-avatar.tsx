import {useState, type CSSProperties} from "react";

import type {AgentPresence} from "@/api/client";
import {Avatar, FieldGrid, Popover} from "@/arkcase";
import {formatRelativeTime} from "@/lib/presentation";
import opencodeGlyphUrl from "@/review/assets/agents/opencode-dark.svg";
import piGlyphUrl from "@/review/assets/agents/pi.svg";

import "./presence.css";

/**
 * What the avatar's ring says about the agent right now.
 *
 * Thinking collapses into the working ring: the pulse means "busy on your
 * behalf" whether the agent said so itself or the dispatch state implies it.
 */
export type PresenceRing = "disconnected" | "idle" | "replying" | "working";

/** How one agent kind looks: its bundled mark and its brand accent. */
interface AgentBrand {
  /** CSS color the ring is drawn from. */
  readonly accent: string;
  /** Bundled glyph asset, or null for the neutral letter mark. */
  readonly glyphUrl: string | null;
  /** CSS background of the circle the mark sits on. */
  readonly tile: string;
}

/**
 * The one place a new agent kind registers its look. Pi's and OpenCode's
 * brands are monochrome: a light mark on a dark tile, ringed in the page's
 * own ink. The dark tile is fixed rather than themed so one asset serves
 * both review themes.
 */
const brandByKind = new Map<string, AgentBrand>([
  [
    "pi",
    {
      accent: "var(--text-body)",
      glyphUrl: piGlyphUrl,
      tile: "oklch(0.205 0 0)",
    },
  ],
  [
    "opencode",
    {
      accent: "var(--text-body)",
      glyphUrl: opencodeGlyphUrl,
      tile: "oklch(0.205 0 0)",
    },
  ],
]);

const neutralBrand: AgentBrand = {
  accent: "var(--text-secondary)",
  glyphUrl: null,
  tile: "var(--text-secondary)",
};

function agentBrand(kind: string): AgentBrand {
  return brandByKind.get(kind) ?? neutralBrand;
}

/** The ring state one agent record resolves to, heartbeat first. */
export function presenceRing(agent: AgentPresence): PresenceRing {
  if (!agent.connected) return "disconnected";
  const beacon = agent.beacon ?? null;
  if (beacon === "replying") return "replying";
  if (beacon === "thinking") return "working";
  return (agent.activity ?? "idle") === "working" ? "working" : "idle";
}

const ringHeadings = {
  disconnected: "Disconnected",
  idle: "Idle",
  replying: "Replying",
  working: "Working",
} satisfies Record<PresenceRing, string>;

/** One sentence saying what the ring means, in words instead of motion. */
export function presenceSentence(
  agent: AgentPresence,
  ring: PresenceRing,
  now: number,
): string {
  switch (ring) {
    case "idle":
      return "Connected and idle — a send reaches it as one message.";
    case "working":
      return `Working — took a bundle ${
        formatRelativeTime(agent.lastActivityAt ?? agent.lastSeenAt, now)
      }.`;
    case "replying":
      return "Replying — writing back to the annotations it was sent.";
    case "disconnected":
      return `Not connected — last seen ${
        formatRelativeTime(agent.lastSeenAt, now)
      }. Restart the agent in its working directory to reconnect.`;
  }
  return ringHandled(ring);
}

function ringHandled(value: never): never {
  throw new Error(`Unhandled presence ring: ${String(value)}`);
}

const glyphPixels = {md: 32, sm: 20} as const;

const avatarButtonStyle = {
  background: "transparent",
  border: 0,
  borderRadius: "50%",
  cursor: "default",
  display: "inline-flex",
  padding: 0,
} satisfies CSSProperties;
const sentenceStyle = {color: "var(--text-secondary)", fontSize: "var(--font-size-xs, 12px)", margin: 0} satisfies CSSProperties;

/**
 * The bare presence circle: the agent's brand mark ringed by its state.
 * Decoration only — surfaces that can take a hover put it inside
 * `PresenceAvatar`, which adds the explaining popover.
 */
export function PresenceGlyph({
  kind,
  ring,
  size = "sm",
}: {
  readonly kind: string;
  readonly ring: PresenceRing;
  readonly size?: keyof typeof glyphPixels;
}) {
  const brand = agentBrand(kind);
  const pixels = glyphPixels[size];
  const glyphStyle: CSSProperties & Record<"--presence-accent", string> = {
    "--presence-accent": brand.accent,
    height: pixels,
    width: pixels,
  };
  return (
    <span aria-hidden="true" className="presence-glyph" data-presence-ring={ring} style={glyphStyle}>
      <span className={`presence-ring presence-ring-${ring}`} />
      <span className="presence-tile" style={{background: brand.tile}}>
        {brand.glyphUrl === null ? (
          <Avatar color={brand.tile} initials={kind.slice(0, 1).toUpperCase()} name={kind} size={pixels - 6} />
        ) : (
          <img alt="" src={brand.glyphUrl} style={{height: pixels / 2, width: pixels / 2}} />
        )}
      </span>
    </span>
  );
}

/**
 * One agent's presence as an avatar whose ring is the state signal. Hovering
 * or keyboard-focusing it opens a popover that says the state in words, so
 * color and motion never carry the meaning alone. The popover never takes
 * focus, so a returned focus cannot reopen what the pointer just left.
 */
export function PresenceAvatar({
  agent,
  now,
  size = "sm",
}: {
  readonly agent: AgentPresence;
  readonly now: number;
  readonly size?: keyof typeof glyphPixels;
}) {
  const [open, setOpen] = useState(false);
  const ring = presenceRing(agent);
  return (
    <Popover
      contentStyle={{gap: 8, padding: 12}}
      label={`${agent.displayName} presence`}
      onOpenChange={setOpen}
      open={open}
      trigger={(
        <button
          aria-label={`${agent.displayName} — ${ringHeadings[ring]}`}
          onBlur={() => setOpen(false)}
          onFocus={() => setOpen(true)}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          style={avatarButtonStyle}
          type="button"
        >
          <PresenceGlyph kind={agent.kind} ring={ring} size={size} />
        </button>
      )}
      width={320}
    >
      <strong>{agent.displayName}</strong>
      <p style={sentenceStyle}>{presenceSentence(agent, ring, now)}</p>
      <FieldGrid
        columns={1}
        fields={[
          {label: "Agent", value: agent.kind},
          {label: "Last seen", value: formatRelativeTime(agent.lastSeenAt, now)},
          {label: "Working directory", mono: true, value: agent.workingDirectory},
        ]}
        layout="inline"
      />
    </Popover>
  );
}

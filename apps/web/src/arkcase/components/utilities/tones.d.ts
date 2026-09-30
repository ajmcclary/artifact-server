/** A semantic tone: the StatusPill tones plus the solid `critical`. */
export type Tone = 'primary' | 'success' | 'warning' | 'danger' | 'neutral' | 'secondary' | 'critical';

/** The tokens that paint one tone; each value is a `var(--token, #fallback)` string. */
export interface ToneTokens {
  /** Solid fill for buttons, badges, bars and dots — non-text only. */
  fill: string;
  /** Text or glyph color on `fill` — text-safe on that fill only. */
  ink: string;
  /** Pill / soft-tint background (StatusPill, Toast tint) — non-text. */
  pillBg: string;
  /** Text on `pillBg` — text-safe on that tint and on card surfaces. */
  pillFg: string;
  /** Accent rule, border or rail (Alert border) — non-text; success and warning fall below 3:1 on white, so never the only signal. */
  line: string;
  /** Tone-colored copy on card, body, canvas and secondary surfaces — text-safe in every theme (danger `text-overdue`, warning `text-due-soon`). */
  text: string;
  /** Status glyph color beside text (Alert, StateStrip) — non-text accent; use `text` when the glyph carries meaning alone. */
  icon: string;
}

/** Every supported tone, in StatusPill order plus `critical`. */
export const TONES: Tone[];

/** The token set for a tone; unknown or missing tones resolve to `neutral`. */
export function toneTokens(tone: Tone | string | null | undefined): ToneTokens;

/** The default status glyph class for a tone, e.g. `bi-check-circle-fill`; unknown tones get the neutral glyph. */
export function toneIcon(tone: Tone | string | null | undefined): string;

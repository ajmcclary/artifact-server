import React from 'react';

export interface MentionPerson {
  /** The person's or agent's display name, matched after "@". */
  name: string;
  /** A second fact shown in the composer's list, e.g. a role or "Agent". */
  detail?: string;
  /** `bi-*` icon class for an avatar without a face, e.g. an agent's. */
  icon?: string;
}

export interface MentionTextProps {
  /** The comment body. */
  text?: string | null;
  /** Who can be mentioned; each "@Name" among them is drawn as a mention. */
  people?: MentionPerson[];
}

/**
 * A comment body with its @mentions drawn in the on-tint link ink at 600 weight. Longer names
 * match first; text that names no one renders unchanged.
 *
 * @startingPoint section="Data display" subtitle="Comment text with @mentions drawn as names" viewport="460x100"
 */
export function MentionText(props: MentionTextProps): React.JSX.Element | null;

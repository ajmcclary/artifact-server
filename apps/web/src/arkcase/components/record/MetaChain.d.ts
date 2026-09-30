import React from 'react';

export type MetaChainItem = React.ReactNode | { value: React.ReactNode; mono?: boolean };

export interface MetaChainProps {
  /** Parts of the chain. An item of the form { value, mono: true } puts that
   *  part in the data font. @default [] */
  items?: MetaChainItem[];
  /** Separator glyph. Middot by default. */
  separator?: React.ReactNode;
  /** Style overrides for the MetaChain root. */
  style?: React.CSSProperties;
}

/** The middot-separated provenance line beneath a row or heading. */
export function MetaChain(props: MetaChainProps): React.JSX.Element;

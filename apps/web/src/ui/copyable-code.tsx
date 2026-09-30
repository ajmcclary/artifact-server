import type {CSSProperties, JSX} from "react";

import {CodeBlock} from "@/arkcase";

import {CopyAction} from "./copy-action.tsx";

/** The DS CodeBlock grounds, repeated here because the block no longer docks its own button. */
const toneStyles = {
  navy: {background: "var(--surface-header, #073652)", color: "var(--text-on-navy, #ffffff)"},
  neutral: {background: "var(--surface-secondary, #f8f9fa)", color: "var(--text-data, #495057)"},
} as const;

const codeStyle: CSSProperties = {
  background: "transparent",
  borderRadius: 0,
  color: "inherit",
  flex: "1 1 auto",
  minWidth: 0,
};

/**
 * A code block with a docked copy button that reports the copied state only
 * after the clipboard write resolves. The DS CodeBlock's own `copy` option
 * flips to copied on click whether or not the write succeeded.
 */
export function CopyableCode(props: {
  readonly code: string;
  readonly copyLabel: string;
  readonly copiedLabel: string;
  readonly label?: string;
  readonly onResult?: (copied: boolean) => void;
  readonly tone?: "navy" | "neutral";
}): JSX.Element {
  const tone = props.tone ?? "neutral";
  return (
    <div
      style={{
        ...toneStyles[tone],
        alignItems: props.code.includes("\n") ? "flex-start" : "center",
        borderRadius: "var(--radius-md, 5px)",
        boxSizing: "border-box",
        display: "flex",
        gap: "var(--space-1, 4px)",
        maxWidth: "100%",
        paddingRight: "var(--space-1, 6px)",
      }}
    >
      <CodeBlock {...(props.label === undefined ? {} : {label: props.label})} style={codeStyle}>
        {props.code}
      </CodeBlock>
      <CopyAction
        copiedLabel={props.copiedLabel}
        label={props.copyLabel}
        {...(props.onResult === undefined ? {} : {onResult: props.onResult})}
        text={props.code}
        variant={tone === "navy" ? "navy" : "ghost"}
      />
    </div>
  );
}

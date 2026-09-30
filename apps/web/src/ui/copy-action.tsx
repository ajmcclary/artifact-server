import {useEffect, useRef, useState, type JSX, type ReactNode} from "react";

import {CopyButton} from "@/arkcase";

import {useAnnounce} from "./announcer.tsx";
import {copyText} from "./copy.ts";

const copiedHoldMilliseconds = 2_000;

/**
 * The DS `CopyButton` wired to the clipboard. The button shows its copied
 * state, and the announcement is spoken, only after the clipboard write
 * resolves; a refused write is announced assertively instead.
 */
export function CopyAction(props: {
  readonly text: string;
  readonly label: string;
  readonly copiedLabel?: string;
  readonly variant?: "ghost" | "outline" | "link" | "navy";
  readonly children?: ReactNode;
}): JSX.Element {
  const announce = useAnnounce();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);
  const copiedLabel = props.copiedLabel ?? `${props.label} copied`;
  const copyAndConfirm = async (): Promise<void> => {
    if (!await copyText(props.text)) {
      announce(`Could not copy ${props.label}.`, "assertive");
      return;
    }
    setCopied(true);
    announce(copiedLabel);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), copiedHoldMilliseconds);
  };
  return (
    <CopyButton
      aria-label={props.children === undefined ? props.label : undefined}
      copied={copied}
      copiedLabel={copiedLabel}
      onCopy={() => void copyAndConfirm()}
      variant={props.variant ?? "ghost"}
    >
      {props.children}
    </CopyButton>
  );
}

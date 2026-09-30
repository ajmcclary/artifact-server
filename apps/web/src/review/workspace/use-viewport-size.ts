import {useSyncExternalStore} from "react";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

const readWidth = (): number => window.innerWidth;
const readHeight = (): number => window.innerHeight;

/** The live viewport width the docking budget is measured against. */
export function useViewportWidth(): number {
  return useSyncExternalStore(subscribe, readWidth, readWidth);
}

/** The live viewport height; the inspector rail hides its vertical labels below 680 px. */
export function useViewportHeight(): number {
  return useSyncExternalStore(subscribe, readHeight, readHeight);
}

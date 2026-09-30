import {createContext, useCallback, useContext, useEffect, useMemo, useState, type JSX, type ReactNode} from "react";

import {browserStorage, readStoredDensity, storeDensity, type Density} from "./density-model.ts";

export {DENSITY_STORAGE_KEY, type Density} from "./density-model.ts";

interface DensityState {
  readonly density: Density;
  readonly setDensity: (next: Density) => void;
}

const DensityContext = createContext<DensityState>({
  density: "comfortable",
  setDensity: () => undefined,
});

/**
 * Holds the review density (contract correction 1). The DS has no global
 * density attribute, so components pass `density={useDensity()}` to the DS
 * components that accept it; `<html data-density>` is for application CSS.
 * Storage is written only when the user picks a value.
 */
export function DensityProvider(props: {readonly children: ReactNode}): JSX.Element {
  const [density, setDensityState] = useState(() => readStoredDensity(browserStorage()));
  useEffect(() => {
    document.documentElement.dataset["density"] = density;
  }, [density]);
  const setDensity = useCallback((next: Density) => {
    storeDensity(browserStorage(), next);
    setDensityState(next);
  }, []);
  const state = useMemo(() => ({density, setDensity}), [density, setDensity]);
  return <DensityContext value={state}>{props.children}</DensityContext>;
}

export function useDensity(): Density {
  return useContext(DensityContext).density;
}

export function useSetDensity(): (next: Density) => void {
  return useContext(DensityContext).setDensity;
}

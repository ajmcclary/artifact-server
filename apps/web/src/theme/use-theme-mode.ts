import {useCallback, useSyncExternalStore} from "react";

import {bootTheme, type ThemeController, type ThemeId, type ThemeMode} from "@/arkcase";

export interface ThemeModeState {
  readonly mode: ThemeMode;
  readonly theme: ThemeId;
  setMode(mode: ThemeMode): void;
}

/** The page's single DS theme controller; theme-boot normally created it before the bundle ran. */
function controller(): ThemeController | null {
  return bootTheme();
}

function subscribe(onChange: () => void): () => void {
  return controller()?.subscribe(onChange) ?? (() => undefined);
}

function currentMode(): ThemeMode {
  return controller()?.getMode() ?? "system";
}

function currentTheme(): ThemeId {
  return controller()?.getTheme() ?? "default";
}

/** The picked appearance mode, the theme it paints, and a setter that persists the pick. */
export function useThemeMode(): ThemeModeState {
  const mode = useSyncExternalStore(subscribe, currentMode);
  const theme = useSyncExternalStore(subscribe, currentTheme);
  const setMode = useCallback((next: ThemeMode) => {
    controller()?.setMode(next);
  }, []);
  return {mode, setMode, theme};
}

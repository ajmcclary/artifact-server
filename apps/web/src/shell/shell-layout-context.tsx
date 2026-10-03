import {createContext, type ReactNode, useContext, useMemo, useReducer, useState} from "react";

/** What the review workspace asks of the shell around it. */
export interface ShellLayoutState {
  /** False rails the navigation even when its pin says expanded (width budget). */
  readonly navExpandable: boolean;
  /** True marks the navigation inert beneath a full-screen layer. */
  readonly chromeHidden: boolean;
}

export interface ShellLayoutAction {
  readonly kind: "chrome" | "nav";
  readonly value: boolean;
}

/** What the current screen calls itself in a phone's app bar, when the shell cannot know. */
export interface ShellScreenTitle {
  readonly subtitle: string | null;
  readonly title: string;
}

export interface ShellLayoutControls {
  readonly setChromeHidden: (value: boolean) => void;
  readonly setNavExpandable: (value: boolean) => void;
  /** A review names its artifact and version; null hands the title back to the shell. */
  readonly setScreenTitle: (value: ShellScreenTitle | null) => void;
}

interface ShellLayoutValue {
  readonly controls: ShellLayoutControls;
  readonly screenTitle: ShellScreenTitle | null;
  readonly state: ShellLayoutState;
}

export const initialShellLayout: ShellLayoutState = {chromeHidden: false, navExpandable: true};

/** Pure transition; an unchanged value keeps the same object so React skips the render. */
export function shellLayoutReducer(state: ShellLayoutState, action: ShellLayoutAction): ShellLayoutState {
  if (action.kind === "nav") {
    return state.navExpandable === action.value ? state : {...state, navExpandable: action.value};
  }
  return state.chromeHidden === action.value ? state : {...state, chromeHidden: action.value};
}

const noControls: ShellLayoutControls = {
  setChromeHidden: () => undefined,
  setNavExpandable: () => undefined,
  setScreenTitle: () => undefined,
};
const ShellLayoutContext = createContext<ShellLayoutValue>({controls: noControls, screenTitle: null, state: initialShellLayout});

/** Lets the catalog reopen the application's navigation without adding a second pin. */
const ShellNavigationContext = createContext({collapsed: true, openMenu: (): void => undefined});
export const ShellNavigationProvider = ShellNavigationContext.Provider;
export function useShellNavigation() {
  return useContext(ShellNavigationContext);
}

export function ShellLayoutProvider({children}: {readonly children: ReactNode}) {
  const [state, dispatch] = useReducer(shellLayoutReducer, initialShellLayout);
  const [screenTitle, setScreenTitle] = useState<ShellScreenTitle | null>(null);
  const controls = useMemo<ShellLayoutControls>(() => ({
    setChromeHidden: (value) => dispatch({kind: "chrome", value}),
    setNavExpandable: (value) => dispatch({kind: "nav", value}),
    setScreenTitle,
  }), []);
  const value = useMemo<ShellLayoutValue>(() => ({controls, screenTitle, state}), [controls, screenTitle, state]);
  return <ShellLayoutContext.Provider value={value}>{children}</ShellLayoutContext.Provider>;
}

/** Stable setters for screens inside the shell. */
export function useShellLayout(): ShellLayoutControls {
  return useContext(ShellLayoutContext).controls;
}

/** The current requests, read by the shell frame. */
export function useShellLayoutState(): ShellLayoutState {
  return useContext(ShellLayoutContext).state;
}

/** The title the current screen handed the shell, if any. */
export function useShellScreenTitle(): ShellScreenTitle | null {
  return useContext(ShellLayoutContext).screenTitle;
}

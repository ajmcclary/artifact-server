import {createContext, type ReactNode, useContext, useMemo, useReducer} from "react";

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

export interface ShellLayoutControls {
  readonly setChromeHidden: (value: boolean) => void;
  readonly setNavExpandable: (value: boolean) => void;
}

interface ShellLayoutValue {
  readonly controls: ShellLayoutControls;
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
};
const ShellLayoutContext = createContext<ShellLayoutValue>({controls: noControls, state: initialShellLayout});

/** Lets the catalog reopen the application's navigation without adding a second pin. */
const ShellNavigationContext = createContext({collapsed: true, openMenu: (): void => undefined});
export const ShellNavigationProvider = ShellNavigationContext.Provider;
export function useShellNavigation() {
  return useContext(ShellNavigationContext);
}

export function ShellLayoutProvider({children}: {readonly children: ReactNode}) {
  const [state, dispatch] = useReducer(shellLayoutReducer, initialShellLayout);
  const controls = useMemo<ShellLayoutControls>(() => ({
    setChromeHidden: (value) => dispatch({kind: "chrome", value}),
    setNavExpandable: (value) => dispatch({kind: "nav", value}),
  }), []);
  const value = useMemo<ShellLayoutValue>(() => ({controls, state}), [controls, state]);
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

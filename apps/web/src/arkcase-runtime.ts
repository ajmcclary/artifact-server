import {createPortal} from "react-dom";

/**
 * Installs what the vendored ArkCase components expect from the page.
 *
 * The DS `Modal` portals only through `globalThis.ReactDOM.createPortal`
 * (contract correction 2). Call once, before the first render.
 */
export function installArkcaseRuntime(): void {
  Object.assign(globalThis, {ReactDOM: {createPortal}});
}

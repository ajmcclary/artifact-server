import "@/zod-jitless";

import {StrictMode} from "react";
import {createRoot} from "react-dom/client";

import {installArkcaseRuntime} from "@/arkcase-runtime";
import {installDraftGuard} from "@/components/comments/comment-drafts";
import {PaletteProvider} from "@/shell/command-palette";
import {AnnouncerProvider} from "@/ui/announcer";
import {DensityProvider} from "@/ui/density";
import {ToastProvider} from "@/ui/toasts";

import {ReviewApp} from "./review-app.tsx";
import {startReviewHistory} from "./review-history.ts";
import "@/arkcase/tokens/fonts.css";
import "@/arkcase/tokens/icons.css";
import "@/arkcase/tokens/colors.css";
import "@/arkcase/tokens/typography.css";
import "@/arkcase/tokens/spacing.css";
import "@/arkcase/tokens/elevation.css";
// The DS element reset and its reduced-motion rule.
import "@/arkcase/tokens/base.css";
import "@/theme/color-scheme.css";

// Modal portals through the ReactDOM global; install it before the first render.
installArkcaseRuntime();
// Lives for the whole session, above every route: the leave prompt and the
// logout purge must not depend on which screen is mounted.
installDraftGuard();
// Numbers history entries before any screen listens to Back and Forward.
startReviewHistory();

const rootElement = document.querySelector("#review-root");

if (!(rootElement instanceof HTMLElement)) {
  throw new Error("Artifact Server could not find its root element.");
}

createRoot(rootElement).render(
  <StrictMode>
    <DensityProvider>
      <AnnouncerProvider>
        <ToastProvider>
          <PaletteProvider>
            <ReviewApp />
          </PaletteProvider>
        </ToastProvider>
      </AnnouncerProvider>
    </DensityProvider>
  </StrictMode>,
);

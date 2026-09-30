import {createContext, useCallback, useContext, useEffect, useMemo, useState, type JSX, type ReactNode} from "react";

import {createAnnouncer} from "@/arkcase";

export type AnnouncementTone = "polite" | "assertive";

export interface Announcements {
  readonly assertive: string;
  readonly polite: string;
}

type Announce = (message: string, tone?: AnnouncementTone) => void;

const AnnounceContext = createContext<Announce>(() => undefined);
const AnnouncementsContext = createContext<Announcements>({assertive: "", polite: ""});

/**
 * One polite and one assertive message for the whole application. The shell
 * renders them through `AppShell announce` / `alert`; a screen without the
 * shell renders them through the DS `LiveRegion`. Repeated identical messages
 * are re-spoken (the DS clear-then-set announcer).
 */
export function AnnouncerProvider(props: {readonly children: ReactNode}): JSX.Element {
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");
  const politeAnnouncer = useMemo(() => createAnnouncer(setPolite), []);
  const assertiveAnnouncer = useMemo(() => createAnnouncer(setAssertive), []);
  useEffect(() => () => {
    politeAnnouncer.cancel();
    assertiveAnnouncer.cancel();
  }, [politeAnnouncer, assertiveAnnouncer]);
  const announce = useCallback<Announce>((message, tone = "polite") => {
    if (tone === "assertive") assertiveAnnouncer(message);
    else politeAnnouncer(message);
  }, [politeAnnouncer, assertiveAnnouncer]);
  const announcements = useMemo(() => ({assertive, polite}), [assertive, polite]);
  return (
    <AnnounceContext value={announce}>
      <AnnouncementsContext value={announcements}>{props.children}</AnnouncementsContext>
    </AnnounceContext>
  );
}

export function useAnnounce(): Announce {
  return useContext(AnnounceContext);
}

export function useAnnouncements(): Announcements {
  return useContext(AnnouncementsContext);
}

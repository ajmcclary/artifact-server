import {useEffect, useState} from "react";

import {api, ApiError} from "@/api/client";
import type {Permission} from "../settings/project-access-model.ts";

/** The caller's access to the open project or artifact, as the server resolves it. */
export interface EffectiveAccessState {
  readonly permissions: ReadonlySet<Permission>;
  /** "gone" means the server no longer shows this project to the caller. */
  readonly status: "gone" | "loading" | "ready";
}

const none: ReadonlySet<Permission> = new Set();

/**
 * Load which controls the caller may use. Until the answer arrives every gated
 * control stays hidden; the server refuses hidden operations either way.
 */
export function useEffectiveAccess(projectId: string | null, artifactId: string | null): EffectiveAccessState {
  const [state, setState] = useState<EffectiveAccessState>({permissions: none, status: "loading"});

  useEffect(() => {
    if (projectId === null) {
      setState({permissions: none, status: "loading"});
      return undefined;
    }
    let current = true;
    const load = async () => {
      try {
        const access = await api.effectiveAccess(projectId, artifactId);
        if (current) setState({permissions: new Set(access.permissions), status: "ready"});
      } catch (failure: unknown) {
        if (!current) return;
        const gone = failure instanceof ApiError && failure.status === 404 && failure.code === "PROJECT_NOT_FOUND";
        setState({permissions: none, status: gone ? "gone" : "ready"});
      }
    };
    void load();
    return () => {
      current = false;
    };
  }, [artifactId, projectId]);

  return state;
}

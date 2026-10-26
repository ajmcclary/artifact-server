import {useEffect, useState} from "react";

import {api, type AccessGrant, type Project} from "@/api/client";
import {Button} from "@/arkcase";
import {projectsHref} from "../review-routes.ts";
import {AdminNote, AdminStack, ledgerLinkStyle, RequestFailure} from "./admin-parts.tsx";
import {roleLabel} from "./project-access-model.ts";

/** Every project and artifact grant one member holds, with links to each project's access. */
export function MemberGrants({memberId}: {readonly memberId: string}) {
  const [grants, setGrants] = useState<readonly AccessGrant[] | null>(null);
  const [projects, setProjects] = useState<readonly Project[]>([]);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let current = true;
    const load = async () => {
      try {
        const [loaded, listed] = await Promise.all([api.memberGrants(memberId), api.projects()]);
        if (!current) return;
        setGrants(loaded);
        setProjects(listed);
      } catch (failure: unknown) {
        if (current) setError(failure instanceof Error ? failure : new Error(String(failure)));
      }
    };
    void load();
    return () => {
      current = false;
    };
  }, [memberId]);

  if (error !== null) return <RequestFailure error={error} />;
  if (grants === null) return null;
  if (grants.length === 0) {
    return <AdminNote>No project grants. This member has each project's default access.</AdminNote>;
  }
  return (
    <AdminStack>
      {grants.map((grant) => {
        const projectName = projects.find((project) => project.id === grant.projectId)?.name ?? grant.projectId;
        return (
          <Button
            flush
            href={projectsHref(grant.projectId)}
            key={grant.id}
            size="sm"
            style={ledgerLinkStyle}
            variant="link"
          >
            {`${projectName}: ${roleLabel(grant.role)}${grant.artifactId === null ? "" : " on one artifact"}`}
          </Button>
        );
      })}
    </AdminStack>
  );
}

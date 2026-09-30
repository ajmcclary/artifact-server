import type {Project} from "@/api/client";
import {CodeBlock, SurfaceState} from "@/arkcase";
import {useAnnounce} from "@/ui/announcer";
import {copyText} from "@/ui/copy";
import {AdminStack} from "./admin-parts.tsx";

export interface EmptyProjectStateProps {
  readonly project: Project;
}

/** The existing publish guidance for a project with no artifacts, with this project's CLI command. */
export function EmptyProjectState({project}: EmptyProjectStateProps) {
  const announce = useAnnounce();
  if (project.archivedAt !== null) {
    return (
      <SurfaceState
        count={0}
        emptyBody="This project is archived, so it accepts no new artifacts. Unarchive it in project settings to publish here."
        emptyIcon="bi-archive"
        emptyTitle="Nothing is published here yet"
        noun="artifacts"
        phase="ready"
        titleLevel={3}
      />
    );
  }
  const command = `artifactserver publish ./dist --project ${project.id}`;
  const copyCommand = async (): Promise<void> => {
    if (await copyText(command)) announce("Publish command copied");
  };
  return (
    <AdminStack>
      <SurfaceState
        count={0}
        emptyBody="Publish from the CLI to populate this project."
        emptyIcon="bi-collection"
        emptyTitle="Nothing is published here yet"
        noun="artifacts"
        phase="ready"
        titleLevel={3}
      />
      <CodeBlock
        copy={{
          copiedLabel: "Publish command copied",
          label: "Copy publish command",
          onCopy: () => void copyCommand(),
        }}
        tone="navy"
      >
        {command}
      </CodeBlock>
    </AdminStack>
  );
}

/** The workspace canvas shown in place of a preview when the selected project has no artifacts. */
export function EmptyProjectCanvas({project}: EmptyProjectStateProps) {
  return (
    <div style={{margin: "0 auto", maxWidth: 720, padding: "32px 18px", width: "100%"}}>
      <EmptyProjectState project={project} />
    </div>
  );
}

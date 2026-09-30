import type {CSSProperties} from "react";

import type {ArtifactVersion} from "@/api/client";
import {formatBytes} from "@/lib/presentation";
import {FileGroups} from "@/ui/review-ui";

import {mediaTypeEssence} from "./page-inventory.ts";

export interface FilesTabProps {
  readonly onSelect: (path: string) => void;
  readonly selectedPath: string;
  readonly version: ArtifactVersion;
}

const stackStyle = {padding: "10px 12px"} satisfies CSSProperties;

/** Every manifest entry of the exact version; choosing one previews it through `path`. */
export function FilesTab({onSelect, selectedPath, version}: FilesTabProps) {
  return (
    <div style={stackStyle}>
      <FileGroups
        files={version.manifest.entries.map((entry) => ({
          name: entry.path,
          onSelect: () => onSelect(entry.path),
          role: entry.path === selectedPath
            ? "Selected"
            : entry.path === version.manifest.entryPath ? "Default page" : mediaTypeEssence(entry.mediaType),
          size: formatBytes(entry.size),
        }))}
        label={`Files in version ${version.version.number}`}
        selected={selectedPath}
      />
    </div>
  );
}

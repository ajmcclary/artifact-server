import {useState, type CSSProperties} from "react";

import type {ArtifactVersion} from "@/api/client";
import {Button, Tabs} from "@/arkcase";
import {formatBytes} from "@/lib/presentation";
import {CopyAction} from "@/ui/copy-action";
import {type ArtifactFile, type ArtifactLinkRow, ArtifactLinks, FileGroups} from "@/ui/review-ui";

import {htmlPages} from "./page-inventory.ts";
import type {ReviewDownload} from "./workspace-types.ts";

export interface FilesTabProps {
  readonly onSelect: (path: string) => void;
  readonly selectedPath: string;
  readonly version: ArtifactVersion;
}

type FilesView = "files" | "pages";

const tabsStyle = {borderBottom: "1px solid var(--border-color)", padding: "4px 12px 0"} satisfies CSSProperties;
const treeStyle = {padding: "6px 0"} satisfies CSSProperties;
const linksStyle = {padding: "10px 12px"} satisfies CSSProperties;

/** The exact address of one file of an immutable version on its content host. */
export function exactFileUrl(version: ArtifactVersion, path: string): string {
  return new URL(path.split("/").map(encodeURIComponent).join("/"), version.links.version).toString();
}

/**
 * Every manifest entry of the exact version as a tree, or its pages' exact URLs.
 * Choosing a file previews it through `path`.
 */
export function FilesTab({onSelect, selectedPath, version}: FilesTabProps) {
  const [view, setView] = useState<FilesView>("files");
  const entries = version.manifest.entries;
  const pages = htmlPages(version.manifest.entryPath, entries);
  return (
    <div>
      <div style={tabsStyle}>
        <Tabs
          active={view}
          aria-label="File inventory view"
          onChange={(id) => setView(id === "pages" ? "pages" : "files")}
          tabs={[
            {count: entries.length, id: "files", label: "Files"},
            {count: pages.length, id: "pages", label: "Page URLs"},
          ]}
        />
      </div>
      {view === "pages" ? (
        <div style={linksStyle}>
          <ArtifactLinks
            copyAll="Copy all page URLs"
            note={null}
            onCopy={(text, label) => <CopyAction label={label} text={text} />}
            rows={pages.map((page) => {
              const row: ArtifactLinkRow = {label: page.name, path: page.path, url: exactFileUrl(version, page.path)};
              if (page.isDefault) row.description = "Default page";
              return row;
            })}
            title="Page URLs"
          />
        </div>
      ) : (
        <div style={treeStyle}>
          <FileGroups
            files={entries.map((entry) => {
              const file: ArtifactFile = {name: entry.path, onSelect: () => onSelect(entry.path), size: formatBytes(entry.size)};
              if (entry.path === version.manifest.entryPath) file.role = "Default page";
              return file;
            })}
            label={`Files in version ${version.version.number}`}
            selected={selectedPath}
          />
        </div>
      )}
    </div>
  );
}

/** The Files panel's docked footer: the shown version, as its single file or a ZIP. */
export function FilesDownload({download}: {readonly download: ReviewDownload | null}) {
  return download === null ? (
    <Button disabled icon="bi-download" outline size="sm" variant="secondary">Download Artifact</Button>
  ) : (
    <Button download href={download.href} icon="bi-download" outline size="sm" title={download.title} variant="secondary">
      Download Artifact
    </Button>
  );
}

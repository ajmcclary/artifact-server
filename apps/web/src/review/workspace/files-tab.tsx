import {useState, type CSSProperties} from "react";

import type {ArtifactVersion} from "@/api/client";
import {SplitButton, Tabs} from "@/arkcase";
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

/** Download the selected exact file; the menu also offers the entire version. */
function startDownload(download: ReviewDownload | null): void {
  if (download === null) return;
  const link = document.createElement("a");
  link.href = download.href;
  link.download = "";
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
}

export function FilesDownload({download, selected}: {readonly download: ReviewDownload | null; readonly selected: ReviewDownload | null}) {
  const primary = selected ?? download;
  return <SplitButton disabled={primary === null} icon="bi-download" menuLabel="Download options"
    menuItems={[
      {label: "Download Selected File", icon: "bi-file-earmark", disabled: selected === null,
        onClick: () => startDownload(selected)},
      {label: "Download Full Artifact", icon: "bi-download", description: download?.title,
        disabled: download === null, onClick: () => startDownload(download)},
    ]}
    onClick={() => startDownload(primary)} outline size="xs" variant="secondary">
    {selected === null ? "Download Artifact" : "Download File"}
  </SplitButton>;
}

/** Compact selection context at the panel's foot. */
export function FilesSelection({selectedPath, version}: {readonly selectedPath: string; readonly version: ArtifactVersion}) {
  const file = version.manifest.entries.find((entry) => entry.path === selectedPath);
  return <div aria-label="Selected file" role="group" style={{alignItems: "center", display: "flex", gap: 8, minWidth: 0, fontSize: "var(--font-size-xs, 12px)"}}>
    <span style={{color: "var(--text-secondary)"}}>Selected</span>
    <code style={{flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}} title={selectedPath}>{selectedPath}</code>
    {file === undefined ? null : <span style={{color: "var(--text-secondary)", flex: "none", fontFamily: "var(--font-data)"}}>{formatBytes(file.size)}</span>}
  </div>;
}

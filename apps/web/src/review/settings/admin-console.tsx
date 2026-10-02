import type {CSSProperties, ReactNode} from "react";

import {Breadcrumb, SectionHeading, Select, SideNav} from "@/arkcase";
import {useAnnounce} from "@/ui/announcer";

import {navigateReview} from "../review-routes.ts";
import {usePanelPreference} from "../workspace/panel-preferences.ts";
import {useViewportWidth} from "../workspace/use-viewport-size.ts";
import {isPhoneWidth} from "../workspace/workspace-layout.ts";
import {adminAreaById, adminMenuPanelId, visibleAdminAreas, type AdminAreaId} from "./admin-areas.ts";

const inspectorStackWidth = 900;

/** True where the 360 px detail pane cannot sit beside the list and stacks over it. */
export function useAdminInspectorFullscreen(): boolean {
  return useViewportWidth() < inspectorStackWidth;
}

export interface AdminConsoleProps {
  readonly administrator: boolean;
  readonly area: AdminAreaId;
  readonly children: ReactNode;
  readonly inspector?: ReactNode;
}

/**
 * The Admin Console pattern: an area menu, a breadcrumb heading, the area's
 * scrolling content, and an optional docked detail pane beside it. Unpinned, the
 * menu is an icon rail whose footer pin is the only way back to it expanded. The
 * pinned menu's header already names Administration, so the breadcrumb shows only
 * while the menu is a rail or absent.
 */
export function AdminConsole({administrator, area, children, inspector}: AdminConsoleProps) {
  const announce = useAnnounce();
  const phone = isPhoneWidth(useViewportWidth());
  const preference = usePanelPreference(adminMenuPanelId);
  const areas = visibleAdminAreas(administrator);
  const current = adminAreaById(area);
  const rootLabel = administrator ? "Administration" : "Settings";
  const firstArea = areas[0] ?? current;

  const menu = areas.length < 2 || phone ? null : (
    <SideNav
      activeLink={current.href}
      header={(
        <div style={menuHeaderStyle}>
          <SectionHeading
            level={2}
            size="md"
            title={(
              <span style={menuTitleStyle}>
                <i aria-hidden="true" className="bi bi-gear" style={{fontSize: "var(--icon-md, 20px)"}} />
                Administration
              </span>
            )}
          />
        </div>
      )}
      items={areas.map((candidate) => ({
        group: candidate.group,
        icon: candidate.icon,
        id: candidate.id,
        label: candidate.label,
        link: candidate.href,
      }))}
      maxWidth={340}
      minWidth={184}
      mode={preference.pinned ? "expanded" : "rail"}
      onAnnounce={announce}
      onPinChange={(next) => {
        preference.setPinned(next);
        announce(next ? "Administration menu pinned." : "Administration menu unpinned to the rail.");
      }}
      onSelect={(item) => {
        if (item.link !== undefined) navigateReview(item.link);
      }}
      onWidthChange={preference.setWidth}
      pinLabelVisible={false}
      pinName="the administration menu"
      pinned={preference.pinned}
      resizable
      title="Administration areas"
      width={preference.width ?? 224}
    />
  );

  return (
    <div data-admin-console="" style={consoleStyle}>
      {menu}
      <div style={columnStyle}>
        <div data-admin-head="" style={headStyle}>
          <SectionHeading
            eyebrow={menu === null || !preference.pinned
              ? <Breadcrumb items={[{href: firstArea.href, label: rootLabel}, current.label]} />
              : undefined}
            level={1}
            size="md"
            stackBelow={560}
            subtitle={current.lede}
            title={current.label}
          />
          {phone && areas.length > 1 ? (
            <Select
              label="Administration area"
              onChange={(event) => {
                const next = areas.find((candidate) => candidate.id === event.currentTarget.value);
                if (next !== undefined) navigateReview(next.href);
              }}
              options={areas.map((candidate) => ({label: candidate.label, value: candidate.id}))}
              size="sm"
              value={current.id}
            />
          ) : null}
        </div>
        <div style={rowStyle}>
          <div aria-label={current.label} data-admin-content="" role="region" style={scrollStyle} tabIndex={-1}>
            <div style={contentStyle}>{children}</div>
          </div>
          {inspector}
        </div>
      </div>
    </div>
  );
}

const consoleStyle: CSSProperties = {display: "flex", flex: "1 1 auto", minHeight: 0, minWidth: 0};
const columnStyle: CSSProperties = {display: "flex", flex: "1 1 auto", flexDirection: "column", minHeight: 0, minWidth: 0};
const headStyle: CSSProperties = {
  background: "var(--surface-card, #fff)",
  borderBottom: "1px solid var(--border-color, #DEE2E6)",
  display: "flex",
  flex: "none",
  flexDirection: "column",
  gap: 8,
  padding: "8px 16px 8px 14px",
};
const rowStyle: CSSProperties = {display: "flex", flex: "1 1 auto", minHeight: 0, position: "relative"};
const scrollStyle: CSSProperties = {
  background: "var(--surface-canvas, #F1F5F7)",
  flex: "1 1 auto",
  minHeight: 0,
  minWidth: 0,
  overflow: "auto",
};
const contentStyle: CSSProperties = {display: "flex", flexDirection: "column", gap: 16, maxWidth: 1360, padding: "16px 20px 28px"};
const menuHeaderStyle: CSSProperties = {
  background: "var(--surface-secondary, #F8F9FA)",
  borderBottom: "1px solid var(--border-color-strong, #CED4DA)",
  flex: "none",
  padding: "12px 14px 10px",
};
const menuTitleStyle: CSSProperties = {alignItems: "center", display: "inline-flex", gap: 10};

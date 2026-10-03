import {type CSSProperties, useState} from "react";

import {api, ApiError, type Principal, type Session} from "@/api/client";
import {
  AccountButton,
  Button,
  IdentityBlock,
  Menu,
  type MenuItem,
  SegmentedControl,
  Select,
  type ThemeMode,
} from "@/arkcase";
import {navigateReview, activityHref} from "@/review/review-routes";
import {useThemeMode} from "@/theme/use-theme-mode";
import {type Density, useDensity, useSetDensity} from "@/ui/density";
import {type Toasts, useToasts} from "@/ui/toasts";

import {administrationHref, isInstallationAdministrator} from "./nav-model.ts";

/** Where "Source on GitHub" leads. */
export const SOURCE_REPOSITORY_HREF = "https://github.com/ajmcclary/artifact-server";

interface AppearanceOption {
  readonly label: string;
  readonly mode: ThemeMode;
}

interface DensityOption {
  readonly density: Density;
  readonly label: string;
}

const appearanceOptions: readonly AppearanceOption[] = [
  {label: "System", mode: "system"},
  {label: "Light", mode: "default"},
  {label: "Dark", mode: "dark"},
  {label: "High contrast", mode: "high-contrast"},
];

const densityOptions: readonly DensityOption[] = [
  {density: "comfortable", label: "Comfortable"},
  {density: "compact", label: "Compact"},
];

interface AccountMenuProps {
  readonly rail: boolean;
  readonly session: Session;
}

/** The signed-in person at the foot of the navigation and the menu it opens. */
export function AccountMenu({rail, session}: AccountMenuProps) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const appearance = useThemeMode();
  const density = useDensity();
  const setDensity = useSetDensity();
  const toasts = useToasts();
  const principal = session.principal;
  const name = accountName(principal);
  const role = accountRole(principal);

  const close = (): void => {
    setOpen(false);
    anchor?.focus();
  };
  const items: MenuItem[] = [
    isInstallationAdministrator(principal)
      ? {icon: "bi-gear", label: "Administration", onClick: () => navigateReview(administrationHref(true))}
      // Non-administrators keep their only route to the MCP & WebMCP setup screen.
      : {icon: "bi-plug", label: "MCP & WebMCP", onClick: () => navigateReview(administrationHref(false))},
    {divider: true},
    {heading: "Appearance"},
    ...appearanceOptions.map((option): MenuItem => ({
      checked: appearance.mode === option.mode,
      keepOpen: true,
      label: option.label,
      onClick: () => appearance.setMode(option.mode),
      type: "radio",
    })),
    {heading: "Density"},
    ...densityOptions.map((option): MenuItem => ({
      checked: density === option.density,
      keepOpen: true,
      label: option.label,
      onClick: () => setDensity(option.density),
      type: "radio",
    })),
    {divider: true},
    {
      external: true,
      icon: "bi-github",
      label: "Source on GitHub",
      onClick: openSource,
    },
    {divider: true},
    {icon: "bi-box-arrow-right", label: "Sign out", onClick: () => signOut(toasts)},
  ];

  return (
    <>
      <AccountButton
        expanded={open}
        name={name}
        onClick={(event) => {
          setAnchor(event.currentTarget);
          setOpen((current) => !current);
        }}
        rail={rail}
        role={role}
      />
      {open ? (
        <Menu
          align="start"
          anchor={anchor}
          autoFocus
          density="comfortable"
          header={<IdentityBlock avatar={{size: 32}} detail={role} name={name} />}
          items={items}
          label="Account menu"
          onClose={close}
          placement="top"
          width={240}
        />
      ) : null}
    </>
  );
}

/**
 * The account row heading a phone's More sheet: who is signed in, then what
 * the account menu offers — appearance, density, the source and sign-out.
 * Administration is a tile of its own in the sheet.
 */
export function PhoneAccountRow({session}: {readonly session: Session}) {
  const appearance = useThemeMode();
  const density = useDensity();
  const setDensity = useSetDensity();
  const toasts = useToasts();
  const principal = session.principal;
  const densityLabel = densityOptions.find((option) => option.density === density)?.label ?? "Comfortable";
  return (
    <div data-phone-account="" style={phoneAccountStyle}>
      <IdentityBlock avatar={{size: 40}} detail={accountRole(principal)} name={accountName(principal)} />
      <div style={phoneSettingsStyle}>
        <Select
          label="Appearance"
          onChange={(event) => {
            const chosen = appearanceOptions.find((option) => option.mode === event.currentTarget.value);
            if (chosen !== undefined) appearance.setMode(chosen.mode);
          }}
          options={appearanceOptions.map((option) => ({label: option.label, value: option.mode}))}
          size="sm"
          value={appearance.mode}
        />
        <div style={phoneDensityStyle}>
          <span aria-hidden="true" style={phoneLabelStyle}>Density</span>
          <SegmentedControl
            block
            label="Density"
            mode="radio"
            onChange={(label) => {
              const chosen = densityOptions.find((option) => option.label === label);
              if (chosen !== undefined) setDensity(chosen.density);
            }}
            options={densityOptions.map((option) => option.label)}
            value={densityLabel}
          />
        </div>
      </div>
      <div style={phoneActionsStyle}>
        <Button icon="bi-github" onClick={openSource} outline size="sm" touch variant="secondary">Source on GitHub</Button>
        <Button icon="bi-box-arrow-right" onClick={() => signOut(toasts)} outline size="sm" touch variant="secondary">Sign out</Button>
      </div>
    </div>
  );
}

const phoneAccountStyle: CSSProperties = {display: "flex", flexDirection: "column", gap: 12, padding: "4px 0 8px"};
const phoneSettingsStyle: CSSProperties = {display: "grid", gap: 10, gridTemplateColumns: "minmax(0, 1fr)"};
const phoneDensityStyle: CSSProperties = {display: "flex", flexDirection: "column", gap: 4};
const phoneLabelStyle: CSSProperties = {color: "var(--text-emphasis, #374151)", fontSize: "var(--font-size-sm, 14px)", fontWeight: 600};
const phoneActionsStyle: CSSProperties = {display: "flex", flexWrap: "wrap", gap: 8};

function openSource(): void {
  window.open(SOURCE_REPOSITORY_HREF, "_blank", "noopener,noreferrer");
}

function accountRole(principal: Principal): string {
  return principal.membershipRole === "administrator" ? "Administrator" : "Member";
}

function accountName(principal: Principal): string {
  if (principal.displayName !== undefined && principal.displayName !== "") {
    return principal.displayName;
  }
  return principal.kind === "service" ? "Service account" : "Signed-in member";
}

/**
 * Sign out with a document load, which also drops every in-memory screen.
 * A refused sign-out keeps the reviewer where they are and says so, rather
 * than reloading into a session that is still signed in.
 */
function signOut(toasts: Toasts): void {
  void (async () => {
    try {
      // api.logout dispatches artifact-session-logout, which purges this principal's drafts.
      await api.logout();
    } catch (caught) {
      // An already-ended session has nothing left to sign out of.
      if (!(caught instanceof ApiError && caught.status === 401)) {
        toasts.push({
          durationMs: null,
          id: "sign-out-failed",
          message: `${caught instanceof Error ? caught.message : "The server did not answer."} You are still signed in.`,
          title: "Sign-out failed",
          variant: "danger",
        });
        return;
      }
    }
    window.location.assign(activityHref());
  })();
}

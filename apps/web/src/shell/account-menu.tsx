import {useState} from "react";

import {api, type Principal, type Session} from "@/api/client";
import {
  AccountButton,
  IdentityBlock,
  Menu,
  type MenuItem,
  type ThemeMode,
} from "@/arkcase";
import {
  navigateReview,
  REVIEW_RETURN_URL_KEY,
  reviewQueueHref,
  reviewReturnHref,
} from "@/review/review-routes";
import {readStored} from "@/lib/safe-storage";
import {useThemeMode} from "@/theme/use-theme-mode";
import {type Density, useDensity, useSetDensity} from "@/ui/density";

import {administrationHref, isInstallationAdministrator, type ShellMode} from "./nav-model.ts";

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
  readonly mode: ShellMode;
  readonly rail: boolean;
  readonly session: Session;
}

/** The signed-in person at the foot of the navigation and the menu it opens. */
export function AccountMenu({mode, rail, session}: AccountMenuProps) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const appearance = useThemeMode();
  const density = useDensity();
  const setDensity = useSetDensity();
  const principal = session.principal;
  const name = accountName(principal);
  const role = principal.membershipRole === "administrator" ? "Administrator" : "Member";

  const close = (): void => {
    setOpen(false);
    anchor?.focus();
  };
  const items: MenuItem[] = [
    mode === "admin"
      ? {
        icon: "bi-arrow-left",
        label: "Back to review",
        onClick: () => navigateReview(
          reviewReturnHref(readStored("session", REVIEW_RETURN_URL_KEY)),
        ),
      }
      : {
        icon: "bi-sliders",
        label: "Administration",
        onClick: () => navigateReview(
          administrationHref(isInstallationAdministrator(principal)),
        ),
      },
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
      onClick: () => {
        window.open(SOURCE_REPOSITORY_HREF, "_blank", "noopener,noreferrer");
      },
    },
    {divider: true},
    {icon: "bi-box-arrow-right", label: "Sign out", onClick: signOut},
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

function accountName(principal: Principal): string {
  if (principal.displayName !== undefined && principal.displayName !== "") {
    return principal.displayName;
  }
  return principal.kind === "service" ? "Service account" : "Signed-in member";
}

function signOut(): void {
  // api.logout dispatches artifact-session-logout, which purges this principal's drafts.
  void api.logout().finally(() => window.location.assign(reviewQueueHref()));
}

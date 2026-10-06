import {type BrowserAccess, browserAccessModes} from "../core/browser-access.js";

/** Remind operators once that invite links need provider-side sign-up. */
export function writeInviteSignUpNotice(browserAccess: BrowserAccess): void {
  if (browserAccess.mode !== browserAccessModes.privateTeam) return;
  process.stderr.write(
    "Invite links need sign-up enabled at the identity provider so new people can create an account.\n",
  );
}

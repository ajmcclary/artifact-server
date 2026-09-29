import {runPublicationGroup} from "../../src/cli/publication-groups.js";

const [config, server, tokenFile, profileData] = process.argv.slice(2);
if (config === undefined || server === undefined || tokenFile === undefined || profileData === undefined) {
  throw new Error("Pass config, origin, token file and profile directory.");
}
await runPublicationGroup({config, server, tokenFile, profileData, data: ".artifact-server", group: "all",
  allowCreate: true, dryRun: false, failFast: false}, async (event) => {
  // The callback runs after the group report is durable and before receipt acknowledgement.
  if (event.status === "published") process.exit(23);
});
process.exit(24);

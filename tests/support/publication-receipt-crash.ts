import {publishRemembered} from "../../src/cli/remembered-publication.js";

const [source, origin, tokenFile, profileData, newArtifact] = process.argv.slice(2);
if (source === undefined || origin === undefined || tokenFile === undefined || profileData === undefined) {
  throw new Error("Pass source, server, token file and profile directory.");
}
await publishRemembered(source, {
  server: origin, tokenFile, profileData, data: ".artifact-server", public: false, tag: [], newArtifact: newArtifact === "new",
}, async () => {
  // Lose the process after the receipt is durable but before stdout delivery.
  process.exit(23);
});

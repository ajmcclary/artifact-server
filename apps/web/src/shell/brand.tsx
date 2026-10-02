import {BrandLock} from "@/arkcase";
import {activityHref} from "@/review/review-routes";

/** The ArkCase lock-up naming Artifact Server; its link opens Activity. */
export function ArtifactServerBrand({compact = false, showProduct = true}: {readonly compact?: boolean; readonly showProduct?: boolean}) {
  if (compact) {
    // The rail emblem matches the expanded lock-up's, so the navy header keeps one height.
    return (
      <BrandLock
        homeLabel="Artifact Server"
        href={activityHref()}
        label="ArkCase"
        size={17}
        tone="reversed"
        wordmark={false}
      />
    );
  }
  return (
    <BrandLock
      homeLabel="Artifact Server"
      href={activityHref()}
      label="ArkCase"
      product={showProduct ? "Artifact Server" : undefined}
      size={17}
      tone="reversed"
    />
  );
}

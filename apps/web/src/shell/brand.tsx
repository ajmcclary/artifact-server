import {BrandLock} from "@/arkcase";
import {activityHref} from "@/review/review-routes";

/** The ArkCase lock-up naming Artifact Server; its link opens the review queue. */
export function ArtifactServerBrand({compact = false, showProduct = true}: {readonly compact?: boolean; readonly showProduct?: boolean}) {
  if (compact) {
    return (
      <BrandLock
        emblemSize={32}
        homeLabel="Artifact Server"
        href={activityHref()}
        label="ArkCase"
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

import {BrandLock} from "@/arkcase";
import {reviewQueueHref} from "@/review/review-routes";

/** The ArkCase lock-up naming Artifact Server; its link opens the review queue. */
export function ArtifactServerBrand({compact = false}: {readonly compact?: boolean}) {
  if (compact) {
    return (
      <BrandLock
        emblemSize={32}
        homeLabel="Artifact Server"
        href={reviewQueueHref()}
        label="ArkCase"
        tone="reversed"
        wordmark={false}
      />
    );
  }
  return (
    <BrandLock
      homeLabel="Artifact Server"
      href={reviewQueueHref()}
      label="ArkCase"
      product="Artifact Server"
      size={17}
      tone="reversed"
    />
  );
}

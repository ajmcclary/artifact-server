import {useState, type CSSProperties} from "react";

import {ApiError} from "@/api/client";
import {guestApi, type GuestContext} from "@/api/guest-client";
import {Alert, Input, Modal} from "@/arkcase";

export interface GuestNameDialogProps {
  readonly onClose: (named: GuestContext | null) => void;
  /** The link ended while the guest was naming themselves. */
  readonly onEnded: () => void;
  readonly open: boolean;
}

const bodyStyle = {display: "flex", flexDirection: "column", gap: 12} satisfies CSSProperties;

/** Asked once, on a guest's first comment: the name members will see beside it. */
export function GuestNameDialog({onClose, onEnded, open}: GuestNameDialogProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const save = async () => {
    setPending(true);
    setFailure(null);
    try {
      const trimmedEmail = email.trim();
      onClose(await guestApi.setIdentity(name, trimmedEmail === "" ? null : trimmedEmail));
    } catch (caught) {
      if (caught instanceof ApiError && (caught.code === "GUEST_SESSION_REQUIRED" || caught.code === "SHARE_LINK_NOT_FOUND")) {
        onEnded();
        return;
      }
      setFailure(caught instanceof ApiError ? caught.message : "Your name could not be saved.");
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      icon="bi-person"
      onClose={() => onClose(null)}
      open={open}
      portal
      primaryAction={{disabled: pending || name.trim() === "", label: pending ? "Saving…" : "Continue", onClick: () => void save()}}
      size="sm"
      subtitle="Members of this workspace see this name next to your comments."
      title="Before you comment"
    >
      <div style={bodyStyle}>
        <Input
          autoFocus
          disabled={pending}
          label="Your name, shown next to your comments"
          onChange={(event) => setName(event.currentTarget.value)}
          required
          size="sm"
          value={name}
        />
        <Input
          disabled={pending}
          label="Email (optional) — only members of this workspace can see it"
          onChange={(event) => setEmail(event.currentTarget.value)}
          size="sm"
          type="email"
          value={email}
        />
        {failure === null ? null : <Alert variant="danger">{failure}</Alert>}
      </div>
    </Modal>
  );
}

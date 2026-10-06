import {useState} from "react";

import {api, type AdministeredInvite, type CreateInviteBody} from "@/api/client";
import {Alert, Button, ChoiceGroup, Input, Select} from "@/arkcase";

const expiryOptions = [
  {label: "24 hours", value: "24h"},
  {label: "7 days", value: "7d"},
  {label: "30 days", value: "30d"},
];

export interface InviteFormProps {
  readonly onCancel: () => void;
  readonly onCreated: (issued: {readonly invite: AdministeredInvite; readonly url: string}) => void;
  readonly opens: CreateInviteBody["opens"];
}

/** One-person or link invite, role and expiry. The server enforces every rule again. */
export function InviteForm({onCancel, onCreated, opens}: InviteFormProps) {
  const [kind, setKind] = useState<"link" | "person">("person");
  const [email, setEmail] = useState("");
  const [uses, setUses] = useState("10");
  const [role, setRole] = useState<"administrator" | "member">("member");
  const [expiresIn, setExpiresIn] = useState<"24h" | "30d" | "7d">("7d");
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const maxUses = Number.parseInt(uses, 10);
  const valid = kind === "person"
    ? email.trim().includes("@")
    : Number.isInteger(maxUses) && maxUses >= 1 && maxUses <= 100;

  const submit = async () => {
    setPending(true);
    setFailure(null);
    try {
      const destination = opens === undefined ? {} : {opens};
      onCreated(await api.createInvite(kind === "person"
        ? {email: email.trim(), expiresIn, kind, role, ...destination}
        : {expiresIn, kind, maxUses, ...destination}));
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : "The invite could not be created.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div style={{display: "flex", flexDirection: "column", gap: 14}}>
      <p style={{fontSize: 13, lineHeight: 1.5, margin: 0}}>
        Create a link that admits someone to this Artifact Server. They sign in, join with the role you choose, and land on this version.
      </p>
      <ChoiceGroup
        label="Who can use the link"
        onChange={(id) => {
          if (id === "person" || id === "link") setKind(id);
        }}
        options={[
          {description: "Works once, for the email you enter.", icon: "bi-person", id: "person", title: "One person"},
          {description: "Works for a set number of people. Use it for a team you trust.", icon: "bi-people", id: "link", title: "Anyone with the link"},
        ]}
        value={kind}
        variant="row"
      />
      {kind === "person" ? (
        <Input
          helper="The verified email they sign in with must match."
          label="Email"
          onChange={(event) => setEmail(event.currentTarget.value)}
          required
          size="sm"
          type="email"
          value={email}
        />
      ) : (
        <Input
          helper="1 to 100 people. The link stops working after that."
          label="Uses"
          onChange={(event) => setUses(event.currentTarget.value)}
          size="sm"
          type="number"
          value={uses}
        />
      )}
      <div style={{display: "grid", gap: 12, gridTemplateColumns: "repeat(2, minmax(0, 1fr))"}}>
        <Select
          disabled={kind === "link"}
          helper={kind === "link" ? "Links always admit Members." : "Administrators can also manage members and keys."}
          label="Role"
          onChange={(event) => setRole(event.currentTarget.value === "administrator" ? "administrator" : "member")}
          options={kind === "link"
            ? [{label: "Member", value: "member"}]
            : [{label: "Member", value: "member"}, {label: "Administrator", value: "administrator"}]}
          size="sm"
          value={kind === "link" ? "member" : role}
        />
        <Select
          label="Expires"
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value === "24h" || value === "7d" || value === "30d") setExpiresIn(value);
          }}
          options={expiryOptions}
          size="sm"
          value={expiresIn}
        />
      </div>
      <Alert density="compact" live="off" variant="neutral">
        Every member can open every project. An administrator can also manage members, API keys, and public links.
      </Alert>
      {failure === null ? null : <Alert variant="danger">{failure}</Alert>}
      <div style={{display: "flex", gap: 8, justifyContent: "flex-end"}}>
        <Button disabled={pending} onClick={onCancel} outline size="sm" variant="secondary">Cancel</Button>
        <Button disabled={!valid || pending} icon="bi-link-45deg" loading={pending} onClick={() => void submit()} size="sm">
          Create Invite Link
        </Button>
      </div>
    </div>
  );
}

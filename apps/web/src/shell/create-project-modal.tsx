import {type FormEvent, useState} from "react";

import type {Project} from "@/api/client";
import {Alert, Input, Modal, type InputProps} from "@/arkcase";

const projectNameLimit = 120;
const projectNameInputId = "create-project-name";

interface CreateProjectModalProps {
  readonly onClose: () => void;
  readonly onCreate: (name: string) => Promise<Project>;
  readonly onCreated: (project: Project) => void;
  readonly open: boolean;
}

/** The New project dialog opened from the navigation's Projects group. */
export function CreateProjectModal({onClose, onCreate, onCreated, open}: CreateProjectModalProps) {
  const [name, setName] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const trimmed = name.trim();
  const tooLong = name.length > projectNameLimit;

  const close = (): void => {
    if (creating) return;
    setName("");
    setFailure(null);
    onClose();
  };
  const submit = async (): Promise<void> => {
    if (trimmed === "" || tooLong || creating) return;
    setCreating(true);
    setFailure(null);
    try {
      const project = await onCreate(trimmed);
      setName("");
      onCreated(project);
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : "Project creation failed.");
    } finally {
      setCreating(false);
    }
  };
  const submitForm = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void submit();
  };

  const nameField: InputProps = {
    autoComplete: "off",
    helper: trimmed === ""
      ? "Name the project before creating it."
      : "Name it after the application or programme the artifacts belong to.",
    id: projectNameInputId,
    label: "Project name",
    onChange: (event) => setName(event.currentTarget.value),
    size: "sm",
    value: name,
  };
  const fieldError = tooLong ? `Use ${projectNameLimit} characters or fewer.` : failure;
  if (fieldError !== null) nameField.error = fieldError;

  return (
    <Modal
      dismissible={!creating}
      icon="bi-folder-plus"
      inertSiblings
      initialFocus={`#${projectNameInputId}`}
      onClose={close}
      open={open}
      portal
      primaryAction={{
        disabled: creating || trimmed === "" || tooLong,
        icon: "bi-folder-plus",
        label: creating ? "Creating…" : "Create project",
        onClick: () => void submit(),
      }}
      size="sm"
      subtitle="A project groups artifacts, their versions and their conversations"
      title="New project"
    >
      <form onSubmit={submitForm} style={{display: "flex", flexDirection: "column", gap: 12}}>
        <Input {...nameField} />
        <Alert density="compact" live="off" title="Membership is installation-wide" variant="info">
          Every active member can work in this project. There is no separate project member list.
        </Alert>
      </form>
    </Modal>
  );
}

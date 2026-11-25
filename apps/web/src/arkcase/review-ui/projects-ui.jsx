import { fmt } from '../components/utilities/format.jsx';

/* The rows of the App's artifact and project lists, and a phone's Projects page. The App keeps
   the Panels that hold the lists (their pin, peek, sheet and width budget) and every filter. */
export function createProjectsUI(React, DS) {
  const { SelectableRow, RowSummary, CountBadge, StatusPill, SectionHeading, IconButton } = DS;
  const divider = '1px solid var(--list-divider, #E9ECEF)';
  const openBadge = (unresolved) => (unresolved ? <CountBadge count={unresolved + ' unresolved'} tone="primary" mono={false} /> : null);

  /* An artifact in a project's list: its name, latest version, open count and last update. */
  function ArtifactRow({ artifact, unresolved, selected, padding, minHeight, onSelect }) {
    return <SelectableRow selected={selected} label={'Open ' + artifact.name} padding={padding} onSelect={onSelect}
      style={{ minHeight, borderBottom: divider }}>
      <RowSummary title={artifact.name} meta={'v' + artifact.versions} detail={[openBadge(unresolved), artifact.updated]} />
    </SelectableRow>;
  }

  /* A project: its name (archived marked), open count, artifact count and last update. */
  function ProjectRow({ project, count, unresolved, last, selected, padding, minHeight, onSelect }) {
    return <SelectableRow selected={selected} label={'Open ' + project.name} padding={padding} onSelect={onSelect}
      style={{ minHeight, borderBottom: divider }}>
      <RowSummary title={project.name} meta={project.archived ? <StatusPill tone="neutral" label="Archived" /> : null}
        detail={[openBadge(unresolved), fmt.plural(count, 'artifact') + (last ? ' · ' + last : '')]} />
    </SelectableRow>;
  }

  /* A phone's Projects tab is a page of its own: the project list, document-scrolled. A row opens
     the project's first artifact, as a project in the menu does. `rows` are
     `{ project, count, unresolved, last }`. */
  function PhoneProjects({ rows, onNew, onOpen }) {
    return <div>
      <header style={{ padding: '20px 0 12px' }}>
        <SectionHeading level={1} size="lg" title="Projects" meta={fmt.plural(rows.length, 'project')}>
          <IconButton icon="bi-folder-plus" variant="primary" size="sm" ariaLabel="New project" onClick={onNew} />
        </SectionHeading>
      </header>
      <div role="list" aria-label="Projects" style={{ background: 'var(--surface-card, #fff)', border: '1px solid var(--border-color, #DEE2E6)',
        borderRadius: 'var(--radius-md, 5px)', boxShadow: 'var(--shadow-card, 0 1px 3px rgba(7,54,82,.1))', overflow: 'hidden' }}>
        {rows.map((row) => <div role="listitem" key={row.project.id}>
          <ProjectRow {...row} selected={false} padding="11px 14px" minHeight={56} onSelect={() => onOpen(row.project)} />
        </div>)}
      </div>
    </div>;
  }

  return { ArtifactRow, ProjectRow, PhoneProjects };
}

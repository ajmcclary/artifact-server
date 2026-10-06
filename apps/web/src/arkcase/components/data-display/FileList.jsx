import React from 'react';

/* Only glyphs present in the pinned Studio set: html/css/svg/json/xml have filetype
   artwork; the rest fall back to the nearest earmark variant. */
const TYPE_ICONS = {
  html: 'bi-filetype-html', htm: 'bi-filetype-html', css: 'bi-filetype-css', svg: 'bi-filetype-svg',
  json: 'bi-filetype-json', xml: 'bi-filetype-xml',
  js: 'bi-file-earmark-code', mjs: 'bi-file-earmark-code', jsx: 'bi-file-earmark-code', ts: 'bi-file-earmark-code',
  md: 'bi-file-earmark-richtext', txt: 'bi-file-earmark-text', pdf: 'bi-file-earmark-pdf',
  png: 'bi-image', jpg: 'bi-image', jpeg: 'bi-image', gif: 'bi-image', webp: 'bi-image',
};

/** The `bi-*` class for a file name's extension; `bi-file-earmark` when unknown. */
export function fileTypeIcon(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return (m && TYPE_ICONS[m[1].toLowerCase()]) || 'bi-file-earmark';
}

function RowContent({ file }) {
  return (
    <>
      <i aria-hidden="true" className={`bi ${file.icon || fileTypeIcon(file.name)}`} style={{ flex: 'none', fontSize: 'var(--icon-xs, 12px)' }} />
      <span
        style={{
          flex: '1 1 auto',
          minWidth: 0,
          fontFamily: 'var(--font-data, "Source Code Pro", ui-monospace, monospace)',
          fontSize: 'var(--font-size-xs, 12px)',
          color: 'var(--text-data, #495057)',
          overflowWrap: 'anywhere',
          textAlign: 'left',
        }}
      >
        {file.name}{file.size != null && file.size !== '' ? ' · ' + file.size : ''}
      </span>
      {file.role ? (
        <span style={{ flex: 'none', fontSize: 'var(--font-size-label, 11px)', color: 'var(--text-secondary, #5a6268)' }}>{file.role}</span>
      ) : null}
    </>
  );
}

const ROW = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-2, 8px)',
  minHeight: 40,
  boxSizing: 'border-box',
  padding: '6px 14px',
};

/**
 * ArkCase FileList — the files of a version or upload: type icon, `name · size`
 * in the data face, and an optional trailing role ("entry", "asset"), one row
 * per file on the list-divider hairline. The icon derives from the extension
 * unless given. With `onSelect` a row is a full-width button. `inset` sets the rows' side
 * padding (14px by default).
 */
export function FileList({ files = [], label, inset, style, ...rest }) {
  /* `inset` sets the rows' side padding, so a list can run edge to edge in a panel while its
     icons line up with an indented heading above it. */
  const row = inset == null ? ROW : { ...ROW, padding: '6px ' + (typeof inset === 'number' ? inset + 'px' : inset) };
  return (
    <ul
      role="list"
      aria-label={label}
      style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', ...style }}
      {...rest}
    >
      {files.map((f, i) => (
        <li key={f.name + ':' + i} style={{ borderBottom: 'var(--border-width, 1px) solid var(--list-divider, #e9ecef)' }}>
          {f.onSelect ? (
            <FileButton file={f} row={row} />
          ) : (
            <div style={row}><RowContent file={f} /></div>
          )}
        </li>
      ))}
    </ul>
  );
}

function FileButton({ file, row = ROW }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      onClick={(e) => file.onSelect(e)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...row,
        width: '100%',
        border: 0,
        background: hover ? 'var(--tint-primary-hover, rgba(0, 121, 168, 0.05))' : 'transparent',
        font: 'inherit',
        color: 'inherit',
        cursor: 'pointer',
      }}
    >
      <RowContent file={file} />
    </button>
  );
}

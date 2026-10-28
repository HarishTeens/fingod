export function Card({ title, actions, children, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header>
          {title && <h2>{title}</h2>}
          <span className="spacer" />
          {actions}
        </header>
      )}
      {children}
    </section>
  )
}

/**
 * Every chart ships one of these.
 *
 * It is three things at once: the accessibility channel, the contrast relief the
 * light palette's sub-3:1 WARN obliges, and the fastest way to sanity-check a
 * number you do not believe.
 */
export function TableToggle({ showing, onToggle }) {
  return (
    <button
      className="btn"
      aria-pressed={showing}
      onClick={onToggle}
      title={showing ? 'Show the chart' : 'Show the numbers'}
    >
      {showing ? 'Chart' : 'Table'}
    </button>
  )
}

export function Swatch({ color }) {
  return <i className="swatch" style={{ background: color }} aria-hidden="true" />
}

/** Legend — always present for two or more series, so identity is never colour alone. */
export function Legend({ items }) {
  return (
    <div className="legend">
      {items.map((it) => (
        <span key={it.key}>
          <Swatch color={it.color} />
          {it.label}
        </span>
      ))}
    </div>
  )
}

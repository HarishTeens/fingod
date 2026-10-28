import { useEffect, useState } from 'react'
import { Dashboard } from './pages/Dashboard.jsx'
import { Expenses } from './pages/Expenses.jsx'
import { Investments } from './pages/Investments.jsx'
import { Realised } from './pages/Realised.jsx'

const PAGES = [
  { id: '', label: 'Dashboard', render: () => <Dashboard /> },
  { id: 'investments', label: 'Investments', render: () => <Investments /> },
  { id: 'realised', label: 'Realised', render: () => <Realised /> },
  { id: 'expenses', label: 'Expenses', render: () => <Expenses /> },
]

/**
 * Hash routing, hand-rolled.
 *
 * A router is a dependency, a bundle and an API to learn, for two pages that
 * need nothing but "which one". The hash also survives a reload and can be
 * bookmarked, which is the only part of routing this app actually uses.
 */
function useHashRoute() {
  const [hash, setHash] = useState(() => window.location.hash.replace(/^#\/?/, ''))
  useEffect(() => {
    const onChange = () => setHash(window.location.hash.replace(/^#\/?/, ''))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return hash
}

/**
 * Theme is the one thing localStorage holds. Postgres is the system of record
 * for everything else — the browser stores preferences, never data.
 */
function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem('fingod.theme') || 'dark')
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('fingod.theme', theme)
  }, [theme])
  return [theme, setTheme]
}

export default function App() {
  const [theme, setTheme] = useTheme()
  const route = useHashRoute()
  const page = PAGES.find((p) => p.id === route) || PAGES[0]

  return (
    <div className="app">
      <div className="topbar">
        <h1>fingod</h1>
        <nav className="tabs" style={{ marginLeft: 18 }}>
          {PAGES.map((p) => (
            <a
              key={p.id}
              className="tab"
              href={`#/${p.id}`}
              aria-current={p.id === page.id ? 'page' : undefined}
            >
              {p.label}
            </a>
          ))}
        </nav>
        <span className="spacer" />
        <button
          className="btn"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          title="Both themes are selected, not inverted"
        >
          {theme === 'dark' ? 'Light' : 'Dark'}
        </button>
      </div>
      {page.render()}
    </div>
  )
}

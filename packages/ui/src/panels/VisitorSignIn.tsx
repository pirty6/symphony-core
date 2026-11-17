import { useEffect, useRef, useState } from 'react'
import { api, errorText, type AccountView } from '../lib/api'

const POLL_MS = 3000

/**
 * A browser on another computer, with AI: GitHub Copilot: sign in with your own GitHub account so
 * runs use your Copilot. GitHub shows the code at github.com/login/device, in this browser; the
 * studio's computer never uses your account for anything else.
 */
export function VisitorSignIn({ onChange }: { readonly onChange?: (signedIn: boolean) => void }) {
  const [account, setAccount] = useState<AccountView | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  // The latest callback, so a parent re-rendering does not restart the wait below.
  const changed = useRef(onChange)
  changed.current = onChange

  useEffect(() => {
    let cancelled = false
    void api.account().then((a) => !cancelled && setAccount(a), () => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  // Waiting for the code to be entered at GitHub: check until it is.
  const waiting = account?.pending !== undefined && !account.signedIn
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => {
      void api.account().then((a) => {
        setAccount(a)
        if (a.signedIn) changed.current?.(true)
      }, () => undefined)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [waiting])

  if (!account || account.here) return null

  const signIn = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const pending = await api.accountLogin()
      setAccount({ ...account, pending })
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const signOut = async () => {
    await api.accountLogout()
    setAccount({ here: false, signedIn: false })
    changed.current?.(false)
  }

  if (account.signedIn)
    return (
      <div className="card notice" data-testid="visitor-account">
        GitHub Copilot as <b>{account.login}</b> (your own account).{' '}
        <button type="button" className="link" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    )
  return (
    <div className="card issue" data-testid="visitor-account">
      {account.pending ? (
        <span>
          Open{' '}
          <a href={account.pending.url} target="_blank" rel="noreferrer">
            {account.pending.url}
          </a>{' '}
          and enter <b className="mono">{account.pending.code}</b>, then authorize GitHub Copilot. Waiting…
        </span>
      ) : (
        <span>
          To use GitHub Copilot from this computer, sign in with your own GitHub account.{' '}
          <button type="button" className="primary" disabled={busy} onClick={() => void signIn()}>
            Sign in with GitHub
          </button>
        </span>
      )}
      {(error ?? account.error) && <div className="muted">{error ?? account.error}</div>}
    </div>
  )
}

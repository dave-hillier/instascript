import { useEffect, useReducer, useRef } from 'react'
import type { ReactNode } from 'react'

// One-time 18+ acknowledgement (story 6.1). The app's content never renders
// until the visitor has confirmed; the answer is read synchronously from
// localStorage before first paint so nothing flashes behind the gate.

const ACKNOWLEDGEMENT_KEY = 'ageAcknowledged'

type AgeGateStatus = 'pending' | 'accepted' | 'declined'

type AgeGateEvent =
  | { type: 'AGE_CONFIRMED' }
  | { type: 'AGE_DECLINED' }
  | { type: 'NOTICE_REOPENED' }

const ageGateReducer = (_state: AgeGateStatus, event: AgeGateEvent): AgeGateStatus => {
  switch (event.type) {
    case 'AGE_CONFIRMED':
      return 'accepted'
    case 'AGE_DECLINED':
      return 'declined'
    case 'NOTICE_REOPENED':
      return 'pending'
  }
}

const readAcknowledgement = (): boolean => {
  try {
    return window.localStorage.getItem(ACKNOWLEDGEMENT_KEY) === 'true'
  } catch {
    return false
  }
}

const storeAcknowledgement = (): void => {
  try {
    window.localStorage.setItem(ACKNOWLEDGEMENT_KEY, 'true')
  } catch (error) {
    console.error('Error saving age acknowledgement to localStorage:', error)
  }
}

type AgeGateProps = {
  children: ReactNode
}

export const AgeGate = ({ children }: AgeGateProps) => {
  const [status, dispatch] = useReducer(
    ageGateReducer,
    undefined,
    (): AgeGateStatus => (readAcknowledgement() ? 'accepted' : 'pending')
  )
  const dialogRef = useRef<HTMLDialogElement>(null)

  // The native dialog is opened modally so focus is trapped and the page
  // behind is inert; the guard keeps StrictMode's double-run harmless
  useEffect(() => {
    if (status === 'pending' && dialogRef.current && !dialogRef.current.open) {
      dialogRef.current.showModal()
    }
  }, [status])

  if (status === 'accepted') {
    return <>{children}</>
  }

  if (status === 'declined') {
    return (
      <main className="age-declined">
        <h2>InstaScript</h2>
        <p>
          InstaScript creates adult content and is available only to people
          aged 18 or over.
        </p>
        <p>Nothing has been shown or stored in this browser.</p>
        <button
          type="button"
          onClick={() => dispatch({ type: 'NOTICE_REOPENED' })}
        >
          Show the notice again
        </button>
      </main>
    )
  }

  const handleConfirm = () => {
    storeAcknowledgement()
    dialogRef.current?.close()
    dispatch({ type: 'AGE_CONFIRMED' })
  }

  const handleDecline = () => {
    dialogRef.current?.close()
    dispatch({ type: 'AGE_DECLINED' })
  }

  return (
    <dialog
      ref={dialogRef}
      className="age-gate"
      aria-labelledby="age-gate-title"
      aria-describedby="age-gate-description"
      onCancel={(event) => event.preventDefault()}
    >
      <header>
        <h2 id="age-gate-title">Before you continue</h2>
      </header>
      <section id="age-gate-description">
        <p>
          InstaScript generates erotic hypnosis scripts. It is an adult app,
          intended only for people aged 18 or over.
        </p>
        <p>
          Please confirm that you are 18 or older and want to see this kind of
          content.
        </p>
      </section>
      <footer>
        <button type="button" onClick={handleDecline}>
          I am under 18
        </button>
        <button type="button" onClick={handleConfirm}>
          I am 18 or older — continue
        </button>
      </footer>
    </dialog>
  )
}

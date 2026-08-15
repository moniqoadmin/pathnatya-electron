import { Component, type ErrorInfo, type ReactNode } from 'react'
import { reportAppLog } from '../api/logs'
import { userError } from '../lib/user-error'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  errorMessage: string | null
}

/**
 * Catches render/lifecycle crashes so users get a reload path instead of a
 * blank window. Reports once per mount via the existing app-log channel.
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    errorMessage: null
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    const raw =
      error instanceof Error && error.message.trim()
        ? error.message
        : 'Something went wrong while showing this screen.'
    return {
      errorMessage: userError(5001, raw)
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Renderer crash:', error, info.componentStack)
    reportAppLog('RENDER_CRASH', true)
  }

  private handleReload = (): void => {
    window.location.reload()
  }

  render(): ReactNode {
    if (!this.state.errorMessage) {
      return this.props.children
    }

    return (
      <div className="page">
        <header className="page-header">
          <p className="sanskrit-header">Jay Yogeshwar</p>
          <h1>Pathnatya 2026</h1>
          <p className="page-subtitle">The app hit an unexpected error</p>
        </header>
        <section className="card">
          <p className="form-error" role="alert">
            {this.state.errorMessage}
          </p>
          <p className="page-subtitle" style={{ marginTop: 12, marginBottom: 20 }}>
            Reload the app to continue. If this keeps happening, contact admin with the error
            code above.
          </p>
          <button type="button" className="btn btn-primary" onClick={this.handleReload}>
            Reload
          </button>
        </section>
      </div>
    )
  }
}

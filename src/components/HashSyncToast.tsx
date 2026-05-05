import './HashSyncToast.css';

type HashSyncStatus = 'checking' | 'downloading' | 'success' | 'error';

interface HashSyncToastProps {
  status: HashSyncStatus;
  message: string;
  onDismiss: () => void;
}

export default function HashSyncToast({ status, message, onDismiss }: HashSyncToastProps) {
  const isBusy = status === 'checking' || status === 'downloading';
  const title =
    status === 'success'
      ? 'Hash Update Complete'
      : status === 'error'
        ? 'Hash Update Failed'
        : 'Hash Update';

  return (
    <div className={`hash-sync-toast ${status}`}>
      <div className="hash-sync-toast-body">
        <div className="hash-sync-toast-title">{title}</div>
        <div className="hash-sync-toast-sub">{message}</div>
      </div>
      <button className="hash-sync-toast-close" onClick={onDismiss} title="Dismiss">
        &times;
      </button>
      {/* Bottom-edge indeterminate bar — visually matches the BIN-loading
          toast: status-bar-bg track, translucent-white fill, white shimmer
          streak that sweeps left-to-right. Terminal states (success /
          error) render a solid coloured fill instead. */}
      <div className={`hash-sync-toast-progress ${isBusy ? 'busy' : status}`} aria-hidden="true">
        {isBusy && <div className="hash-sync-toast-progress-fill" />}
      </div>
    </div>
  );
}

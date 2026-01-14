import './EditShelf.css';

interface EditShelfProps {
    findActive: boolean;
    replaceActive: boolean;
    onFind: () => void;
    onReplace: () => void;
}

export default function EditShelf({
    findActive,
    replaceActive,
    onFind,
    onReplace
}: EditShelfProps) {
    return (
        <div className="edit-shelf">
            {/* We align to right to match the Monaco Find Widget position usually on the right side */}
            <button
                className={`edit-shelf-btn ${findActive ? 'active' : ''}`}
                title="Find (Ctrl+F)"
                onClick={onFind}
            >
                🔍
            </button>
            <button
                className={`edit-shelf-btn ${replaceActive ? 'active' : ''}`}
                title="Replace (Ctrl+H)"
                onClick={onReplace}
            >
                🔁
            </button>
        </div>
    );
}

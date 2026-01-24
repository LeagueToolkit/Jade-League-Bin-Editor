# Jade

[![Rust](https://img.shields.io/badge/Rust-1.70+-orange?style=for-the-badge&logo=rust)](https://www.rust-lang.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?style=for-the-badge&logo=typescript)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-7.0-646CFF?style=for-the-badge&logo=vite)](https://vitejs.dev/)
[![Tauri](https://img.shields.io/badge/Tauri-2.0-24C8D8?style=for-the-badge&logo=tauri)](https://tauri.app/)
[![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](LICENSE.md)

A fast, modern bin file editor for League of Legends modding. Built with Rust and Tauri for native performance.

## Features

- Native Ritobin parser written in Rust
- Monaco editor with custom syntax highlighting
- Hash file management with auto-download from CommunityDragon
- Theme customization with built-in and custom themes
- Linked bin file importing
- Tab-based editing with multiple files
- Window state and preferences persistence

## Requirements

- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://rustup.rs/) (stable)
- [pnpm](https://pnpm.io/) or npm

## Installation

```bash
# Clone the repository
git clone https://github.com/RitoShark/Jade-League-Bin-Editor.git
cd Jade-League-Bin-Editor

# Switch to the jade-rust branch
git checkout jade-rust

# Install dependencies
npm install

# Run in development mode
npm run tauri dev

# Build for production
npm run tauri build
```

## Project Structure

```
├── src/                    # React frontend
│   ├── components/         # UI components
│   └── lib/                # Utilities and parsers
├── src-tauri/              # Rust backend
│   └── src/
│       ├── ritobin/        # Native bin parser
│       ├── bin_commands.rs # File operations
│       ├── hash_commands.rs# Hash management
│       └── app_commands.rs # App preferences
```

## Keyboard Shortcuts

### File
- **Ctrl+O** - Open file (when on welcome screen) / Toggle General Editing panel (when file is open)
- **Ctrl+S** - Save file
- **Ctrl+Shift+S** - Save As...

### Edit
- **Ctrl+Z** - Undo
- **Ctrl+Y** - Redo
- **Ctrl+X** - Cut
- **Ctrl+C** - Copy
- **Ctrl+V** - Paste
- **Ctrl+A** - Select All
- **Ctrl+F** - Find
- **Ctrl+H** - Replace
- **Ctrl+D** - Compare Files

### Tools
- **Ctrl+P** - Toggle Particle Editing panel (bin files only)
- **Ctrl+Shift+P** - Toggle Particle Editor dialog (bin files only)

### Navigation
- **Ctrl+W** - Close current tab
- **Ctrl+Tab** - Switch to next tab
- **Ctrl+Shift+Tab** - Switch to previous tab
- **Escape** - Close all panels/dialogs

## Configuration

Hash files are stored in `%APPDATA%\RitoShark\Jade\hashes` and can be downloaded automatically through the Settings dialog.

## License

See [LICENSE.md](LICENSE.md) for details.

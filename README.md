# Jade

![Rust](https://img.shields.io/badge/Rust-000000?style=flat&logo=rust&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-61DAFB?style=flat&logo=react&logoColor=black)
![Tauri](https://img.shields.io/badge/Tauri-24C8D8?style=flat&logo=tauri&logoColor=white)

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

## Configuration

Hash files are stored in `%APPDATA%\RitoShark\Jade\hashes` and can be downloaded automatically through the Settings dialog.

## License

See [LICENSE.md](LICENSE.md) for details.

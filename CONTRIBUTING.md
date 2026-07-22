# Contributing to Look

Thank you for considering contributing to Look! This document outlines the guidelines for contributing.

## Code of Conduct

Please be respectful and constructive in all interactions. We strive to maintain a welcoming community.

## How to Contribute

### Reporting Bugs

1. Check if the bug has already been reported in [Issues](https://github.com/Jacky-li-li-li/Look/issues)
2. If not, create a new issue with:
   - A clear, descriptive title
   - Steps to reproduce the issue
   - Expected vs actual behavior
   - Screenshots if applicable
   - Environment details (OS, Node.js version, Look version)

### Suggesting Features

1. Open a [Feature Request](https://github.com/Jacky-li-li-li/Look/issues/new) issue
2. Describe the feature and the problem it solves
3. Provide examples of how it would work

### Pull Requests

1. **Fork** the repository and create your branch from `main`
2. **Set up locally**:
   ```bash
   git clone https://github.com/your-username/Look.git
   cd Look
   npm install
   ```
3. **Make your changes** following the project's coding conventions
4. **Run tests** to ensure nothing is broken:
   ```bash
   npm test
   ```
5. **Run lint and type checking**:
   ```bash
   npm run check
   ```
6. **Format your code**:
   ```bash
   npm run format
   ```
7. **Commit** using clear, concise commit messages (see style below)
8. **Push** to your fork and submit a Pull Request

## Commit Message Style

- Use the present tense ("Add feature" not "Added feature")
- Use the imperative mood ("Move cursor to..." not "Moves cursor to...")
- Limit the first line to 72 characters or less
- Reference issues and pull requests after the first line

Examples:
```
feat(session): add session persistence for unsent drafts
fix(renderer): correct message bubble alignment in dark mode
chore(deps): update pi-sdk to 0.80.10
docs(readme): add troubleshooting section for M1 macs
```

## Development Setup

Run commands from the repository root. The root npm scripts coordinate the `@look/electron` and `@look/shared` workspaces.

```bash
# Install dependencies
npm install

# Start development mode
npm run dev

# Run tests
npm test

# Build for production
npm run build

# Package for distribution
npm run package
```

## Project Structure

```
apps/
└── electron/
    ├── src/main/      # Electron main process (TypeScript, Node.js)
    ├── src/renderer/  # React renderer process (TypeScript, Vite)
    ├── test/          # Application tests
    ├── scripts/       # Build and packaging helpers
    └── tools/         # Application asset-generation utilities
packages/
└── shared/            # Shared types, utilities and UI components
```

## Asset Generation

The Open Peeps avatar generator is isolated at `apps/electron/tools/open-peeps-avatars/` so its design-time dependencies do not affect the application workspace. Its ignored `output/` directory contains generated candidates and previews; review and copy only the intended SVG assets into `apps/electron/src/renderer/assets/ai-avatars/`.

```bash
cd apps/electron/tools/open-peeps-avatars
npm ci
npm run generate
```

## Code Conventions

- **TypeScript**: Strict mode, avoid `any` — use `unknown` or precise types
- **Formatting**: Biome with tabs (indent: 3), 120-char line width
- **Styling**: Tailwind CSS v4 + shadcn/ui Radix Nova style
- **Testing**: Vitest with per-file isolated LOOK_HOME
- **IPC**: All main↔renderer communication goes through the preload bridge

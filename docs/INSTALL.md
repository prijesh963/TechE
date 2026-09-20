# Copilot Architect

A VS Code extension that grounds Copilot in what is actually in your
repository, and holds a feature from analysis through to review without you
re-explaining the codebase at every step.

Everything runs on your machine. No service, no account, no code leaves the
editor except what Copilot itself sends.

---

## Install

You need **VS Code 1.90 or newer** and the **GitHub Copilot** extension
installed and signed in. You do not need Node.js, npm, or a clone of this
repository — the extension carries its own runtime.

**Get the `.vsix`**

From the repository's [Releases](../../releases) page — the newest release
carries `copilot-architect-<version>.vsix` as a download. A release is built
from `main` on every push, so the latest one matches the latest code.

The file is not in the repository itself. It is a build output, ignored the
same way `dist/` is, so downloading the source as a ZIP will not contain one.
To build your own you need the clone and toolchain this section says you can
do without:

```bash
npm install
npm run package:vsix      # → dist-vsix/copilot-architect-<version>.vsix
```

**From the VS Code UI**

1. Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`).
2. `...` menu at the top of the view → **Install from VSIX…**
3. Pick `copilot-architect-<version>.vsix`.
4. Reload when prompted.

**From a terminal**

```bash
code --install-extension copilot-architect-<version>.vsix
```

To confirm it is live: open Copilot Chat and type `@architect`. If the
participant does not appear, see _If it does not activate_ below.

**Check which build you have.** The Copilot Architect panel shows a **Build**
number, and every answer's receipts line ends with the same one. It rises with
every commit, so after installing a new `.vsix` you can confirm the extension
running is the one you just built — not the previous one.

---

## Use

Open Copilot Chat and work through the four phases in order. The session
holds the feature and your decisions until you end it explicitly.

| Command        | What it does                                                         |
| -------------- | -------------------------------------------------------------------- |
| `/analyze`     | Explains what is in the repo, grounded in a real index of the files. |
| `/create-plan` | Turns the request into a plan you can read, correct, and approve.    |
| `/implement`   | Applies the approved plan and nothing beyond it.                     |
| `/review`      | Compares what was built against what was approved.                   |

A prompt with no slash command is treated as `/analyze`.

Two steps are buttons rather than phrases: **Approve Plan** and **End
Session**. Authorizing code to be written must not depend on a model reading
approval out of "looks good to me".

Every answer ends with what it was based on — the files it read, and anything
it could not verify against the index.

The first `/analyze` in a workspace builds the index. After that it refreshes
itself when files change, so answers do not come from a stale snapshot.

---

## If it does not activate

**"Disabled by policy", or the extension does not appear.** Your
organization restricts which extensions may run. Ask whoever administers VS
Code policy to allow the publisher, or use the CLI instead — everything the
extension does is available as commands from the repository clone.

**`@architect` is missing from Copilot Chat.** Copilot Chat must be installed
and signed in first; the chat participant is contributed to it. Reload the
window after signing in.

**A command fails with a spawn error.** Report it with the output from
**View → Output → Copilot Architect**, which shows the exact command line
that ran.

---

## Uninstall

Extensions view → Copilot Architect → **Uninstall**.

Artifacts stay in `.copilot-architect/` inside each workspace. Delete that
folder to remove the index, plans and session state.

import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  TextDocumentEdit,
  TextEdit,
  Range,
  Position,
  OptionalVersionedTextDocumentIdentifier,
  CreateFile,
  CodeActionKind,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import * as fs from "fs/promises";
import { pathToFileURL } from "url";
import { FileStateManager } from "./file-state";
import {
  isSopsEncrypted,
  isDecryptedFile,
  getDecryptedPath,
  getEncryptedPath,
  detectFileType,
} from "./sops-detector";
import { SopsRunner } from "./sops-runner";
import { FileState, SopsFileType } from "./types";

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const stateManager = new FileStateManager();

const OPEN_COMMAND = "sops.openDecrypted";

let sopsRunner: SopsRunner;

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const opts = (params.initializationOptions as Record<string, unknown>) || {};

  sopsRunner = new SopsRunner({
    sopsPath: (opts.sopsPath as string) || "sops",
    env: (opts.env as Record<string, string>) || {},
  });

  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: TextDocumentSyncKind.Full,
        save: { includeText: true },
      },
      codeActionProvider: { codeActionKinds: [CodeActionKind.Empty] },
      executeCommandProvider: { commands: [OPEN_COMMAND] },
    },
  };
});

connection.onInitialized(async () => {
  try {
    const version = await sopsRunner.verify();
    connection.console.log(`SOPS LSP initialized (sops ${version})`);
  } catch {
    connection.window.showWarningMessage(
      "SOPS binary not found. Install sops and ensure it is on PATH, or set sopsPath in settings."
    );
  }
});

function uriToFilePath(uri: string): string {
  if (uri.startsWith("file://")) {
    return decodeURIComponent(uri.slice(7));
  }
  return uri;
}

function filePathToUri(filePath: string): string {
  return pathToFileURL(filePath).toString();
}

/**
 * On file open: detect SOPS encryption and create a .decrypted~ sidecar file.
 *
 * If the opened file is a .decrypted~ sidecar, register it as managed.
 * If the opened file is encrypted, decrypt and create the sidecar.
 */
documents.onDidOpen(async (event) => {
  const { document } = event;
  const uri = document.uri;
  const filePath = uriToFilePath(uri);

  // Case 1: User opened a .decrypted~ sidecar file (after we created it, or manually)
  if (isDecryptedFile(filePath)) {
    // Already tracked? Skip.
    if (stateManager.get(uri)) return;

    // Register this sidecar — look up the companion encrypted file
    const encryptedFilePath = getEncryptedPath(filePath);
    try {
      const encryptedContent = await fs.readFile(encryptedFilePath, "utf-8");
      const fileType = detectFileType(encryptedFilePath);

      if (!isSopsEncrypted(encryptedContent, fileType)) {
        return; // Companion isn't encrypted, not our business
      }

      stateManager.init(uri, encryptedFilePath, encryptedContent, filePath, fileType);
      connection.console.log(`SOPS: Registered sidecar ${filePath}`);
    } catch {
      // Companion file doesn't exist or can't be read — ignore
    }
    return;
  }

  // Case 2: User opened an encrypted file — create a .decrypted~ sidecar
  const content = document.getText();
  const fileType = detectFileType(uri);

  if (!isSopsEncrypted(content, fileType)) {
    return;
  }

  await openSidecar(filePath, content, fileType);
});

/**
 * Decrypt an encrypted file into its .decrypted~ sidecar and open it.
 * If the sidecar is already open, just bring it to the front.
 */
async function openSidecar(
  filePath: string,
  content: string,
  fileType: SopsFileType
): Promise<void> {
  const decryptedFilePath = getDecryptedPath(filePath);
  const decryptedUri = filePathToUri(decryptedFilePath);

  try {
    let decryptedContent: string;
    const existing = stateManager.get(decryptedUri);
    if (existing) {
      // Zed may not have sent didClose for the previous tab yet; it must not delete the file we reopen now.
      existing.reopenedAt = Date.now();
      decryptedContent = await sopsRunner.decrypt(filePath, fileType);
      await fs.writeFile(decryptedFilePath, decryptedContent, "utf-8");
    } else {
      decryptedContent = await sopsRunner.decrypt(filePath, fileType);

      await fs.writeFile(decryptedFilePath, decryptedContent, "utf-8");
      stateManager.init(decryptedUri, filePath, content, decryptedFilePath, fileType);
    }

    // Open the sidecar in Zed via workspace/applyEdit (CreateFile + TextDocumentEdit)
    const opened = await openDecryptedFile(decryptedUri, decryptedFilePath, decryptedContent);

    if (opened) {
      connection.console.log(`SOPS: Created and opened sidecar ${decryptedFilePath}`);
    } else {
      connection.console.warn(`SOPS: Created sidecar but could not auto-open`);
      connection.window.showInformationMessage(
        `SOPS: Decrypted to ${decryptedFilePath} — open it to edit.`
      );
    }
  } catch (error: unknown) {
    // Clean up sidecar on failure
    await fs.unlink(decryptedFilePath).catch(() => {});
    stateManager.remove(decryptedUri);
    const msg = error instanceof Error ? error.message : String(error);
    connection.window.showErrorMessage(`SOPS decrypt failed: ${msg}`);
  }
}

connection.onCodeAction((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document || isDecryptedFile(uriToFilePath(document.uri))) return [];
  if (!isSopsEncrypted(document.getText(), detectFileType(document.uri))) return [];
  return [
    {
      title: "SOPS: Open decrypted file",
      kind: CodeActionKind.Empty,
      command: { title: "SOPS: Open decrypted file", command: OPEN_COMMAND, arguments: [document.uri] },
    },
  ];
});

connection.onExecuteCommand(async (params) => {
  if (params.command !== OPEN_COMMAND) return;
  const document = documents.get(params.arguments?.[0] as string);
  if (!document) return;
  await openSidecar(uriToFilePath(document.uri), document.getText(), detectFileType(document.uri));
});

/**
 * On save of a .decrypted~ sidecar: re-encrypt the original file.
 */
documents.onDidSave(async (event) => {
  const { document } = event;
  const uri = document.uri;
  const ctx = stateManager.get(uri);

  if (!ctx) return;
  if (ctx.state === FileState.ENCRYPTING) return;

  stateManager.transition(uri, FileState.ENCRYPTING);

  try {
    // Read the plaintext the user just saved
    const newPlaintext = await fs.readFile(ctx.decryptedFilePath, "utf-8");

    // Restore encrypted content to the original file so sops can re-encrypt
    await fs.writeFile(ctx.encryptedFilePath, ctx.encryptedContent, "utf-8");

    // Re-encrypt using the EDITOR trick (preserves keys & metadata)
    await sopsRunner.reEncrypt(ctx.encryptedFilePath, newPlaintext, ctx.fileType);

    // Update stored encrypted content
    const newEncrypted = await fs.readFile(ctx.encryptedFilePath, "utf-8");
    stateManager.updateEncryptedContent(uri, newEncrypted);
    stateManager.transition(uri, FileState.DECRYPTED);

    connection.console.log(`SOPS: Re-encrypted ${ctx.encryptedFilePath}`);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    connection.console.error(`SOPS: Re-encryption failed: ${msg}`);
    connection.window.showErrorMessage(`SOPS re-encryption failed: ${msg}`);
    stateManager.transition(uri, FileState.DECRYPTED);
  }
});

/**
 * On close of a .decrypted~ sidecar: delete it from disk.
 */
documents.onDidClose(async (event) => {
  const uri = event.document.uri;
  const ctx = stateManager.get(uri);

  if (!ctx) return;
  if (ctx.reopenedAt && Date.now() - ctx.reopenedAt < 5000) return; // late didClose of the previous tab

  // Delete the sidecar file (plaintext cleanup)
  await fs.unlink(ctx.decryptedFilePath).catch(() => {});
  connection.console.log(`SOPS: Deleted sidecar ${ctx.decryptedFilePath}`);

  stateManager.remove(uri);
});

/**
 * Open a .decrypted~ sidecar file in Zed via workspace/applyEdit.
 *
 * Uses CreateFile + TextDocumentEdit which causes Zed to create the file
 * and open it as a new tab.
 */
async function openDecryptedFile(
  decryptedUri: string,
  decryptedFilePath: string,
  content: string
): Promise<boolean> {
  try {
    // Read what's on disk to compute the edit range
    const existingContent = await fs.readFile(decryptedFilePath, "utf-8");
    const lines = existingContent.split("\n");
    const lastLine = lines.length - 1;
    const lastChar = lines[lastLine].length;

    const result = await connection.workspace.applyEdit({
      documentChanges: [
        CreateFile.create(decryptedUri, { ignoreIfExists: true }),
        TextDocumentEdit.create(
          OptionalVersionedTextDocumentIdentifier.create(decryptedUri, null),
          [
            TextEdit.replace(
              Range.create(Position.create(0, 0), Position.create(lastLine, lastChar)),
              content
            ),
          ]
        ),
      ],
    });

    if (result.applied) {
      // Best effort: bring the tab to the front (applyEdit leaves it in the background).
      const shown = await connection.window
        .showDocument({ uri: decryptedUri, takeFocus: true })
        .catch(() => ({ success: false }));
      connection.console.log(`SOPS: showDocument success=${shown.success}`);
    }
    return result.applied;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    connection.console.error(`SOPS: Failed to open sidecar via applyEdit: ${msg}`);
    return false;
  }
}

documents.listen(connection);
connection.listen();

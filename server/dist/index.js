"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const node_1 = require("vscode-languageserver/node");
const vscode_languageserver_textdocument_1 = require("vscode-languageserver-textdocument");
const fs = __importStar(require("fs/promises"));
const url_1 = require("url");
const file_state_1 = require("./file-state");
const sops_detector_1 = require("./sops-detector");
const sops_runner_1 = require("./sops-runner");
const types_1 = require("./types");
process.on("uncaughtException", (error) => {
    console.error("Uncaught Exception:", error);
    process.exit(1);
});
process.on("unhandledRejection", (reason) => {
    console.error("Unhandled Rejection:", reason);
});
const connection = (0, node_1.createConnection)(node_1.ProposedFeatures.all);
const documents = new node_1.TextDocuments(vscode_languageserver_textdocument_1.TextDocument);
const stateManager = new file_state_1.FileStateManager();
const OPEN_COMMAND = "sops.openDecrypted";
let sopsRunner;
connection.onInitialize((params) => {
    const opts = params.initializationOptions || {};
    sopsRunner = new sops_runner_1.SopsRunner({
        sopsPath: opts.sopsPath || "sops",
        env: opts.env || {},
    });
    return {
        capabilities: {
            textDocumentSync: {
                openClose: true,
                change: node_1.TextDocumentSyncKind.Full,
                save: { includeText: true },
            },
            codeActionProvider: { codeActionKinds: [node_1.CodeActionKind.Empty] },
            executeCommandProvider: { commands: [OPEN_COMMAND] },
        },
    };
});
connection.onInitialized(async () => {
    try {
        const version = await sopsRunner.verify();
        connection.console.log(`SOPS LSP initialized (sops ${version})`);
    }
    catch {
        connection.window.showWarningMessage("SOPS binary not found. Install sops and ensure it is on PATH, or set sopsPath in settings.");
    }
});
function uriToFilePath(uri) {
    if (uri.startsWith("file://")) {
        return decodeURIComponent(uri.slice(7));
    }
    return uri;
}
function filePathToUri(filePath) {
    return (0, url_1.pathToFileURL)(filePath).toString();
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
    if ((0, sops_detector_1.isDecryptedFile)(filePath)) {
        // Already tracked? Skip.
        if (stateManager.get(uri))
            return;
        // Register this sidecar — look up the companion encrypted file
        const encryptedFilePath = (0, sops_detector_1.getEncryptedPath)(filePath);
        try {
            const encryptedContent = await fs.readFile(encryptedFilePath, "utf-8");
            const fileType = (0, sops_detector_1.detectFileType)(encryptedFilePath);
            if (!(0, sops_detector_1.isSopsEncrypted)(encryptedContent, fileType)) {
                return; // Companion isn't encrypted, not our business
            }
            stateManager.init(uri, encryptedFilePath, encryptedContent, filePath, fileType);
            connection.console.log(`SOPS: Registered sidecar ${filePath}`);
        }
        catch {
            // Companion file doesn't exist or can't be read — ignore
        }
        return;
    }
    // Case 2: User opened an encrypted file — create a .decrypted~ sidecar
    const content = document.getText();
    const fileType = (0, sops_detector_1.detectFileType)(uri);
    if (!(0, sops_detector_1.isSopsEncrypted)(content, fileType)) {
        return;
    }
    await openSidecar(filePath, content, fileType);
});
/**
 * Decrypt an encrypted file into its .decrypted~ sidecar and open it.
 * If the sidecar is already open, just bring it to the front.
 */
async function openSidecar(filePath, content, fileType) {
    const decryptedFilePath = (0, sops_detector_1.getDecryptedPath)(filePath);
    const decryptedUri = filePathToUri(decryptedFilePath);
    try {
        let decryptedContent;
        const existing = stateManager.get(decryptedUri);
        if (existing) {
            // Zed may not have sent didClose for the previous tab yet; it must not delete the file we reopen now.
            existing.reopenedAt = Date.now();
            decryptedContent = await sopsRunner.decrypt(filePath, fileType);
            await fs.writeFile(decryptedFilePath, decryptedContent, "utf-8");
        }
        else {
            decryptedContent = await sopsRunner.decrypt(filePath, fileType);
            await fs.writeFile(decryptedFilePath, decryptedContent, "utf-8");
            stateManager.init(decryptedUri, filePath, content, decryptedFilePath, fileType);
        }
        // Open the sidecar in Zed via workspace/applyEdit (CreateFile + TextDocumentEdit)
        const opened = await openDecryptedFile(decryptedUri, decryptedFilePath, decryptedContent);
        if (opened) {
            connection.console.log(`SOPS: Created and opened sidecar ${decryptedFilePath}`);
        }
        else {
            connection.console.warn(`SOPS: Created sidecar but could not auto-open`);
            connection.window.showInformationMessage(`SOPS: Decrypted to ${decryptedFilePath} — open it to edit.`);
        }
    }
    catch (error) {
        // Clean up sidecar on failure
        await fs.unlink(decryptedFilePath).catch(() => { });
        stateManager.remove(decryptedUri);
        const msg = error instanceof Error ? error.message : String(error);
        connection.window.showErrorMessage(`SOPS decrypt failed: ${msg}`);
    }
}
connection.onCodeAction((params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document || (0, sops_detector_1.isDecryptedFile)(uriToFilePath(document.uri)))
        return [];
    if (!(0, sops_detector_1.isSopsEncrypted)(document.getText(), (0, sops_detector_1.detectFileType)(document.uri)))
        return [];
    return [
        {
            title: "SOPS: Open decrypted file",
            kind: node_1.CodeActionKind.Empty,
            command: { title: "SOPS: Open decrypted file", command: OPEN_COMMAND, arguments: [document.uri] },
        },
    ];
});
connection.onExecuteCommand(async (params) => {
    if (params.command !== OPEN_COMMAND)
        return;
    const document = documents.get(params.arguments?.[0]);
    if (!document)
        return;
    await openSidecar(uriToFilePath(document.uri), document.getText(), (0, sops_detector_1.detectFileType)(document.uri));
});
/**
 * On save of a .decrypted~ sidecar: re-encrypt the original file.
 */
documents.onDidSave(async (event) => {
    const { document } = event;
    const uri = document.uri;
    const ctx = stateManager.get(uri);
    if (!ctx)
        return;
    if (ctx.state === types_1.FileState.ENCRYPTING)
        return;
    stateManager.transition(uri, types_1.FileState.ENCRYPTING);
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
        stateManager.transition(uri, types_1.FileState.DECRYPTED);
        connection.console.log(`SOPS: Re-encrypted ${ctx.encryptedFilePath}`);
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        connection.console.error(`SOPS: Re-encryption failed: ${msg}`);
        connection.window.showErrorMessage(`SOPS re-encryption failed: ${msg}`);
        stateManager.transition(uri, types_1.FileState.DECRYPTED);
    }
});
/**
 * On close of a .decrypted~ sidecar: delete it from disk.
 */
documents.onDidClose(async (event) => {
    const uri = event.document.uri;
    const ctx = stateManager.get(uri);
    if (!ctx)
        return;
    if (ctx.reopenedAt && Date.now() - ctx.reopenedAt < 5000)
        return; // late didClose of the previous tab
    // Delete the sidecar file (plaintext cleanup)
    await fs.unlink(ctx.decryptedFilePath).catch(() => { });
    connection.console.log(`SOPS: Deleted sidecar ${ctx.decryptedFilePath}`);
    stateManager.remove(uri);
});
/**
 * Open a .decrypted~ sidecar file in Zed via workspace/applyEdit.
 *
 * Uses CreateFile + TextDocumentEdit which causes Zed to create the file
 * and open it as a new tab.
 */
async function openDecryptedFile(decryptedUri, decryptedFilePath, content) {
    try {
        // Read what's on disk to compute the edit range
        const existingContent = await fs.readFile(decryptedFilePath, "utf-8");
        const lines = existingContent.split("\n");
        const lastLine = lines.length - 1;
        const lastChar = lines[lastLine].length;
        const result = await connection.workspace.applyEdit({
            documentChanges: [
                node_1.CreateFile.create(decryptedUri, { ignoreIfExists: true }),
                node_1.TextDocumentEdit.create(node_1.OptionalVersionedTextDocumentIdentifier.create(decryptedUri, null), [
                    node_1.TextEdit.replace(node_1.Range.create(node_1.Position.create(0, 0), node_1.Position.create(lastLine, lastChar)), content),
                ]),
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
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        connection.console.error(`SOPS: Failed to open sidecar via applyEdit: ${msg}`);
        return false;
    }
}
documents.listen(connection);
connection.listen();
//# sourceMappingURL=index.js.map
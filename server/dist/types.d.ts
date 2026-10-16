export declare enum FileState {
    /** Sidecar created, user is editing the .decrypted~ file */
    DECRYPTED = "decrypted",
    /** Re-encryption in progress */
    ENCRYPTING = "encrypting"
}
export interface FileContext {
    state: FileState;
    /** Absolute path to the original encrypted file on disk */
    encryptedFilePath: string;
    /** The current encrypted content (used to restore before re-encrypt) */
    encryptedContent: string;
    /** Absolute path to the .decrypted~ sidecar file */
    decryptedFilePath: string;
    /** File type for sops --input-type/--output-type */
    fileType: SopsFileType;
    /** Set when the sidecar was reopened while still tracked */
    reopenedAt?: number;
}
export type SopsFileType = "yaml" | "json" | "ini" | "dotenv" | "binary";
export interface SopsConfig {
    /** Path to the sops binary (default: "sops") */
    sopsPath: string;
    /** Additional environment variables for sops */
    env: Record<string, string>;
}

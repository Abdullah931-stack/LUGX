"use server";

/**
 * Unified File & Folder Operations Facade
 *
 * Implements explicit async function exports delegating to modularized `files.ts`
 * and `folders.ts` to strictly satisfy Next.js Turbopack requirements ("Only async
 * functions are allowed to be exported in a 'use server' file") while guaranteeing
 * 100% backward compatibility for all existing caller modules.
 */

import * as files from "./files";
import * as folders from "./folders";

export async function createFile(...args: Parameters<typeof files.createFile>) {
    return files.createFile(...args);
}

export async function updateFileContent(...args: Parameters<typeof files.updateFileContent>) {
    return files.updateFileContent(...args);
}

export async function toggleFileEncryption(...args: Parameters<typeof files.toggleFileEncryption>) {
    return files.toggleFileEncryption(...args);
}

export async function renameFile(...args: Parameters<typeof files.renameFile>) {
    return files.renameFile(...args);
}

export async function deleteFile(...args: Parameters<typeof files.deleteFile>) {
    return files.deleteFile(...args);
}

export async function restoreFile(...args: Parameters<typeof files.restoreFile>) {
    return files.restoreFile(...args);
}

export async function copyFile(...args: Parameters<typeof files.copyFile>) {
    return files.copyFile(...args);
}

export async function getFile(...args: Parameters<typeof files.getFile>) {
    return files.getFile(...args);
}

export async function getUserFiles(...args: Parameters<typeof files.getUserFiles>) {
    return files.getUserFiles(...args);
}

export async function getRootFiles(...args: Parameters<typeof files.getRootFiles>) {
    return files.getRootFiles(...args);
}

export async function getDeletedFiles(...args: Parameters<typeof files.getDeletedFiles>) {
    return files.getDeletedFiles(...args);
}

export async function moveFile(...args: Parameters<typeof folders.moveFile>) {
    return folders.moveFile(...args);
}

export async function getFolderChildren(...args: Parameters<typeof folders.getFolderChildren>) {
    return folders.getFolderChildren(...args);
}

export async function getDescendantIds(...args: Parameters<typeof folders.getDescendantIds>) {
    return folders.getDescendantIds(...args);
}

export async function isDescendantOf(...args: Parameters<typeof folders.isDescendantOf>) {
    return folders.isDescendantOf(...args);
}

export type { UpdateFileOptions, DeleteFileOptions, FileOpResult } from "./files";

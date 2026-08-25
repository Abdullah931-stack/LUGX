import { createClient } from "./server";

// Storage bucket name for user files
const BUCKET_NAME = "user-files";

/**
 * Asserts that a storage path is safely scoped to the provided userId
 * and contains no path traversal sequences (..).
 */
export function assertSafeStoragePath(userId: string, path: string): string {
    if (!userId || typeof userId !== "string" || !userId.trim()) {
        throw new Error("Invalid userId for storage path assertion");
    }
    if (!path || typeof path !== "string") {
        throw new Error("Invalid storage path provided");
    }
    const clean = path.trim().replace(/\\/g, "/");
    if (clean.includes("..") || clean.startsWith("/")) {
        throw new Error("Invalid storage path: directory traversal or leading slash detected");
    }
    const expectedPrefix = `${userId}/`;
    if (!clean.startsWith(expectedPrefix)) {
        throw new Error(`Storage path isolation violation: path must start with '${expectedPrefix}'`);
    }
    return clean;
}

export async function uploadFile(
    userId: string,
    file: File,
    path?: string
): Promise<{ path: string; url: string } | null> {
    const supabase = await createClient();

    const rawPath = path || `${userId}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const filePath = assertSafeStoragePath(userId, rawPath);

    const { data, error } = await supabase.storage
        .from(BUCKET_NAME)
        .upload(filePath, file, {
            cacheControl: "3600",
            upsert: false,
        });

    if (error) {
        console.error("Error uploading file:", error);
        return null;
    }

    const { data: urlData } = supabase.storage
        .from(BUCKET_NAME)
        .getPublicUrl(data.path);

    return {
        path: data.path,
        url: urlData.publicUrl,
    };
}

export async function deleteFile(userId: string, path: string): Promise<boolean> {
    const supabase = await createClient();
    const safePath = assertSafeStoragePath(userId, path);

    const { error } = await supabase.storage
        .from(BUCKET_NAME)
        .remove([safePath]);

    if (error) {
        console.error("Error deleting file:", error);
        return false;
    }

    return true;
}

export async function getFileUrl(userId: string, path: string): Promise<string | null> {
    const supabase = await createClient();
    const safePath = assertSafeStoragePath(userId, path);

    const { data } = supabase.storage
        .from(BUCKET_NAME)
        .getPublicUrl(safePath);

    return data.publicUrl;
}

export async function downloadFile(userId: string, path: string): Promise<Blob | null> {
    const supabase = await createClient();
    const safePath = assertSafeStoragePath(userId, path);

    const { data, error } = await supabase.storage
        .from(BUCKET_NAME)
        .download(safePath);

    if (error) {
        console.error("Error downloading file:", error);
        return null;
    }

    return data;
}

import { createClient } from "./server";

// Storage bucket name for user files
const BUCKET_NAME = "user-files";

export async function uploadFile(
    userId: string,
    file: File,
    path?: string
): Promise<{ path: string; url: string } | null> {
    const supabase = await createClient();

    const filePath = path || `${userId}/${Date.now()}-${file.name}`;

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

export async function deleteFile(path: string): Promise<boolean> {
    const supabase = await createClient();

    const { error } = await supabase.storage
        .from(BUCKET_NAME)
        .remove([path]);

    if (error) {
        console.error("Error deleting file:", error);
        return false;
    }

    return true;
}

export async function getFileUrl(path: string): Promise<string | null> {
    const supabase = await createClient();

    const { data } = supabase.storage
        .from(BUCKET_NAME)
        .getPublicUrl(path);

    return data.publicUrl;
}

export async function downloadFile(path: string): Promise<Blob | null> {
    const supabase = await createClient();

    const { data, error } = await supabase.storage
        .from(BUCKET_NAME)
        .download(path);

    if (error) {
        console.error("Error downloading file:", error);
        return null;
    }

    return data;
}

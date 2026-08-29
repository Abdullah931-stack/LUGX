/**
 * Build nested file tree structure from flat array
 */
export function buildFileTree<T extends { id: string; parentFolderId?: string | null }>(
    flatFiles: T[]
): (T & { children: unknown[] })[] {
    const fileMap = new Map<string, T & { children: unknown[] }>();
    const rootFiles: (T & { children: unknown[] })[] = [];

    // First pass: create map of all files
    flatFiles.forEach((file) => {
        fileMap.set(file.id, { ...file, children: [] });
    });

    // Second pass: build tree structure
    flatFiles.forEach((file) => {
        const node = fileMap.get(file.id);
        if (!node) return;

        if (file.parentFolderId) {
            // Has parent - add to parent's children
            const parent = fileMap.get(file.parentFolderId);
            if (parent) {
                parent.children.push(node);
            } else {
                // Parent not found - treat as root
                rootFiles.push(node);
            }
        } else {
            // No parent - add to root
            rootFiles.push(node);
        }
    });

    return rootFiles;
}

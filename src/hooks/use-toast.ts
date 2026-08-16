import * as React from "react";

export function useToast() {
    const [toasts, setToasts] = React.useState<any[]>([]);

    const toast = React.useCallback((props: {
        title: string;
        description?: string;
        variant?: "default" | "destructive";
    }) => {
        console.log(`[TOAST] ${props.title}: ${props.description || ''}`);
        // Temporary implementation - will be replaced with proper UI toast
        if (props.variant === "destructive") {
            console.error(`[ERROR] ${props.description}`);
        }
    }, []);

    return { toast, toasts };
}

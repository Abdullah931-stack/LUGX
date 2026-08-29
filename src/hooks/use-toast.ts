import * as React from "react";

export interface ToastProps {
    title: string;
    description?: string;
    variant?: "default" | "destructive";
}

export function useToast() {
    const [toasts] = React.useState<ToastProps[]>([]);

    const toast = React.useCallback((props: ToastProps) => {
        console.log(`[TOAST] ${props.title}: ${props.description || ''}`);
        // Temporary implementation - will be replaced with proper UI toast
        if (props.variant === "destructive") {
            console.error(`[ERROR] ${props.description}`);
        }
    }, []);

    return { toast, toasts };
}

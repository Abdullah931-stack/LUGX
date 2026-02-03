"use client";

/**
 * Sync Status Indicator
 * 
 * A visual indicator showing the current synchronization status.
 * Displays online/offline state, sync progress, and pending changes.
 */

import {
    Cloud,
    CloudOff,
    RefreshCw,
    Check,
    AlertCircle,
    Loader2
} from "lucide-react";
import { SyncStatus, SyncResult } from "@/lib/sync/sync-manager";
import { ConnectionState } from "@/lib/sync/connection-detector";

interface SyncIndicatorProps {
    /** Current sync status (from useSync hook) */
    status?: SyncStatus;
    /** Current connection state (from useSync hook) */
    connectionState?: ConnectionState;
    /** Number of pending files (from useSync hook) */
    pendingCount?: number;
    /** Last sync result (from useSync hook) */
    lastSyncResult?: SyncResult | null;
    /** Callback to trigger manual sync */
    onSyncNow?: () => void;
    /** Show detailed status or compact view */
    compact?: boolean;
    /** Additional CSS classes */
    className?: string;
}

/**
 * Status configuration for visual display
 */
const STATUS_CONFIG: Record<SyncStatus, {
    icon: React.ElementType;
    color: string;
    label: string;
    animate?: boolean;
}> = {
    idle: {
        icon: Check,
        color: "text-green-400",
        label: "متزامن",
    },
    syncing: {
        icon: Loader2,
        color: "text-blue-400",
        label: "جارٍ المزامنة",
        animate: true,
    },
    error: {
        icon: AlertCircle,
        color: "text-red-400",
        label: "خطأ",
    },
    offline: {
        icon: CloudOff,
        color: "text-amber-400",
        label: "غير متصل",
    },
};

export function SyncIndicator({
    status = 'idle',
    connectionState = 'unknown',
    pendingCount = 0,
    onSyncNow,
    compact = false,
    className = ""
}: SyncIndicatorProps) {
    const config = STATUS_CONFIG[status];
    const Icon = config.icon;

    // Handle manual sync trigger
    const handleManualSync = () => {
        if (status !== 'syncing' && connectionState === 'online' && onSyncNow) {
            onSyncNow();
        }
    };

    if (compact) {
        return (
            <button
                onClick={handleManualSync}
                disabled={status === 'syncing' || connectionState !== 'online'}
                className={`p-1.5 rounded-md transition-colors hover:bg-zinc-800 disabled:opacity-50 ${className}`}
                title={config.label}
            >
                <Icon
                    className={`w-4 h-4 ${config.color} ${config.animate ? 'animate-spin' : ''}`}
                />
            </button>
        );
    }

    return (
        <div className={`flex items-center gap-2 ${className}`}>
            {/* Connection Indicator */}
            <div className="flex items-center gap-1.5">
                {connectionState === 'online' ? (
                    <Cloud className="w-4 h-4 text-green-400" />
                ) : (
                    <CloudOff className="w-4 h-4 text-amber-400" />
                )}
            </div>

            {/* Status Badge */}
            <div
                className={`flex items-center gap-1.5 px-2 py-1 rounded-md 
                    bg-zinc-800/50 border border-zinc-700/50`}
            >
                <Icon
                    className={`w-3.5 h-3.5 ${config.color} ${config.animate ? 'animate-spin' : ''}`}
                />
                <span className="text-xs text-zinc-300">
                    {config.label}
                </span>
            </div>

            {/* Pending Changes Badge */}
            {pendingCount > 0 && status !== 'syncing' && (
                <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/30">
                    <span className="text-xs text-amber-300">
                        {pendingCount} معلق
                    </span>
                </div>
            )}

            {/* Manual Sync Button */}
            <button
                onClick={handleManualSync}
                disabled={status === 'syncing' || connectionState !== 'online'}
                className="p-1 rounded hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                title="مزامنة الآن"
            >
                <RefreshCw
                    className={`w-3.5 h-3.5 text-zinc-400 
                        ${status === 'syncing' ? 'animate-spin' : ''}`}
                />
            </button>
        </div>
    );
}
